/**
 * backtest-day.ts — Replay a historical trading day through the signal + analysis pipeline.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-day.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: 2026-03-18, SPY
 *
 * Fetches 1m bars from Alpaca (with 2-day warmup), aggregates to 3m/5m,
 * walks through market hours in 1-minute intervals, and runs the full
 * signal → analysis pipeline at each step. Reports all potential entries
 * and flags bad ones.
 */

import 'dotenv/config';
import { config } from '../config.js';
import { computeDMI } from '../indicators/dmi.js';
import { computeATR } from '../indicators/atr.js';
import { computeOBV } from '../indicators/obv.js';
import { computeTD } from '../indicators/td-sequential.js';
import { detectCandlePattern, detectAllPatterns } from '../indicators/candle-patterns.js';
import { computePriceStructure } from '../indicators/price-structure.js';
import { computeVWAP } from '../indicators/vwap.js';
import { computePriorDayLevels, computeORB } from '../indicators/market-structure.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalPayload, AlignmentType, SignalDirection } from '../types/signal.js';
import type { OptionEvaluation, OptionCandidate } from '../types/options.js';
import type { ConfidenceBreakdown, AnalysisResult } from '../types/analysis.js';
import type { PositionContext, DecisionResult, DecisionType } from '../types/decision.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { v4 as uuidv4 } from 'uuid';
import { DecisionOrchestrator } from '../agents/decision-orchestrator.js';
import type { SimResult } from '../lib/order-agent-sim.js';

// ── Config ────────────────────────────────────────────────────────────────────

const USE_AI = process.argv.includes('--ai');
const TARGET_DATE = process.argv.filter(a => !a.startsWith('--'))[2] || '2026-03-18';
const TICKER = process.argv.filter(a => !a.startsWith('--'))[3] || 'SPY';
const PROFILE = 'S' as const; // Scalp: 1m, 3m, 5m

// ── Per-ticker config (loaded from backtest-configs/<ticker>.ts) ────────────
import { loadBacktestConfig } from './backtest-configs/index.js';
const TCFG = loadBacktestConfig(TICKER);
const MIN_CONFIDENCE = parseFloat(process.env.BT_THRESHOLD ?? '') || TCFG.minConfidence;

// Market hours in UTC (ET + 4 during EDT, ET + 5 during EST)
// March 18 2026 is EDT → 9:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC
const MARKET_OPEN_UTC = '13:30';
const MARKET_CLOSE_UTC = '20:00';

// ── Alpaca REST helpers ───────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string,
  timeframe: Timeframe,
  start: string,
  end: string,
  limit = 10000,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };

  const allBars: OHLCVBar[] = [];
  let pageToken: string | undefined;

  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', String(Math.min(limit, 10000)));
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as AlpacaBarsResponse;
    allBars.push(...normalizeAlpacaBars(data));

    if (data.next_page_token) {
      pageToken = data.next_page_token;
    } else {
      break;
    }
  }

  return allBars;
}

// ── Bar aggregation (from 1m → Nm, same logic as AlpacaStreamManager) ────────

function aggregate1mBars(oneMins: OHLCVBar[], timeframe: Timeframe, upToTs: number): OHLCVBar[] {
  const n = { '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }[timeframe] ?? 1;
  if (n <= 1) return oneMins.filter(b => new Date(b.timestamp).getTime() <= upToTs);

  const bucketMs = n * 60_000;
  // Current bucket at upToTs is still forming — exclude it
  const currentBucket = Math.floor(upToTs / bucketMs) * bucketMs;

  const groups = new Map<number, OHLCVBar[]>();
  for (const bar of oneMins) {
    const ts = new Date(bar.timestamp).getTime();
    if (ts > upToTs) continue; // future bar
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue; // in-progress bucket
    let g = groups.get(bucket);
    if (!g) { g = []; groups.set(bucket, g); }
    g.push(bar);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, bars]) => ({
      timestamp: new Date(bucket).toISOString(),
      open: bars[0]!.open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1]!.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
      vwap: (() => {
        if (!bars.some(b => b.vwap !== undefined)) return undefined;
        const totalVol = bars.reduce((s, b) => s + b.volume, 0);
        if (totalVol === 0) return undefined;
        return bars.reduce((s, b) => s + (b.vwap ?? 0) * b.volume, 0) / totalVol;
      })(),
    }));
}

// ── Indicator computation (same as signal-agent.ts) ──────────────────────────

function computeTimeframeIndicators(
  bars: OHLCVBar[],
  timeframe: Timeframe,
  direction: 'bullish' | 'bearish' | 'neutral' = 'neutral',
): TimeframeIndicators {
  const skipGaps = timeframe !== '1d';
  return {
    timeframe,
    bars,
    dmi: computeDMI(bars, 14, skipGaps),
    atr: computeATR(bars, 14, skipGaps),
    obv: computeOBV(bars, 14),
    td: computeTD(bars),
    vwap: computeVWAP(bars),
    candlePattern: detectCandlePattern(bars),
    allCandlePatterns: detectAllPatterns(bars),
    priceStructure: computePriceStructure(bars, 20, direction),
    currentPrice: bars[bars.length - 1]?.close ?? 0,
  };
}

function classifyAlignment(tfs: TimeframeIndicators[], direction: SignalDirection): AlignmentType {
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) return 'mixed';
  const ltfMatch = ltf.dmi.trend === direction;
  const mtfMatch = mtf.dmi.trend === direction;
  const htfMatch = htf.dmi.trend === direction;
  if (ltfMatch && mtfMatch && htfMatch) return 'all_aligned';
  if (htfMatch && mtfMatch) return 'htf_mtf_aligned';
  if (mtfMatch && ltfMatch) return 'mtf_ltf_aligned';
  return 'mixed';
}

// ── Theta decay simulation ───────────────────────────────────────────────────
// Simulates the theta decay penalty that the live system applies based on option
// expiration proximity. In live trading, 0DTE options are the default choice,
// so the backtest assumes 0DTE expiration on the target date.

function simulateThetaDecay(signalTime: string, targetDate: string): number {
  const now = new Date(signalTime);
  const marketCloseUtc = new Date(`${targetDate}T20:00:00Z`);
  const minutesToClose = (marketCloseUtc.getTime() - now.getTime()) / 60000;

  // 0DTE: same logic as analysis-agent.ts
  if (minutesToClose <= 30) return -0.10;
  if (minutesToClose <= 60) return -0.06;
  if (minutesToClose <= 90) return -0.03;

  return 0;
}

// ── Confidence computation (extracted from analysis-agent.ts) ─────────────────
// We import the full computeConfidence logic inline to avoid needing the full
// AnalysisAgent class + OpenAI dependency.

function computeConfidence(signal: SignalPayload, option: OptionEvaluation): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
  }

  const base = 0.38;

  // DI spread bonus
  const avgDISpread = signal.direction === 'neutral' ? 0
    : tfs.reduce((sum, tf) => {
        const spread = signal.direction === 'bullish'
          ? tf.dmi.plusDI - tf.dmi.minusDI
          : tf.dmi.minusDI - tf.dmi.plusDI;
        return sum + spread;
      }, 0) / tfs.length;
  let diSpreadBonus = Math.max(-0.15, Math.min(0.15, (avgDISpread / 40) * 0.15));

  const adxBonus = htf.dmi.adx > 25 ? 0.05 : (htf.dmi.adx > 20 && htf.dmi.adxSlope > 2 ? 0.03 : 0);

  let diCrossBonus = 0;
  if (signal.direction !== 'neutral') {
    const htfAligned = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
    const htfAdverse = signal.direction === 'bullish' ? htf.dmi.crossedDown : htf.dmi.crossedUp;
    const mtfAligned = signal.direction === 'bullish' ? mtf.dmi.crossedUp : mtf.dmi.crossedDown;
    const mtfAdverse = signal.direction === 'bullish' ? mtf.dmi.crossedDown : mtf.dmi.crossedUp;
    if (htfAligned) diCrossBonus += 0.05;
    if (mtfAligned) diCrossBonus += 0.03;
    if (htfAdverse) diCrossBonus -= 0.05;
    if (mtfAdverse) diCrossBonus -= 0.03;
    const htfGrowth = signal.direction === 'bullish' ? htf.dmi.growthCrossUp : htf.dmi.growthCrossDown;
    if (htfGrowth) diCrossBonus += 0.04;
    if (diCrossBonus > 0 && htf.dmi.adx < 20 && htf.dmi.adxSlope <= 0) { diCrossBonus *= 0.50; }
    // Pattern 5: DI Cross without structure confirmation is unreliable — cap at +0.05
    if (diCrossBonus > 0.05 && htf.dmi.adx < 25) diCrossBonus = 0.05;
    diCrossBonus = Math.max(-0.06, Math.min(0.10, diCrossBonus));
  }

  const alignmentBonusMap: Record<string, number> = { all_aligned: 0.06, htf_mtf_aligned: 0.03, mtf_ltf_aligned: 0.02, mixed: 0 };
  let alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;
  if (signal.reversalOverride && alignmentBonus < 0.06) alignmentBonus = 0.06;

  let tdAdjustment = 0;
  for (const tf of tfs) {
    const setup = tf.td.setup;
    const confirmDir = signal.direction === 'bullish' ? 'buy' : 'sell';
    const opposingDir = signal.direction === 'bullish' ? 'sell' : 'buy';
    if (setup.completed) {
      if (setup.completedDirection === opposingDir) tdAdjustment -= 0.01;
    } else if (setup.direction === confirmDir) {
      if (setup.count >= 7) tdAdjustment += 0.01;
      else if (setup.count >= 5) tdAdjustment += 0.005;
    } else if (setup.direction === opposingDir && setup.count >= 7) {
      tdAdjustment -= 0.005;
    }
  }
  tdAdjustment = Math.max(-0.015, Math.min(0.02, tdAdjustment));

  let obvBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      if (tf.obv.trend === signal.direction) obvBonus += 0.03;
      const badDiv = (signal.direction === 'bullish' && tf.obv.divergence === 'bearish') ||
                     (signal.direction === 'bearish' && tf.obv.divergence === 'bullish');
      if (badDiv) obvBonus -= 0.02;
    }
    obvBonus = Math.max(-0.04, Math.min(0.06, obvBonus));
  }

  let vwapBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      const pvv = tf.vwap.priceVsVwap;
      if (signal.direction === 'bullish') {
        if (pvv > 0) vwapBonus += 0.04;
        else if (pvv < -0.2) vwapBonus -= 0.04;
      } else {
        if (pvv < 0) vwapBonus += 0.04;
        else if (pvv > 0.2) vwapBonus -= 0.04;
      }
    }
    const { vwap: htfVwap, upperBand: htfUpper, lowerBand: htfLower, deviation: htfDev } = htf.vwap;
    const htfPrice = htf.currentPrice;
    const htfAdxStrong = htf.dmi.adx > 35;
    const beyond2sigPenalty = htfAdxStrong ? -0.03 : -0.10;
    if (signal.direction === 'bullish') {
      if (htfPrice > htfUpper) vwapBonus += beyond2sigPenalty;
      else if (htfPrice > htfVwap + htfDev) vwapBonus += -0.02;
    } else {
      if (htfPrice < htfLower) vwapBonus += beyond2sigPenalty;
      else if (htfPrice < htfVwap - htfDev) vwapBonus += -0.02;
    }
    if (vwapBonus > 0 && htf.dmi.diSpreadSlope < -2) vwapBonus = 0;
    vwapBonus = Math.max(-0.12, Math.min(0.10, vwapBonus));
  }

  // OI/Volume bonus — skipped in backtest (no historical option data)
  const oiVolumeBonus = 0;

  // ADX maturity penalty
  let adxMaturityPenalty = 0;
  const htfFreshCross = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
  if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 20) adxMaturityPenalty = -0.15;
  else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 15) adxMaturityPenalty = -0.12;
  else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 10) adxMaturityPenalty = -0.08;
  else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 5) adxMaturityPenalty = -0.04;
  // Pattern 2: High ADX (>= 40) with maturity AND fading momentum = exhaustion trap.
  // Only amplify when ADX slope is negative (trend decelerating) — active trends still valid.
  if (adxMaturityPenalty < 0 && htf.dmi.adx >= 40 && htf.dmi.adxSlope < 0) {
    adxMaturityPenalty *= 1.5;  // e.g. -0.04 → -0.06, -0.08 → -0.12
  } else if (adxMaturityPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) {
    const dirSpread = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI : htf.dmi.minusDI - htf.dmi.plusDI;
    if (dirSpread > 0 && htf.dmi.diSpreadSlope > 0) adxMaturityPenalty *= 0.5;
  }

  // Trend phase bonus
  let trendPhaseBonus = 0;
  if (signal.direction !== 'neutral' && (htf.dmi.adx >= 15 || (htf.dmi.adx >= 10 && htf.dmi.adxSlope > 3))) {
    const htfSlope = htf.dmi.adxSlope;
    const mtfSlope = mtf.dmi.adxSlope;
    if (htfSlope > 2) { trendPhaseBonus += 0.04; if (mtfSlope > 1) trendPhaseBonus += 0.02; }
    else if (htfSlope > 0.5) trendPhaseBonus += 0.02;
    else if (htfSlope < -2) { trendPhaseBonus -= 0.06; if (mtfSlope < -1) trendPhaseBonus -= 0.02; }
    else if (htfSlope < -0.5) trendPhaseBonus -= 0.03;
    trendPhaseBonus = Math.max(-0.08, Math.min(0.06, trendPhaseBonus));
    const htfDirSpread = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI
      : htf.dmi.minusDI - htf.dmi.plusDI;
    if (trendPhaseBonus < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20 && htfDirSpread > 0 && htf.dmi.diSpreadSlope > 0) {
      trendPhaseBonus *= 0.5;
    }
  }

  // Momentum acceleration
  let momentumAccelBonus = 0;
  const isExhaustingTrend = adxMaturityPenalty < 0 && trendPhaseBonus < 0;
  if (signal.direction !== 'neutral') {
    const htfDirSpreadNow = signal.direction === 'bullish'
      ? htf.dmi.plusDI - htf.dmi.minusDI : htf.dmi.minusDI - htf.dmi.plusDI;
    const htfSpreadSlope = htf.dmi.diSpreadSlope;
    if (htfDirSpreadNow > 0 && htfSpreadSlope > 2) {
      momentumAccelBonus += 0.03; if (mtf.dmi.diSpreadSlope > 1) momentumAccelBonus += 0.02;
    } else if (htfDirSpreadNow > 0 && htfSpreadSlope > 0.5) momentumAccelBonus += 0.02;
    else if (htfSpreadSlope < -2) {
      momentumAccelBonus -= 0.04; if (mtf.dmi.diSpreadSlope < -1) momentumAccelBonus -= 0.02;
    } else if (htfSpreadSlope < -0.5) momentumAccelBonus -= 0.02;
    if (isExhaustingTrend && momentumAccelBonus > 0) momentumAccelBonus = 0;
    momentumAccelBonus = Math.max(-0.06, Math.min(0.05, momentumAccelBonus));
  }

  // Price position adjustment
  let pricePositionAdjustment = 0;
  {
    const rp = htf.priceStructure.rangePosition;
    const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
    const extremePenaltyApplies = !strongActiveTrend && htf.dmi.adx >= 15;
    const extremePenalty = (signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) ? -0.06 : -0.12;
    if (signal.direction === 'bullish' && rp > 0.5) {
      if (rp >= 0.85 && extremePenaltyApplies) pricePositionAdjustment = extremePenalty;
      else if (adxMaturityPenalty === 0) pricePositionAdjustment = Math.max(-0.08, -(rp - 0.5) * 0.16);
    } else if (signal.direction === 'bearish' && rp < 0.5) {
      if (rp <= 0.15 && extremePenaltyApplies) pricePositionAdjustment = extremePenalty;
      else if (adxMaturityPenalty === 0) pricePositionAdjustment = Math.max(-0.08, -(0.5 - rp) * 0.16);
    }
    if (pricePositionAdjustment < 0 && pricePositionAdjustment > -0.06 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) pricePositionAdjustment *= 0.5;
  }

  // Structure bonus (prior day levels)
  let structureBonus = 0;
  if (signal.direction !== 'neutral' && signal.priorDayLevels.pdh > 0) {
    const { abovePDH, belowPDL, pdc, priceVsPDH, priceVsPDL } = signal.priorDayLevels;
    const price = signal.currentPrice;
    if (signal.direction === 'bullish') {
      if (abovePDH) structureBonus = priceVsPDH < 0.10 ? 0.02 : 0.06;
      else if (price > pdc) structureBonus = 0.02;
      else if (belowPDL) structureBonus = -0.08;
    } else {
      if (belowPDL) structureBonus = Math.abs(priceVsPDL) < 0.10 ? 0.02 : 0.06;
      else if (price < pdc) structureBonus = 0.02;
      else if (abovePDH) structureBonus = -0.08;
    }
    structureBonus = Math.max(-0.08, Math.min(0.06, structureBonus));
  }

  // ORB bonus
  let orbBonus = 0;
  if (signal.direction !== 'neutral' && signal.orb.orbFormed) {
    const { breakoutDirection, breakoutStrength } = signal.orb;
    if (breakoutDirection === signal.direction) orbBonus = breakoutStrength < 0.25 ? 0.02 : 0.06;
    else if (breakoutDirection !== 'none' && breakoutDirection !== signal.direction) orbBonus = -0.08;
    orbBonus = Math.max(-0.08, Math.min(0.06, orbBonus));
  }

  // Recent price action
  let recentPriceActionBonus = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const bars = ltf.bars;
    if (bars.length >= 4) {
      const recentBars = bars.slice(-3);
      const netMove = recentBars[recentBars.length - 1]!.close - recentBars[0]!.open;
      const bearishBars = recentBars.filter(b => b.close < b.open).length;
      const bullishBars = recentBars.filter(b => b.close > b.open).length;
      const isBullish = signal.direction === 'bullish';
      const netOpposes = isBullish ? netMove < 0 : netMove > 0;
      const opposingBarCount = isBullish ? bearishBars : bullishBars;
      const confirmingBarCount = isBullish ? bullishBars : bearishBars;
      const lastBar = recentBars[recentBars.length - 1]!;
      const lastBarOpposes = isBullish ? lastBar.close < lastBar.open : lastBar.close > lastBar.open;
      const priorBars = recentBars.slice(0, -1);
      const priorConfirming = priorBars.filter(b => isBullish ? b.close > b.open : b.close < b.open).length;

      if (lastBarOpposes && priorConfirming >= 2) recentPriceActionBonus = (signal.alignment === 'all_aligned' || signal.reversalOverride) ? -0.08 : -0.15;
      else if (netOpposes && opposingBarCount >= 3) recentPriceActionBonus = -0.12;
      else if (netOpposes && opposingBarCount >= 2) recentPriceActionBonus = -0.08;
      else if (lastBarOpposes) recentPriceActionBonus = -0.06;
      else if (netOpposes) recentPriceActionBonus = -0.04;
      else if (!netOpposes && confirmingBarCount >= 3 && !lastBarOpposes) recentPriceActionBonus = 0.08;
      else if (!netOpposes && confirmingBarCount >= 2 && !lastBarOpposes) recentPriceActionBonus = 0.04;
      if (recentPriceActionBonus > 0 && htf.dmi.adx >= 15) {
        const rp = htf.priceStructure.rangePosition;
        const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
        const atExtreme = (signal.direction === 'bullish' && rp >= 0.80) || (signal.direction === 'bearish' && rp <= 0.20);
        if (atExtreme && !strongActiveTrend) recentPriceActionBonus = 0;
      }
    }
  }

  // TR contraction penalty
  let trContractionPenalty = 0;
  if (signal.direction !== 'neutral' && ltf) {
    const bars = ltf.bars;
    if (bars.length >= 14) {
      const window = bars.slice(-14);
      const trValues: number[] = [];
      for (let i = 1; i < window.length; i++) {
        const curr = window[i]!;
        const prev = window[i - 1]!;
        trValues.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
      }
      const baselineTR = trValues.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
      const recentTR = trValues.slice(-3).reduce((a, b) => a + b, 0) / 3;
      if (baselineTR > 0) {
        const trRatio = recentTR / baselineTR;
        if (trRatio < 0.50) trContractionPenalty = -0.08;
        else if (trRatio < 0.70) trContractionPenalty = -0.05;
      }
    }
  }

  // Low vol penalty
  let lowVolPenalty = 0;
  if (signal.direction !== 'neutral') {
    const htfFreshCrossAligned = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
    const htfRecentCross = signal.direction === 'bullish' ? htf.dmi.recentCrossUp : htf.dmi.recentCrossDown;
    if (htf.dmi.adx < 15) lowVolPenalty = -0.10;
    else if (htf.dmi.adx < 20) lowVolPenalty = -0.05;
    if (lowVolPenalty < 0) {
      // Fresh cross waiver: fully waive only when ADX is rising (genuine new trend).
      // When ADX slope < 0, the cross happened but momentum is fading — halve instead.
      if (htfFreshCrossAligned) lowVolPenalty = htf.dmi.adxSlope >= 0 ? 0 : lowVolPenalty * 0.50;
      else if (htfRecentCross) lowVolPenalty *= 0.50;
    }
  }

  // Move exhaustion penalty
  let moveExhaustionPenalty = 0;
  if (signal.direction !== 'neutral' && !htfFreshCross && htf.bars.length >= 6) {
    const recentHTF = htf.bars.slice(-5);
    const htfATR = htf.atr.atr;
    if (htfATR > 0) {
      let maxHigh = -Infinity, minLow = Infinity;
      for (const bar of recentHTF) {
        if (bar.high > maxHigh) maxHigh = bar.high;
        if (bar.low < minLow) minLow = bar.low;
      }
      const moveInDir = signal.direction === 'bearish'
        ? recentHTF[0]!.high - recentHTF[recentHTF.length - 1]!.low
        : recentHTF[recentHTF.length - 1]!.high - recentHTF[0]!.low;
      if (moveInDir > 0) {
        const moveATRs = moveInDir / htfATR;
        if (moveATRs >= 2.5) moveExhaustionPenalty = -0.15;
        else if (moveATRs >= 1.5) moveExhaustionPenalty = -0.10;
        else if (moveATRs >= 1.0) moveExhaustionPenalty = -0.06;
        if (moveExhaustionPenalty > -0.15 && moveExhaustionPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20 && momentumAccelBonus > 0) {
          moveExhaustionPenalty *= 0.5;
        }
      }
    }
  }

  // Deferred lowVol reduction: all-aligned + ADX rising + no exhaustion
  if (lowVolPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 15 && htf.dmi.adxSlope > 0 && moveExhaustionPenalty === 0) {
    lowVolPenalty *= 0.50;
  }

  // Consolidation penalty
  let consolidationPenalty = 0;
  if (signal.direction !== 'neutral' && ltf && ltf.bars.length >= 8) {
    const chopBars = ltf.bars.slice(-6);
    const totalBarRange = chopBars.reduce((sum, b) => sum + (b.high - b.low), 0);
    let overallHigh = -Infinity, overallLow = Infinity;
    for (const b of chopBars) {
      if (b.high > overallHigh) overallHigh = b.high;
      if (b.low < overallLow) overallLow = b.low;
    }
    const overallRange = overallHigh - overallLow;
    if (overallRange > 0) {
      const overlapRatio = totalBarRange / overallRange;
      if (overlapRatio >= 3.0) consolidationPenalty = -0.10;
      else if (overlapRatio >= 2.5) consolidationPenalty = -0.06;
      else if (overlapRatio >= 2.0) consolidationPenalty = -0.03;
    }
    if (consolidationPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx >= 20) consolidationPenalty *= 0.5;
  }

  // Near level penalty
  let nearLevelPenalty = 0;
  if (signal.direction !== 'neutral') {
    const ps = htf.priceStructure;
    const price = signal.currentPrice;
    const activeBreakdown = recentPriceActionBonus > 0;
    if (signal.direction === 'bearish') {
      const distToSupport = ps.swingLow > 0 ? ((price - ps.swingLow) / ps.swingLow) * 100 : 999;
      if (distToSupport > 0 && distToSupport <= 0.15) nearLevelPenalty = -0.10;
      else if (distToSupport > 0 && distToSupport <= 0.30) nearLevelPenalty = -0.06;
      else if (distToSupport > 0 && distToSupport <= 0.50) nearLevelPenalty = -0.03;
    } else {
      const distToResist = ps.swingHigh > 0 ? ((ps.swingHigh - price) / ps.swingHigh) * 100 : 999;
      if (distToResist > 0 && distToResist <= 0.15) nearLevelPenalty = -0.10;
      else if (distToResist > 0 && distToResist <= 0.30) nearLevelPenalty = -0.06;
      else if (distToResist > 0 && distToResist <= 0.50) nearLevelPenalty = -0.03;
    }
    // Pattern 4: Near-level penalty is a reliable warning — keep full penalty.
    // Only halve for very strong active trends (ADX > 30 and rising).
    if (nearLevelPenalty < 0 && signal.alignment === 'all_aligned' && htf.dmi.adx > 30 && htf.dmi.adxSlope > 0) {
      nearLevelPenalty *= 0.5;
    }
    if (nearLevelPenalty < 0) {
      const activelySetting = signal.direction === 'bearish'
        ? ps.swingLowBarsAgo <= 2
        : ps.swingHighBarsAgo <= 2;
      if (activelySetting) {
        nearLevelPenalty *= 0.5;
      }
    }
  }

  // Theta decay — simulate 0DTE penalty based on time remaining to market close
  const thetaDecayPenalty = simulateThetaDecay(signal.createdAt, TARGET_DATE);

  // Narrow range penalty — intraday range vs prior day range
  let narrowRangePenalty = 0;
  if (signal.direction !== 'neutral' && htf.bars.length >= 3 && signal.priorDayLevels.pdh > 0) {
    const priorDayRange = signal.priorDayLevels.pdh - signal.priorDayLevels.pdl;
    if (priorDayRange > 0) {
      let dayHigh = -Infinity, dayLow = Infinity;
      for (const bar of htf.bars) { if (bar.high > dayHigh) dayHigh = bar.high; if (bar.low < dayLow) dayLow = bar.low; }
      const rangeRatio = (dayHigh - dayLow) / priorDayRange;
      if (rangeRatio < 0.40) narrowRangePenalty = -0.12;
      else if (rangeRatio < 0.55) narrowRangePenalty = -0.08;
      else if (rangeRatio < 0.70) narrowRangePenalty = -0.04;
    }
  }

  // Reversal override adjustments (same as analysis-agent.ts)
  if (signal.reversalOverride) {
    if (moveExhaustionPenalty < 0) moveExhaustionPenalty = 0;
    if (nearLevelPenalty < 0) nearLevelPenalty = 0;
    if (trendPhaseBonus < 0) trendPhaseBonus = 0;
    if (momentumAccelBonus < 0) momentumAccelBonus = 0;
    if (pricePositionAdjustment < 0) pricePositionAdjustment = 0;
    if (diSpreadBonus < 0) diSpreadBonus = 0;
    if (lowVolPenalty < 0) lowVolPenalty = 0;
    if (vwapBonus === 0) vwapBonus = 0.06;
  }

  // DI Spread cap for aged trends: in a mature trend the DI spread reflects sustained
  // momentum, not fresh signal. Cap to prevent inflated confidence on stale setups.
  if (adxMaturityPenalty <= -0.04) diSpreadBonus = Math.min(diSpreadBonus, 0.06);

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));

  // Hard gates
  // Pattern 3: No structure support (Structure ≤ 0) — cap confidence.
  // Every winner had Structure=+0.060; losers often had 0 or negative.
  if (structureBonus <= 0) total = Math.min(total, 0.68);
  if (structureBonus < 0) total = Math.min(total, 0.62);
  // Pattern 1: Low ADX strength — weak trend, unreliable signal.
  // ADX < 15: no exemption, trend too weak for any entry.
  // ADX 15-20: fresh cross with confirming PA can still enter, but capped.
  if (htf.dmi.adx < 15) total = Math.min(total, 0.55);
  else if (htf.dmi.adx < 20) total = Math.min(total, 0.64);
  if (trContractionPenalty < 0 && recentPriceActionBonus <= 0) total = Math.min(total, 0.60);
  if (adxMaturityPenalty <= -0.15 && !(signal.alignment === 'all_aligned' && htf.dmi.adx >= 20)) {
    total = Math.min(total, recentPriceActionBonus > 0 ? 0.64 : 0.55);
  }
  if (recentPriceActionBonus <= -0.15) total = Math.min(total, 0.60);
  // Opposing price action — candles moving against trend direction
  if (recentPriceActionBonus < 0) total = Math.min(total, 0.64);
  if (moveExhaustionPenalty <= -0.06 && consolidationPenalty < 0) total = Math.min(total, 0.58);
  if (moveExhaustionPenalty <= -0.15) total = Math.min(total, 0.60);
  if (adxMaturityPenalty <= -0.08 && moveExhaustionPenalty <= -0.06) total = Math.min(total, 0.62);
  // Very severe ADX maturity (post-halving still >= 7%): trend ran 20+ bars above ADX 25.
  // Even with all_aligned halving, this much aging means the easy money is gone.
  if (adxMaturityPenalty <= -0.07) total = Math.min(total, 0.64);
  // Aged trend stalling without price confirmation — high reversal probability.
  if (adxMaturityPenalty <= -0.06 && consolidationPenalty <= -0.04 && recentPriceActionBonus <= 0) total = Math.min(total, 0.64);
  { const rp = htf.priceStructure.rangePosition; const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0; const extremeGateApplies = !strongActiveTrend && htf.dmi.adx >= 15; const atExtreme = (signal.direction === 'bullish' && rp >= 0.85) || (signal.direction === 'bearish' && rp <= 0.15); if (atExtreme && extremeGateApplies && !(signal.alignment === 'all_aligned' && htf.dmi.adx >= 20)) total = Math.min(total, 0.62); const nearExtreme = (signal.direction === 'bullish' && rp >= 0.75) || (signal.direction === 'bearish' && rp <= 0.25); if (nearExtreme && htf.dmi.diSpreadSlope < -3 && htf.dmi.adx >= 15) total = Math.min(total, 0.64); }
  if (narrowRangePenalty <= -0.08 && pricePositionAdjustment <= -0.04) total = Math.min(total, 0.60);
  if (thetaDecayPenalty <= -0.10) total = Math.min(total, 0.55);

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
}

// ── Range-bound confidence computation ────────────────────────────────────────
// Inverted logic: conditions penalized for trend (low ADX, consolidation, near levels)
// are REWARDED for mean-reversion at range extremes.

function computeRangeConfidence(
  signal: SignalPayload,
  rangeSupport: number,
  rangeResistance: number,
): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  const empty: ConfidenceBreakdown = { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
  if (!ltf || !mtf || !htf) return empty;

  const base = 0.38;
  const price = signal.currentPrice;
  const rangeWidth = rangeResistance - rangeSupport;
  if (rangeWidth <= 0) return empty;
  const rangePos = (price - rangeSupport) / rangeWidth;

  // ── Range position extremity (INVERTED: reward extremes) ──
  // For range trades, being at the extreme IS the setup
  let pricePositionAdjustment = 0;
  if (signal.direction === 'bullish') {
    // Buying at support — lower rangePos is better
    if (rangePos <= 0.15) pricePositionAdjustment = 0.10;
    else if (rangePos <= 0.25) pricePositionAdjustment = 0.06;
    else if (rangePos <= 0.35) pricePositionAdjustment = 0.03;
  } else {
    // Selling at resistance — higher rangePos is better
    if (rangePos >= 0.85) pricePositionAdjustment = 0.10;
    else if (rangePos >= 0.75) pricePositionAdjustment = 0.06;
    else if (rangePos >= 0.65) pricePositionAdjustment = 0.03;
  }

  // ── VWAP overextension (reward being at/beyond VWAP bands) ──
  let vwapBonus = 0;
  const { vwap: htfVwap, upperBand: htfUpper, lowerBand: htfLower, deviation: htfDev, priceVsVwap } = htf.vwap;
  if (signal.direction === 'bullish') {
    // Buying: want price below VWAP (overextended down)
    if (price <= htfLower) vwapBonus = 0.08;
    else if (price <= htfVwap - htfDev) vwapBonus = 0.04;
    else if (priceVsVwap < 0) vwapBonus = 0.02;
  } else {
    // Selling: want price above VWAP (overextended up)
    if (price >= htfUpper) vwapBonus = 0.08;
    else if (price >= htfVwap + htfDev) vwapBonus = 0.04;
    else if (priceVsVwap > 0) vwapBonus = 0.02;
  }

  // ── Near level bonus (INVERTED: reward proximity to support/resistance) ──
  let nearLevelPenalty = 0; // repurposed as bonus
  const ps = htf.priceStructure;
  if (signal.direction === 'bullish') {
    const distToSupport = ps.swingLow > 0 ? ((price - ps.swingLow) / ps.swingLow) * 100 : 999;
    if (distToSupport >= 0 && distToSupport <= 0.15) nearLevelPenalty = 0.08;
    else if (distToSupport >= 0 && distToSupport <= 0.30) nearLevelPenalty = 0.05;
    else if (distToSupport >= 0 && distToSupport <= 0.50) nearLevelPenalty = 0.02;
  } else {
    const distToResist = ps.swingHigh > 0 ? ((ps.swingHigh - price) / ps.swingHigh) * 100 : 999;
    if (distToResist >= 0 && distToResist <= 0.15) nearLevelPenalty = 0.08;
    else if (distToResist >= 0 && distToResist <= 0.30) nearLevelPenalty = 0.05;
    else if (distToResist >= 0 && distToResist <= 0.50) nearLevelPenalty = 0.02;
  }

  // ── Prior day level alignment ──
  let structureBonus = 0;
  if (signal.priorDayLevels.pdh > 0) {
    const { pdh, pdl } = signal.priorDayLevels;
    // Bullish near PDL, bearish near PDH → range trade at key level
    if (signal.direction === 'bullish') {
      const distToPDL = pdl > 0 ? Math.abs(price - pdl) / pdl * 100 : 999;
      if (distToPDL < 0.30) structureBonus = 0.06;
      else if (distToPDL < 0.50) structureBonus = 0.03;
    } else {
      const distToPDH = pdh > 0 ? Math.abs(price - pdh) / pdh * 100 : 999;
      if (distToPDH < 0.30) structureBonus = 0.06;
      else if (distToPDH < 0.50) structureBonus = 0.03;
    }
  }

  // ── Low ADX confirmation (INVERTED: reward low ADX in range mode) ──
  let lowVolPenalty = 0; // repurposed as bonus
  if (htf.dmi.adx < 18) lowVolPenalty = 0.06;
  else if (htf.dmi.adx < 22) lowVolPenalty = 0.03;

  // ── Consolidation confirmation (INVERTED: chop = range) ──
  let consolidationPenalty = 0; // repurposed as bonus
  if (ltf.bars.length >= 8) {
    const chopBars = ltf.bars.slice(-6);
    const totalBarRange = chopBars.reduce((sum, b) => sum + (b.high - b.low), 0);
    let overallHigh = -Infinity, overallLow = Infinity;
    for (const b of chopBars) { if (b.high > overallHigh) overallHigh = b.high; if (b.low < overallLow) overallLow = b.low; }
    const overallRange = overallHigh - overallLow;
    if (overallRange > 0) {
      const overlapRatio = totalBarRange / overallRange;
      if (overlapRatio >= 2.5) consolidationPenalty = 0.04;
      else if (overlapRatio >= 2.0) consolidationPenalty = 0.02;
    }
  }

  // ── OBV divergence (classic mean-reversion signal) ──
  let obvBonus = 0;
  // Bullish at support with bearish OBV divergence = sellers exhausting
  // Bearish at resistance with bullish OBV divergence = buyers exhausting
  const htfOBVDiv = htf.obv.divergence;
  if (signal.direction === 'bullish' && htfOBVDiv === 'bullish') obvBonus = 0.04;
  else if (signal.direction === 'bearish' && htfOBVDiv === 'bearish') obvBonus = 0.04;
  // OBV trend opposing signal direction = volume confirming reversal
  if (htf.obv.trend !== signal.direction && htf.obv.trend !== 'neutral') obvBonus += 0.02;
  obvBonus = Math.min(0.06, obvBonus);

  // ── Recent price action reversal (want bars turning at extreme) ──
  let recentPriceActionBonus = 0;
  if (ltf.bars.length >= 4) {
    const recentBars = ltf.bars.slice(-3);
    const lastBar = recentBars[recentBars.length - 1]!;
    const isBullish = signal.direction === 'bullish';
    const lastBarConfirms = isBullish ? lastBar.close > lastBar.open : lastBar.close < lastBar.open;
    const priorBars = recentBars.slice(0, -1);
    const priorOpposing = priorBars.filter(b => isBullish ? b.close < b.open : b.close > b.open).length;
    // Best setup: prior bars moved against, last bar turns = reversal candle
    if (lastBarConfirms && priorOpposing >= 2) recentPriceActionBonus = 0.06;
    else if (lastBarConfirms && priorOpposing >= 1) recentPriceActionBonus = 0.03;
  }

  // ── Small DI spread bonus (weak trend in range direction = confirming fade) ──
  let diSpreadBonus = 0;
  const avgDISpread = tfs.reduce((sum, tf) => {
    const spread = signal.direction === 'bullish'
      ? tf.dmi.plusDI - tf.dmi.minusDI
      : tf.dmi.minusDI - tf.dmi.plusDI;
    return sum + spread;
  }, 0) / tfs.length;
  if (avgDISpread > 0) diSpreadBonus = Math.min(0.03, avgDISpread / 40 * 0.03);

  // ── Range width check (need enough room for option profit) ──
  let narrowRangePenalty = 0;
  const rangeWidthPct = rangeWidth / price * 100;
  if (rangeWidthPct < 0.20) narrowRangePenalty = -0.15;
  else if (rangeWidthPct < 0.30) narrowRangePenalty = -0.08;


  // ── PENALTIES: conditions that invalidate range trading ──
  // ADX trending penalty (high ADX = trending, don't range trade)
  let adxBonus = 0; // repurposed as penalty
  if (htf.dmi.adx >= 30) adxBonus = -0.15;
  else if (htf.dmi.adx >= 25) adxBonus = -0.10;
  else if (htf.dmi.adx >= 22 && htf.dmi.adxSlope > 2) adxBonus = -0.06;

  // ADX rising fast = trend emerging, don't fade
  let trendPhaseBonus = 0; // repurposed as penalty
  if (htf.dmi.adxSlope > 4) trendPhaseBonus = -0.10;
  else if (htf.dmi.adxSlope > 2) trendPhaseBonus = -0.05;

  // ORB breakout opposing range trade
  let orbBonus = 0;
  if (signal.orb.orbFormed && signal.orb.breakoutDirection !== 'none') {
    if (signal.orb.breakoutDirection !== signal.direction) orbBonus = -0.06;
    else orbBonus = 0.02; // ORB in same direction = mild confirmation
  }

  // Price beyond range (broke through support/resistance)
  let moveExhaustionPenalty = 0;
  if (signal.direction === 'bullish' && price < rangeSupport) moveExhaustionPenalty = -0.12;
  else if (signal.direction === 'bearish' && price > rangeResistance) moveExhaustionPenalty = -0.12;

  // Unused fields (set to 0 for ConfidenceBreakdown compatibility)
  const diCrossBonus = 0;
  const alignmentBonus = 0;
  const tdAdjustment = 0;
  const oiVolumeBonus = 0;
  const adxMaturityPenalty = 0;
  const momentumAccelBonus = 0;
  const trContractionPenalty = 0;
  const thetaDecayPenalty = simulateThetaDecay(signal.createdAt, TARGET_DATE);

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));

  // Hard gates for range mode
  if (htf.dmi.adx >= 28) total = Math.min(total, 0.50);
  else if (htf.dmi.adx >= 25) total = Math.min(total, 0.58);
  if (htf.dmi.adxSlope > 5) total = Math.min(total, 0.55);
  if (rangeWidthPct < 0.20) total = Math.min(total, 0.45);
  // Price actively moving against entry direction = breakout, not reversal
  if (recentPriceActionBonus < 0) total = Math.min(total, 0.58);
  // ADX slope rising (>2) = trend emerging, don't fade it
  if (trendPhaseBonus <= -0.05) total = Math.min(total, 0.55);
  // Opposing ORB + weak reversal candle = breakout against the range trade
  if (orbBonus <= -0.06 && recentPriceActionBonus <= 0.03) total = Math.min(total, 0.58);
  // VWAP overextension required: range entries without VWAP support lack conviction
  if (vwapBonus <= 0) total = Math.min(total, 0.55);
  // High choppiness = frequent direction flips = unreliable support/resistance
  if (ltf && ltf.bars.length >= 15) {
    const chopBarsAll = ltf.bars;
    let flips = 0;
    let prevDir: 'up' | 'down' | null = null;
    for (let i = 1; i < chopBarsAll.length; i++) {
      const dir = chopBarsAll[i]!.close > chopBarsAll[i - 1]!.close ? 'up' : 'down';
      if (prevDir && dir !== prevDir) flips++;
      prevDir = dir;
    }
    const expectedFlips = Math.max(1, chopBarsAll.length / 15);
    const chopRatio = flips / expectedFlips;
    if (chopRatio >= 1.3) total = Math.min(total, 0.55);
  }

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
}

// ── Breakout (squeeze breakout) confidence computation ─────────────────────────

function computeBreakoutConfidence(signal: SignalPayload): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  const empty: ConfidenceBreakdown = { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
  if (!ltf || !mtf || !htf || !signal.breakoutLevel) return empty;

  const base = 0.38;
  const price = signal.currentPrice;
  const beyondPct = signal.breakoutBeyond ?? 0;

  // ADX slope bonus: rising ADX from low base = new trend forming
  let adxBonus = 0;
  if (htf.dmi.adxSlope > 3) adxBonus = 0.08;
  else if (htf.dmi.adxSlope > 1.5) adxBonus = 0.05;
  else if (htf.dmi.adxSlope > 0) adxBonus = 0.02;

  // DI cross bonus: fresh cross in breakout direction
  let diCrossBonus = 0;
  const htfAligned = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
  const mtfAligned = signal.direction === 'bullish' ? mtf.dmi.crossedUp : mtf.dmi.crossedDown;
  if (htfAligned) diCrossBonus += 0.06;
  if (mtfAligned) diCrossBonus += 0.03;
  diCrossBonus = Math.min(0.09, diCrossBonus);

  // DI spread confirming breakout direction
  let diSpreadBonus = 0;
  const avgDISpread = tfs.reduce((sum, tf) => {
    const spread = signal.direction === 'bullish'
      ? tf.dmi.plusDI - tf.dmi.minusDI
      : tf.dmi.minusDI - tf.dmi.plusDI;
    return sum + spread;
  }, 0) / tfs.length;
  diSpreadBonus = Math.max(-0.05, Math.min(0.08, (avgDISpread / 30) * 0.08));

  // OBV confirmation
  let obvBonus = 0;
  if (htf.obv.trend === signal.direction) obvBonus += 0.04;
  if (mtf.obv.trend === signal.direction) obvBonus += 0.02;
  obvBonus = Math.min(0.06, obvBonus);

  // Breakout freshness: closer to level = fresher
  let pricePositionAdjustment = 0;
  if (beyondPct <= 0.10) pricePositionAdjustment = 0.08;
  else if (beyondPct <= 0.20) pricePositionAdjustment = 0.04;
  else if (beyondPct <= 0.30) pricePositionAdjustment = 0.00;
  else pricePositionAdjustment = -0.06;

  // Prior range tightness: tighter range = more stored energy
  let narrowRangePenalty = 0;
  if (signal.priorDayLevels.pdh > 0) {
    const ps = htf.priceStructure;
    const swingRange = ps.swingHigh - ps.swingLow;
    const swingRangePct = price > 0 ? (swingRange / price) * 100 : 0;
    if (swingRangePct < 0.30) narrowRangePenalty = 0.06;
    else if (swingRangePct < 0.50) narrowRangePenalty = 0.03;
  }

  // Recent price action confirming breakout direction
  let recentPriceActionBonus = 0;
  if (ltf.bars.length >= 4) {
    const recentBars = ltf.bars.slice(-3);
    const isBullish = signal.direction === 'bullish';
    const confirmingBars = recentBars.filter(b => isBullish ? b.close > b.open : b.close < b.open).length;
    const netMove = recentBars[recentBars.length - 1]!.close - recentBars[0]!.open;
    const netConfirms = isBullish ? netMove > 0 : netMove < 0;
    if (confirmingBars >= 3 && netConfirms) recentPriceActionBonus = 0.08;
    else if (confirmingBars >= 2 && netConfirms) recentPriceActionBonus = 0.04;
    else if (!netConfirms) recentPriceActionBonus = -0.06;
  }

  // Alignment bonus
  const alignmentBonusMap: Record<string, number> = { all_aligned: 0.06, htf_mtf_aligned: 0.03, mtf_ltf_aligned: 0.02, mixed: 0 };
  const alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;

  // VWAP alignment
  let vwapBonus = 0;
  const pvv = htf.vwap.priceVsVwap;
  if (signal.direction === 'bullish' && pvv > 0) vwapBonus = 0.03;
  else if (signal.direction === 'bearish' && pvv < 0) vwapBonus = 0.03;
  else if (signal.direction === 'bullish' && pvv < -0.3) vwapBonus = -0.04;
  else if (signal.direction === 'bearish' && pvv > 0.3) vwapBonus = -0.04;

  // ORB alignment
  let orbBonus = 0;
  if (signal.orb.orbFormed && signal.orb.breakoutDirection !== 'none') {
    if (signal.orb.breakoutDirection === signal.direction) orbBonus = 0.04;
    else orbBonus = -0.06;
  }

  // Structure: breaking above PDH / below PDL
  let structureBonus = 0;
  if (signal.priorDayLevels.pdh > 0) {
    const { abovePDH, belowPDL } = signal.priorDayLevels;
    if (signal.direction === 'bullish' && abovePDH) structureBonus = 0.06;
    else if (signal.direction === 'bearish' && belowPDL) structureBonus = 0.06;
  }

  // ADX already high = not a squeeze
  let trendPhaseBonus = 0;
  if (htf.dmi.adx >= 25) trendPhaseBonus = -0.08;
  else if (htf.dmi.adx >= 22) trendPhaseBonus = -0.04;

  const tdAdjustment = 0;
  const oiVolumeBonus = 0;
  const adxMaturityPenalty = 0;
  const momentumAccelBonus = 0;
  const trContractionPenalty = 0;
  const lowVolPenalty = 0;
  const moveExhaustionPenalty = 0;
  const consolidationPenalty = 0;
  const nearLevelPenalty = 0;
  const thetaDecayPenalty = simulateThetaDecay(signal.createdAt, TARGET_DATE);

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));

  // Hard gates
  if (htf.dmi.adx >= 25) total = Math.min(total, 0.60);
  if (recentPriceActionBonus <= -0.06) total = Math.min(total, 0.58);
  if (beyondPct > 0.35) total = Math.min(total, 0.58);

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
}

// ── Mock option evaluation (no historical option data available) ──────────────

function mockOptionEval(signal: SignalPayload): OptionEvaluation {
  return {
    signalId: signal.id,
    ticker: signal.ticker,
    evaluatedAt: signal.createdAt,
    desiredSide: signal.direction === 'bearish' ? 'put' : 'call',
    callCandidate: null,
    putCandidate: null,
    winner: signal.direction === 'bearish' ? 'put' : 'call',
    winnerCandidate: null, // No historical option data
    selectionReason: 'Backtest mock — no historical option data',
    liquidityOk: true,
    candidatePass: true,
  };
}

// ── Price tracking for entry quality analysis ─────────────────────────────────

interface EntryRecord {
  time: string;
  timeET: string;
  direction: SignalDirection;
  alignment: AlignmentType;
  confidence: number;
  price: number;
  strengthScore: number;
  signalMode: 'trend' | 'range' | 'breakout';
  // Price moves after entry (from remaining bars)
  maxFavorable: number;   // max price move in signal direction ($)
  maxAdverse: number;     // max price move against signal direction ($)
  // Entry quality metrics (stock-price-based — accurate, no sim dependency)
  mfePct: number;         // max favorable excursion as % of entry price
  maePct: number;         // max adverse excursion as % of entry price
  mfeOverMae: number;     // MFE/MAE ratio (higher = better entry)
  directionCorrect: boolean;  // price moved favorably > 0.15% within 30min
  move5mPct: number | null;   // directional move at 5m as % of price
  move10mPct: number | null;  // directional move at 10m as % of price
  move15mPct: number | null;  // directional move at 15m as % of price
  move30mPct: number | null;  // directional move at 30m as % of price
  entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';  // stock-price-based grade
  priceAt5m: number | null;
  priceAt10m: number | null;
  priceAt15m: number | null;
  priceAt30m: number | null;
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  atr: number;
  // Simulated order-agent result (secondary — not fully accurate for options)
  sim: SimResult;
  breakdown: ConfidenceBreakdown;
  // Confirmation gate simulation
  gateResult: 'PASSED' | 'STAGE1_OBSERVE' | 'WEAKENING_BLOCK' | 'STALE_BLOCK' | 'HIGH_CONV_OVERRIDE' | 'PHASE_CHANGE_OVERRIDE';
  stage1Conf?: number;  // confidence at stage-1 (if applicable)
  // Regime context at entry time
  regimeScore?: number;
  rangeExhaustion?: number;
  displacementVelocity?: number;
  choppiness?: number;
  intradayTrendStrength?: number;
  // AI orchestrator fields (populated when --ai flag is used)
  aiDecision?: DecisionType;
  aiShouldExecute?: boolean;
  aiReasoning?: string;
  aiConfirmationCount?: number;
}

function utcToET(utcTime: string): string {
  // March 2026 is EDT (UTC-4)
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4);
  return d.toISOString().slice(11, 16);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  BACKTEST: ${TICKER} on ${TARGET_DATE} (Profile: ${PROFILE}, Threshold: ${MIN_CONFIDENCE}${USE_AI ? ', AI ORCHESTRATOR' : ', deterministic'})`);
  console.log(`  Walking market hours ${MARKET_OPEN_UTC}–${MARKET_CLOSE_UTC} UTC in 1-min intervals`);
  console.log(`${'='.repeat(80)}\n`);

  // ── Step 1: Fetch historical bars ──────────────────────────────────────────
  // 2 days warmup for indicator computation
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 4); // go back 4 calendar days for 2 trading days
  const startStr = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = TARGET_DATE + 'T23:59:59Z';

  console.log(`Fetching 1m bars: ${startStr} → ${endStr}`);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m', startStr, endStr);
  // Filter to regular-session bars only (9:30–16:00 ET), matching the live
  // stream's _isRegularSession filter. Pre/post-market bars would pollute
  // DMI/OBV/etc. and cause indicator divergence from live.
  const allOneMin = allOneMinRaw.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
  console.log(`  → ${allOneMinRaw.length} 1-min bars fetched (${allOneMin.length} regular-session)`);

  console.log(`Fetching daily bars for prior day levels...`);
  const dailyBars = await fetchBarsRange(TICKER, '1d', warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z', endStr);
  console.log(`  → ${dailyBars.length} daily bars fetched`);

  // Filter to only bars on or before target date
  const targetDateBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  console.log(`  → ${targetDateBars.length} bars on ${TARGET_DATE}`);

  if (targetDateBars.length === 0) {
    console.error(`No bars found for ${TARGET_DATE}. Was it a trading day?`);
    process.exit(1);
  }

  // Show price range for the day
  const dayHigh = Math.max(...targetDateBars.map(b => b.high));
  const dayLow = Math.min(...targetDateBars.map(b => b.low));
  const dayOpen = targetDateBars[0]!.open;
  const dayClose = targetDateBars[targetDateBars.length - 1]!.close;
  console.log(`\n  Day range: $${dayLow.toFixed(2)} – $${dayHigh.toFixed(2)} (Open: $${dayOpen.toFixed(2)}, Close: $${dayClose.toFixed(2)})`);
  console.log(`  Day change: ${((dayClose - dayOpen) / dayOpen * 100).toFixed(2)}%\n`);

  // ── Recent daily volatility (for range mode gating) ─────────────────────
  // Compute average daily range (high-low as % of close) over the last 3 daily bars.
  // High recent volatility = range levels unreliable → gate range entries.
  const recentDailyBars = dailyBars.slice(-3);
  const avgDailyRangePct = recentDailyBars.length >= 2
    ? recentDailyBars.reduce((s, b) => s + (b.high - b.low) / b.close * 100, 0) / recentDailyBars.length
    : 0;
  console.log(`  Recent daily volatility: ${avgDailyRangePct.toFixed(2)}% avg range (${recentDailyBars.length} days)\n`);

  // ── Step 2: Walk through market hours in 1-min intervals ──────────────────
  const entries: EntryRecord[] = [];
  const allTicks: { time: string; timeET: string; price: number; direction: SignalDirection; alignment: AlignmentType; confidence: number; meetsThreshold: boolean }[] = [];

  // ── Confirmation gate state ────────────────────────────────────────────────
  // Simulates the 2-stage confirmation gate from decision-orchestrator.ts
  let confirmStage1: { direction: SignalDirection; confidence: number; time: string } | null = null;
  let lastEntryTs = 0; // track when last confirmed entry happened (for dedup)

  // ── Range mode state ──────────────────────────────────────────────────────
  let lastRangeEntryTs = 0;
  let rangeEntryCount = 0;
  const RANGE_COOLDOWN_MIN = 20;   // min minutes between range entries
  const MAX_RANGE_ENTRIES = 1;      // max 1 range entry per day — 2nd range entries were 3W/7L across Feb+Mar
  const MAX_DAILY_ENTRIES = TCFG.maxDailyEntries; // per-ticker daily cap
  let dailyEntryCount = 0;
  const RANGE_WAIT_MIN = 45;       // don't range trade in first 45 min (let day establish)

  // ── Breakout mode state ────────────────────────────────────────────────────
  let lastBreakoutEntryTs = 0;
  let breakoutEntryCount = 0;
  const BREAKOUT_COOLDOWN_MIN = 30;
  const MAX_BREAKOUT_ENTRIES = 1;   // was 2 — most 2nd breakout entries fail
  const BREAKOUT_WAIT_MIN = 45;

  // ── Trend mode state ────────────────────────────────────────────────────
  let lastTrendEntryTs = 0;
  let trendEntryCount = 0;
  const TREND_COOLDOWN_MIN = 15;    // min minutes between trend entries
  const MAX_TREND_ENTRIES = 3;       // max trend entries per day

  // ── Displacement-based regime detection ──────────────────────────────────────
  // Tracks how far price has moved from open and how much daily range is consumed.
  // High displacement = late entry risk for trend/breakout, mean-reversion for range.
  let directionFlipCount = 0;
  let prevTickDirection: SignalDirection = 'neutral';
  let intradayHigh = -Infinity;
  let intradayLow = Infinity;
  let regimeScore = 50; // composite: >60 trending, <40 range/choppy

  // ── Displacement velocity ─────────────────────────────────────────────────
  // Tracks rate of change in displacement — accelerating vs decelerating moves.
  const displacementHistory: number[] = []; // rolling window of displacement values (1 per tick)

  // ── Intraday trend tracking (for range mode filtering) ────────────────────
  // Counts consecutive 5m bars making higher highs/lower lows to detect trending days early
  let consecHigherCloses = 0;
  let consecLowerCloses = 0;
  let prevTickClose = 0;
  let intradayTrendStrength = 0; // positive = trending up, negative = trending down, 0 = choppy
  // Rolling window of closes for VWAP-side tracking
  const vwapSideHistory: ('above' | 'below' | 'at')[] = [];

  // ── Intraday loss tracker ────────────────────────────────────────────────
  // Tracks confirmed entries that go against within 5 min. After N quick losses,
  // dramatically raises the threshold — mimics a real trader stopping after losses.
  let intradayLosses = 0;
  const LOSS_THRESHOLD_BUMP = 0.06; // moderate bump after 2 losses
  const MAX_LOSSES_BEFORE_BUMP = 2; // need 2 losses before tightening

  // ── AI orchestrator state (when --ai flag is used) ────────────────────────
  const orchestrator = USE_AI ? new DecisionOrchestrator() : null;
  // Track recent decisions for PositionContext.recentDecisions (newest first)
  const backtestRecentDecisions: PositionContext['recentDecisions'] = [];

  // Generate 1-min timestamps from market open to close
  const openTime = new Date(`${TARGET_DATE}T${MARKET_OPEN_UTC}:00Z`);
  const closeTime = new Date(`${TARGET_DATE}T${MARKET_CLOSE_UTC}:00Z`);
  const rangeEarliestTs = openTime.getTime() + RANGE_WAIT_MIN * 60_000;
  const breakoutEarliestTs = openTime.getTime() + BREAKOUT_WAIT_MIN * 60_000;

  // ── Simulate the live stream's ring buffer ───────────────────────────────
  // Live: seedHistoricalBars fetches 1000 raw bars (limit=1000, 4 cal days back),
  // filters to regular session, trims to BAR_CACHE_SIZE=800. Then new bars are
  // appended during the day, maintaining the 800-bar cap.
  // To replicate: take the first 1000 raw bars before market open, filter to
  // regular session, then grow the cache minute-by-minute during the walk.
  const STREAM_SEED_LIMIT = 1000; // matches alpaca-stream.ts _fetchHistoricalOneMins limit
  const BAR_CACHE_SIZE = 800;     // matches alpaca-stream.ts BAR_CACHE_SIZE
  const openTs = openTime.getTime();
  // Live _fetchHistoricalOneMins: fetches from (now - 4 days) with limit=1000,
  // NO end param. Alpaca returns chronologically, so we get the FIRST 1000 bars
  // from the warmup start date — NOT the last 1000 before market open.
  const warmupTs = new Date(TARGET_DATE);
  warmupTs.setDate(warmupTs.getDate() - 4);
  const warmupStartTs = warmupTs.getTime();
  const priorRawBars = allOneMinRaw.filter(b => {
    const ts = new Date(b.timestamp).getTime();
    return ts >= warmupStartTs && ts < openTs;
  });
  // Take the FIRST STREAM_SEED_LIMIT bars (matching Alpaca ascending + limit=1000)
  const seedRaw = priorRawBars.slice(0, STREAM_SEED_LIMIT);
  // Filter to regular session (same as _seedCache → _isRegularSession)
  const seedFiltered = seedRaw.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
  // Trim to BAR_CACHE_SIZE (newest kept)
  const streamCache: OHLCVBar[] = seedFiltered.slice(-BAR_CACHE_SIZE);
  console.log(`  Stream cache seed: ${seedRaw.length} raw → ${seedFiltered.length} regular-session → ${streamCache.length} (cap ${BAR_CACHE_SIZE})`);

  // Index for efficiently adding today's bars during the walk
  const todayBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  let todayBarIdx = 0;

  let tickCount = 0;
  for (let t = new Date(openTime); t <= closeTime; t.setMinutes(t.getMinutes() + 1)) {
    const currentTs = t.getTime();
    const timeStr = t.toISOString();
    const timeET = utcToET(timeStr);

    // Add completed bars to the stream cache (bar at T is complete at T+60s)
    while (todayBarIdx < todayBars.length) {
      const barTs = new Date(todayBars[todayBarIdx]!.timestamp).getTime();
      if (barTs < currentTs) {
        streamCache.push(todayBars[todayBarIdx]!);
        if (streamCache.length > BAR_CACHE_SIZE) streamCache.splice(0, streamCache.length - BAR_CACHE_SIZE);
        todayBarIdx++;
      } else {
        break;
      }
    }

    if (streamCache.length < 20) continue; // need minimum bars for indicators

    // Derive timeframe bars from the stream cache (matching live behavior)
    const ltfBars = streamCache.slice(-500); // 1m bars, last 500 (matches BARS_LIMIT in signal-agent)
    const mtfBars = aggregate1mBars(streamCache, '3m', currentTs).slice(-500);
    const htfBars = aggregate1mBars(streamCache, '5m', currentTs).slice(-500);

    if (ltfBars.length < 14 || mtfBars.length < 14 || htfBars.length < 14) continue;

    // First pass: DMI direction
    const dmiOnly = [
      computeDMI(ltfBars, 14, true),
      computeDMI(mtfBars, 14, true),
      computeDMI(htfBars, 14, true),
    ];
    const dirVotes = dmiOnly.map(d => d.trend);
    const bullish = dirVotes.filter(v => v === 'bullish').length;
    const bearish = dirVotes.filter(v => v === 'bearish').length;
    let direction: SignalDirection = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral';

    // Early reversal override (same logic as signal-agent.ts)
    let reversalOverride = false;
    const [ltfDmi, , htfDmi] = dmiOnly;
    if (direction !== 'neutral' && ltfDmi && htfDmi) {
      const ltfOpposesDir = direction === 'bullish' ? ltfDmi.trend === 'bearish'
                                                     : ltfDmi.trend === 'bullish';
      const htfFading = htfDmi.diSpreadSlope < -2;
      const htfBarsForRange = htfBars.slice(-20);
      let rangeHigh = -Infinity, rangeLow = Infinity;
      for (const b of htfBarsForRange) {
        if (b.high > rangeHigh) rangeHigh = b.high;
        if (b.low < rangeLow) rangeLow = b.low;
      }
      const rangeSize = rangeHigh - rangeLow;
      const lastPrice = htfBarsForRange[htfBarsForRange.length - 1]?.close ?? 0;
      const rangePos = rangeSize > 0 ? (lastPrice - rangeLow) / rangeSize : 0.5;
      const atExtreme = direction === 'bullish' ? rangePos >= 0.75 : rangePos <= 0.25;
      if (ltfOpposesDir && htfFading && atExtreme) {
        direction = direction === 'bullish' ? 'bearish' : 'bullish';
        reversalOverride = true;
      }
    }

    // Second pass: full indicators
    const tfIndicators: TimeframeIndicators[] = [
      computeTimeframeIndicators(ltfBars, '1m', direction),
      computeTimeframeIndicators(mtfBars, '3m', direction),
      computeTimeframeIndicators(htfBars, '5m', direction),
    ];
    const alignment = classifyAlignment(tfIndicators, direction);
    const currentPrice = ltfBars[ltfBars.length - 1]!.close;
    const atr = tfIndicators[2]?.atr.atr ?? tfIndicators[0]?.atr.atr ?? 0;
    const atm = Math.round(currentPrice);
    const htfAdx = tfIndicators[2]?.dmi.adx ?? 0;
    const strengthScore = Math.min(100, Math.round(htfAdx * 2));
    const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
    const orb = computeORB(ltfBars, currentPrice);

    const signal: SignalPayload = {
      id: uuidv4(), ticker: TICKER, profile: PROFILE,
      timeframes: tfIndicators, ltf: '1m', mtf: '3m', htf: '5m',
      direction, alignment, currentPrice, atr, atm, strengthScore,
      priorDayLevels, orb,
      reversalOverride: reversalOverride || undefined,
      triggeredBy: 'AUTO', createdAt: timeStr,
    };

    // ── Range detection ──────────────────────────────────────────────────────
    // Detect range-bound regime: low ADX, no fresh DI cross, price within swing range
    let signalMode: 'trend' | 'range' | 'breakout' = 'trend';
    let rangeSupport = 0, rangeResistance = 0, rangeMidpoint = 0;
    const htfTfForRange = tfIndicators[2]!;
    const htfAdxForRange = htfTfForRange.dmi.adx;
    const htfHasFreshCross = (htfTfForRange.dmi.crossedUp || htfTfForRange.dmi.crossedDown);
    const htfRangePos = htfTfForRange.priceStructure.rangePosition;
    const htfSwingHigh = htfTfForRange.priceStructure.swingHigh;
    const htfSwingLow = htfTfForRange.priceStructure.swingLow;
    const htfSwingRange = htfSwingHigh - htfSwingLow;
    const htfSwingRangePct = htfSwingRange / currentPrice * 100;

    if (htfAdxForRange < 22 && !htfHasFreshCross
        && htfRangePos >= 0.05 && htfRangePos <= 0.95
        && htfSwingRangePct >= 0.20) {
      // Range regime detected — determine direction from position in range
      const atResistance = htfRangePos >= 0.70;
      const atSupport = htfRangePos <= 0.30;
      if (atResistance || atSupport) {
        signalMode = 'range';
        // Use swing levels, enriched with prior day levels if nearby
        rangeSupport = htfSwingLow;
        rangeResistance = htfSwingHigh;
        const { pdh, pdl } = priorDayLevels;
        if (pdl > 0 && Math.abs(pdl - htfSwingLow) / currentPrice < 0.003) rangeSupport = Math.min(rangeSupport, pdl);
        if (pdh > 0 && Math.abs(pdh - htfSwingHigh) / currentPrice < 0.003) rangeResistance = Math.max(rangeResistance, pdh);
        rangeMidpoint = (rangeSupport + rangeResistance) / 2;
        // Override direction based on range position (ignore DMI vote)
        direction = atResistance ? 'bearish' : 'bullish';
        signal.direction = direction;
      }
    }

    // ── Breakout detection ──────────────────────────────────────────────────
    // Detect squeeze breakout: ADX < 20 but rising, price broke swing high/low,
    // volume confirmation. Catches transition from range to trend.
    let breakoutLevel = 0, breakoutBeyond = 0;
    // Relaxed: ADX < 25 (not just < 20) — on 5m bars ADX often stays 20-25 during consolidation.
    // The rising ADX slope + level break + OBV confirmation provide sufficient filtering.
    // Use LAGGED swing high/low (exclude last 3 bars) so the breakout level is a fixed target,
    // not one that moves with price. This prevents the swing level from chasing price upward.
    if (signalMode === 'trend' && htfAdxForRange < 25 && htfTfForRange.dmi.adxSlope > 0) {
      const htfBarsForBO = htfTfForRange.bars.slice(-20, -3); // exclude last 3 bars
      let boSwingHigh = -Infinity, boSwingLow = Infinity;
      for (const b of htfBarsForBO) {
        if (b.high > boSwingHigh) boSwingHigh = b.high;
        if (b.low < boSwingLow) boSwingLow = b.low;
      }
      const boSwingRange = boSwingHigh - boSwingLow;
      const brokeHigh = currentPrice > boSwingHigh && boSwingRange > 0;
      const brokeLow = currentPrice < boSwingLow && boSwingRange > 0;
      if (brokeHigh || brokeLow) {
        const beyondPct = brokeHigh
          ? ((currentPrice - boSwingHigh) / currentPrice) * 100
          : ((boSwingLow - currentPrice) / currentPrice) * 100;
        if (beyondPct > 0.02 && beyondPct < 0.40) {
          const htfObv = tfIndicators[2]!.obv;
          const obvConfirms = brokeHigh
            ? htfObv.trend === 'bullish'
            : htfObv.trend === 'bearish';
          // OBV confirmation preferred but not required — breakout momentum often leads OBV.
          // If OBV doesn't confirm, require a stronger DI spread slope or fresh DI cross instead.
          const htfDiCross = brokeHigh ? htfTfForRange.dmi.crossedUp : htfTfForRange.dmi.crossedDown;
          const diSpreadConfirms = htfTfForRange.dmi.diSpreadSlope > 1;
          if (obvConfirms || htfDiCross || diSpreadConfirms) {
            signalMode = 'breakout';
            breakoutLevel = brokeHigh ? boSwingHigh : boSwingLow;
            breakoutBeyond = beyondPct;
            direction = brokeHigh ? 'bullish' : 'bearish';
            signal.direction = direction;
            signal.signalMode = 'breakout';
            signal.breakoutLevel = breakoutLevel;
            signal.breakoutBeyond = breakoutBeyond;
          }
        }
      }
    }

    // ── Displacement-based regime detection ─────────────────────────────────────
    // Core insight: High displacement = trend already mature = late entry risk for trend/breakout
    // but mean-reversion opportunity for range mode. This inverts per mode.

    // Track running intraday extremes
    if (currentPrice > intradayHigh) intradayHigh = currentPrice;
    if (currentPrice < intradayLow) intradayLow = currentPrice;

    // A. Running displacement: how far price has moved from open (%)
    const runningDisplacement = Math.abs(currentPrice - dayOpen) / dayOpen * 100;

    // B. Range exhaustion: what fraction of expected daily range is consumed
    const intradayRange = intradayHigh - intradayLow;
    const dailyATR = atr > 0 ? atr : intradayRange; // fallback if ATR not available
    const rangeExhaustion = dailyATR > 0 ? intradayRange / dailyATR : 0;

    // C. Direction flip counter (choppiness proxy)
    if (direction !== 'neutral' && direction !== prevTickDirection && prevTickDirection !== 'neutral') {
      directionFlipCount++;
    }
    if (direction !== 'neutral') prevTickDirection = direction;
    const minutesSinceOpen = (currentTs - openTime.getTime()) / 60_000;
    const expectedFlips = Math.max(1, minutesSinceOpen / 15);
    const choppiness = directionFlipCount / expectedFlips; // >1.5 = choppy, <0.8 = trending

    // D. Displacement velocity: rate of change in displacement over last 10 ticks
    displacementHistory.push(runningDisplacement);
    if (displacementHistory.length > 20) displacementHistory.shift();
    let displacementVelocity = 0; // positive = displacement increasing (trending), negative = reverting
    if (displacementHistory.length >= 10) {
      const recent5 = displacementHistory.slice(-5);
      const prior5 = displacementHistory.slice(-10, -5);
      const recentAvg = recent5.reduce((a, b) => a + b, 0) / 5;
      const priorAvg = prior5.reduce((a, b) => a + b, 0) / 5;
      displacementVelocity = recentAvg - priorAvg; // >0 = accelerating away from open, <0 = reverting
    }

    // E. Intraday trend tracking: consecutive directional closes
    if (prevTickClose > 0) {
      if (currentPrice > prevTickClose) {
        consecHigherCloses = Math.max(1, consecHigherCloses + 1);
        consecLowerCloses = 0;
      } else if (currentPrice < prevTickClose) {
        consecLowerCloses = Math.max(1, consecLowerCloses + 1);
        consecHigherCloses = 0;
      }
    }
    prevTickClose = currentPrice;
    // Trend strength: positive = bullish trend, negative = bearish trend
    intradayTrendStrength = consecHigherCloses >= 3 ? consecHigherCloses
      : consecLowerCloses >= 3 ? -consecLowerCloses : 0;

    // F. VWAP-side consistency: how often price stays on one side of VWAP
    const ltfVwap = tfIndicators[0]?.vwap.priceVsVwap ?? 0;
    vwapSideHistory.push(ltfVwap > 0.05 ? 'above' : ltfVwap < -0.05 ? 'below' : 'at');
    if (vwapSideHistory.length > 30) vwapSideHistory.shift();
    let vwapConsistency = 0; // 0-1: how consistently price stays on one side
    if (vwapSideHistory.length >= 10) {
      const recent = vwapSideHistory.slice(-20);
      const aboveCount = recent.filter(s => s === 'above').length;
      const belowCount = recent.filter(s => s === 'below').length;
      vwapConsistency = Math.max(aboveCount, belowCount) / recent.length;
    }

    // ── Composite regime score ──────────────────────────────────────────────
    // >65 = trending (favor trend/breakout), <35 = range/choppy (favor range), 35-65 = mixed
    const trendingComponent = (1 - choppiness) * 20;           // less choppy = more trending
    const velocityComponent = displacementVelocity * 15;       // accelerating displacement = trending
    const vwapComponent = (vwapConsistency - 0.5) * 20;        // consistent VWAP side = trending
    const trendStrComponent = Math.min(10, Math.abs(intradayTrendStrength) * 2.5); // consecutive closes
    regimeScore = Math.round(Math.max(0, Math.min(100,
      50 + trendingComponent + velocityComponent + vwapComponent + trendStrComponent
    )));

    const optionEval = mockOptionEval(signal);
    const cbRaw = signalMode === 'range'
      ? computeRangeConfidence(signal, rangeSupport, rangeResistance)
      : signalMode === 'breakout'
        ? computeBreakoutConfidence(signal)
        : computeConfidence(signal, optionEval);

    // Per-ticker confidence adjustment hook — allows QQQ etc. to apply custom penalties
    const entryCtx = {
      signalMode, direction, alignment, confidence: cbRaw.total,
      breakdown: cbRaw, strengthScore, currentPrice, atr,
      rangeExhaustion, displacementVelocity, choppiness,
      intradayTrendStrength, regimeScore, dailyEntryCount,
      ltfBars,
      ltfVwapPriceVs: tfIndicators[0]?.vwap?.priceVsVwap ?? 0,
    };
    const cb = TCFG.adjustConfidence(cbRaw, entryCtx);

    // ── Mode-specific regime-aware threshold adjustment ─────────────────────────
    let effectiveThreshold = MIN_CONFIDENCE;

    if (signalMode === 'trend') {
      // Displacement penalty: the bigger the move from open, the riskier a new trend entry
      if (runningDisplacement > 1.0) effectiveThreshold += 0.10;
      else if (runningDisplacement > 0.5) effectiveThreshold += 0.05;
      // Range exhaustion: if most of daily ATR consumed, trend move is done
      if (rangeExhaustion > 1.5) effectiveThreshold += 0.06;
      else if (rangeExhaustion > 1.0) effectiveThreshold += 0.03;
      // Choppiness penalty: frequent direction flips = noise
      if (choppiness > 1.5) effectiveThreshold += 0.04;
      // NOTE: Regime-based threshold adjustments for range/trend entries proved counterproductive
      // in backtesting — any adjustment cascades through entry timing and cooldowns unpredictably.
      // Regime data is logged on each entry for analysis; use it for future structural filters.
    } else if (signalMode === 'range') {
      // High displacement = extended price = better for mean-reversion
      if (runningDisplacement > 1.0) effectiveThreshold -= 0.03;
      else if (runningDisplacement > 0.5) effectiveThreshold -= 0.02;
      // But if range exhaustion is extreme, the "range" may be breaking out
      if (rangeExhaustion > 2.0) effectiveThreshold += 0.05;
    } else if (signalMode === 'breakout') {
      // Similar to trend but slightly less aggressive
      if (runningDisplacement > 0.8) effectiveThreshold += 0.06;
      else if (runningDisplacement > 0.4) effectiveThreshold += 0.03;
      if (rangeExhaustion > 1.5) effectiveThreshold += 0.04;
    }

    // Intraday loss tracker: after losses, raise the bar
    if (intradayLosses >= MAX_LOSSES_BEFORE_BUMP) {
      effectiveThreshold += LOSS_THRESHOLD_BUMP;
    }
    const meetsThreshold = cb.total >= effectiveThreshold;

    // Per-ticker: filter breakout entries with stale/insufficient data (abnormally low ATR%)
    // Only applied to breakout mode — trend entries with low ATR can still be valid
    const atrPct = atr / currentPrice * 100;
    const atrOk = signalMode !== 'breakout' || atrPct >= TCFG.minAtrPct;

    tickCount++;
    allTicks.push({ time: timeStr, timeET, price: currentPrice, direction, alignment, confidence: cb.total, meetsThreshold });

    // ── Entry decision ──────────────────────────────────────────────────────────

    // Forward price analysis helpers (shared by both deterministic and AI paths)
    const computeForwardMoves = () => {
      const futureBars = targetDateBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt > currentTs && bt <= currentTs + 120 * 60_000;
      });
      // All remaining bars until market close (for order-agent sim)
      const allFutureBars = targetDateBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt > currentTs;
      });
      let maxFavorable = 0, maxAdverse = 0;
      for (const fb of futureBars) {
        const move = direction === 'bullish' ? fb.high - currentPrice : currentPrice - fb.low;
        const adverse = direction === 'bullish' ? currentPrice - fb.low : fb.high - currentPrice;
        if (move > maxFavorable) maxFavorable = move;
        if (adverse > maxAdverse) maxAdverse = adverse;
      }
      const findPriceAt = (mins: number): number | null => {
        const targetTime = currentTs + mins * 60_000;
        const bar = targetDateBars.find(b => {
          const bt = new Date(b.timestamp).getTime();
          return bt >= targetTime && bt < targetTime + 60_000;
        });
        return bar?.close ?? null;
      };

      // ── Entry quality metrics (stock-price-based — fully accurate) ──
      const mfePct = (maxFavorable / currentPrice) * 100;
      const maePct = (maxAdverse / currentPrice) * 100;
      const mfeOverMae = maePct > 0.01 ? mfePct / maePct : (mfePct > 0 ? 99.9 : 0);

      // Directional move at key intervals (as % of entry price, positive = favorable)
      const computeMovePct = (priceAtN: number | null): number | null => {
        if (priceAtN === null) return null;
        const move = direction === 'bullish' ? priceAtN - currentPrice : currentPrice - priceAtN;
        return (move / currentPrice) * 100;
      };
      const p5m = findPriceAt(5), p10m = findPriceAt(10), p15m = findPriceAt(15), p30m = findPriceAt(30);
      const move5mPct = computeMovePct(p5m);
      const move10mPct = computeMovePct(p10m);
      const move15mPct = computeMovePct(p15m);
      const move30mPct = computeMovePct(p30m);

      // Direction correct: price moved favorably > 0.10% within 30min
      // (0.10% ≈ $0.65 for SPY — meaningful directional move at checkpoints)
      const bestMoveIn30m = [move5mPct, move10mPct, move15mPct, move30mPct]
        .filter((v): v is number => v !== null);
      const directionCorrect = bestMoveIn30m.length > 0 && Math.max(...bestMoveIn30m) > 0.10;

      // Entry grade: stock-price-based classification
      //   A: MFE > 0.4% AND MFE/MAE > 2.0 — strong directional move with low risk
      //   B: MFE > 0.25% AND MFE/MAE > 1.2 — good move with acceptable risk
      //   C: MFE > 0.15% AND direction correct — moved right way but modest
      //   D: direction correct but weak (MFE < 0.15% or MFE/MAE < 0.8)
      //   F: direction wrong or no meaningful favorable move
      let entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';
      if (mfePct > 0.40 && mfeOverMae > 2.0) entryGrade = 'A';
      else if (mfePct > 0.25 && mfeOverMae > 1.2) entryGrade = 'B';
      else if (mfePct > 0.15 && directionCorrect) entryGrade = 'C';
      else if (directionCorrect) entryGrade = 'D';
      else entryGrade = 'F';

      // Outcome based on entry quality (stock-price), NOT sim P&L
      let outcome: 'GOOD' | 'BAD' | 'MARGINAL' = 'MARGINAL';
      if (entryGrade === 'A' || entryGrade === 'B') outcome = 'GOOD';
      else if (entryGrade === 'F') outcome = 'BAD';

      // Recent 1m bars before entry for volatility measurement
      const recentBars = targetDateBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt <= currentTs && bt > currentTs - 10 * 60_000;
      });
      // Simulate order-agent trailing stop on remaining bars (secondary metric)
      const sim = TCFG.simulate(currentPrice, direction, atr, allFutureBars, {
        recentBars,
        ...(signalMode === 'range' ? { stopMult: 0.5, tpMult: 0.8 }
          : signalMode === 'breakout' ? { stopMult: TCFG.breakoutStopMult, tpMult: TCFG.breakoutTpMult } : {}),
      });
      return {
        maxFavorable, maxAdverse, mfePct, maePct, mfeOverMae, directionCorrect,
        move5mPct, move10mPct, move15mPct, move30mPct, entryGrade, outcome, sim,
        priceAt5m: p5m, priceAt10m: p10m, priceAt15m: p15m, priceAt30m: p30m,
      };
    };

    // Regime context snapshot for entry records
    const regimeCtx = { regimeScore, rangeExhaustion, displacementVelocity, choppiness, intradayTrendStrength };

    if (USE_AI && orchestrator) {
      // ── AI Orchestrator path ──────────────────────────────────────────────
      // Call the real DecisionOrchestrator for every tick that meets threshold
      // (same condition as live: meetsEntryThreshold && timeGateOk)
      if (meetsThreshold && direction !== 'neutral') {
        const analysis: AnalysisResult = {
          signalId: signal.id,
          confidence: cb.total,
          confidenceBreakdown: cb,
          meetsEntryThreshold: meetsThreshold,
          aiExplanation: '',
          keyFactors: [],
          risks: [],
          desiredRight: direction === 'bearish' ? 'put' : 'call',
          createdAt: timeStr,
        };

        const context: PositionContext = {
          openPositions: [],
          brokerPositions: [],
          brokerOpenOrders: [],
          recentDecisions: backtestRecentDecisions.slice(0, 10),
          confirmationStreaks: [],
          recentEvaluations: [],
          accountEquity: 100_000,
          accountBuyingPower: 100_000,
          dailyRealizedPnl: 0,
        };

        const decision: DecisionResult = await orchestrator.run({
          signal, option: optionEval, analysis, context, timeGateOk: true,
        });

        // Track decision for future context
        backtestRecentDecisions.unshift({
          decisionType: decision.decisionType,
          ticker: decision.ticker,
          direction: decision.direction ?? null,
          confirmationCount: decision.confirmationCount,
          orchestrationConfidence: decision.orchestrationConfidence,
          createdAt: decision.createdAt,
          reasoning: decision.reasoning,
        });
        // Keep only last 20 decisions
        if (backtestRecentDecisions.length > 20) backtestRecentDecisions.length = 20;

        // Map AI decision to gate result for compatibility with existing reporting
        let gateResult: EntryRecord['gateResult'];
        if (decision.decisionType === 'NEW_ENTRY' && decision.shouldExecute) {
          if (decision.reasoning.includes('[PHASE-CHANGE OVERRIDE]')) {
            gateResult = 'PHASE_CHANGE_OVERRIDE';
          } else if (cb.total >= 0.92 && alignment === 'all_aligned') {
            gateResult = 'HIGH_CONV_OVERRIDE';
          } else {
            gateResult = 'PASSED';
          }
          lastEntryTs = currentTs;
          dailyEntryCount++;
        } else if (decision.reasoning.includes('[STAGE-1 OBSERVE]')) {
          gateResult = 'STAGE1_OBSERVE';
        } else if (decision.reasoning.includes('[WEAKENING-SIGNAL BLOCK]')) {
          gateResult = 'WEAKENING_BLOCK';
        } else if (decision.reasoning.includes('[STALE-SIGNAL BLOCK]')) {
          gateResult = 'STALE_BLOCK';
        } else {
          gateResult = 'STAGE1_OBSERVE'; // AI chose WAIT or other non-entry
        }

        const fwd = computeForwardMoves();

        entries.push({
          time: timeStr, timeET, direction, alignment, confidence: cb.total,
          price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
          gateResult,
          aiDecision: decision.decisionType,
          aiShouldExecute: decision.shouldExecute,
          aiReasoning: decision.reasoning,
          aiConfirmationCount: decision.confirmationCount,
        });
      }
    } else {
      // ── Deterministic confirmation gate simulation ─────────────────────────
      // Reset confirmation state when direction changes or signal drops well below threshold.
      // Allow stage-1 to survive brief dips (up to 3 ticks) if direction holds — on trending
      // days, confidence oscillates near threshold and shouldn't reset the gate every tick.
      if (confirmStage1) {
        if (direction === 'neutral' || confirmStage1.direction !== direction) {
          confirmStage1 = null; // direction change = hard reset
        } else if (!meetsThreshold) {
          // Brief dip grace: keep stage-1 alive for up to 3 ticks below threshold
          const stage1Age = (currentTs - new Date(confirmStage1.time).getTime()) / 60_000;
          if (stage1Age > 3 || cb.total < MIN_CONFIDENCE - 0.03) {
            confirmStage1 = null; // too old or too far below threshold
          }
          // else: keep stage-1 alive, skip this tick (no entry push)
        }
      }

      // Per-ticker entry filter hook — allows QQQ etc. to block entries with custom logic
      const tickerAllows = !meetsThreshold || TCFG.shouldAllowEntry(entryCtx);

      if (meetsThreshold && atrOk && tickerAllows && direction !== 'neutral' && dailyEntryCount < MAX_DAILY_ENTRIES) {
        // Range entries bypass the trend confirmation gate — quality is in the range confidence model
        if (signalMode === 'range') {
          const RANGE_MIN_CONF = 0.70; // raised from 0.66 — Feb range entries at 0.66-0.69 were 1W/4L
          const cooldownOk = (currentTs - lastRangeEntryTs) >= RANGE_COOLDOWN_MIN * 60_000;
          const underLimit = rangeEntryCount < MAX_RANGE_ENTRIES;
          const pastWaitPeriod = currentTs >= rangeEarliestTs;
          // Multi-factor intraday trend detection: don't range-trade when market is strongly trending
          const dayMovePct = Math.abs(currentPrice - dayOpen) / dayOpen * 100;
          const dayNotTrending = dayMovePct < 2.0;        // only block very large intraday moves
          const noStrongTrend = Math.abs(intradayTrendStrength) < 5; // no 5+ consecutive directional closes
          const rangeRegimeOk = dayNotTrending && noStrongTrend;
          // VWAP overextension required: all March range winners had vwapBonus > 0;
          // range entries without VWAP support (price not overextended vs VWAP) lack conviction.
          const vwapConfirms = cb.vwapBonus > 0;
          // High choppiness = frequent direction flips = unreliable support/resistance levels.
          // Feb+Mar data: 0/12 range winners had chop >= 1.3, but 6/27 range losers did.
          const notTooChoppy = choppiness < 1.3;
          if (cb.total >= RANGE_MIN_CONF && cooldownOk && underLimit && pastWaitPeriod && rangeRegimeOk && vwapConfirms && notTooChoppy) {
            const fwd = computeForwardMoves();
            entries.push({
              time: timeStr, timeET, direction, alignment, confidence: cb.total,
              price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
              gateResult: 'PASSED',
            });
            lastRangeEntryTs = currentTs;
            rangeEntryCount++;
            dailyEntryCount++;
            if (fwd.entryGrade === 'F' || fwd.entryGrade === 'D') intradayLosses++;
          }
        } else if (signalMode === 'breakout') {
          // Breakout entries bypass the trend confirmation gate — quality is in the breakout confidence model
          const cooldownOk = (currentTs - lastBreakoutEntryTs) >= BREAKOUT_COOLDOWN_MIN * 60_000;
          const underLimit = breakoutEntryCount < MAX_BREAKOUT_ENTRIES;
          const pastWaitPeriod = currentTs >= breakoutEarliestTs;
          // Late-day breakouts fail more often (momentum fades into close)
          const breakoutCutoffTs = openTime.getTime() + 360 * 60_000; // 15:30 ET = open + 6h
          const notTooLate = currentTs < breakoutCutoffTs;
          // Mixed alignment breakouts lack directional conviction
          const alignmentOk = alignment !== 'mixed';
          // Breakouts against the trend phase fail at high rate: Feb 7/9 breakout losers
          // had trendPhaseBonus < 0. Require non-negative trend phase for entry.
          const trendPhaseOk = cb.trendPhaseBonus >= 0;
          // Weak ADX breakouts fail: ADX bonus <= 0.020 was 1W/4L (20%).
          // ADX >= 0.050 was 5W/1L (83%). Require moderate ADX for conviction.
          const adxOk = cb.adxBonus >= 0.03;
          // Low strength breakouts fail: Feb str=30,33 were losses.
          const strengthOk = strengthScore >= TCFG.breakoutMinStrength;
          // Extended day: move is exhausted. Per-ticker threshold.
          const notExhausted = rangeExhaustion <= TCFG.breakoutMaxExhaustion;
          // Per-ticker choppiness filter for breakouts
          const notTooChoppy = choppiness < TCFG.breakoutMaxChop;
          // Strong-signal bypass: conf >= 0.75 + all_aligned skips trendPhase check.
          // Per-ticker: breakoutStrictTrendPhase disables this bypass.
          const strongSignalBypass = !TCFG.breakoutStrictTrendPhase && cb.total >= 0.75 && alignment === 'all_aligned';
          // Per-ticker: minimum confidence for breakout entries
          const breakoutConfOk = TCFG.breakoutMinConfidence <= 0 || cb.total >= TCFG.breakoutMinConfidence;
          if (cooldownOk && underLimit && pastWaitPeriod && notTooLate && alignmentOk && (trendPhaseOk || strongSignalBypass) && adxOk && strengthOk && notExhausted && notTooChoppy && breakoutConfOk) {
            const fwd = computeForwardMoves();
            entries.push({
              time: timeStr, timeET, direction, alignment, confidence: cb.total,
              price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
              gateResult: 'PASSED',
            });
            lastBreakoutEntryTs = currentTs;
            breakoutEntryCount++;
            dailyEntryCount++;
            if (fwd.entryGrade === 'F' || fwd.entryGrade === 'D') intradayLosses++;
          }
        } else {
        // Trend mode: apply daily limit and cooldown
        const trendCooldownOk = (currentTs - lastTrendEntryTs) >= TREND_COOLDOWN_MIN * 60_000;
        const trendUnderLimit = trendEntryCount < MAX_TREND_ENTRIES;
        if (!trendCooldownOk || !trendUnderLimit) {
          // Over daily trend limit or in cooldown — skip
        } else if (rangeExhaustion > 7.0 && displacementVelocity < 0) {
          // Late exhausted trend: daily range consumed >7x ATR and momentum reverting — skip.
          // All March trend winners had positive DispVel at high exhaustion; this loser pattern
          // catches trend entries where the move is already done and starting to pull back.
        } else if (rangeExhaustion > TCFG.trendMaxExhaustion) {
          // Extremely extended day: >12x ATR consumed. Regardless of displacement velocity,
          // a move this large has exhausted the daily range. Feb+Mar: 0 winners, 2 losers at >12x.
        } else {
        // Determine gate result
        const htfTf = tfIndicators[2] ?? tfIndicators[0];
        const highConvOverride = cb.total >= 0.92 && alignment === 'all_aligned';

        // Phase-change override: HTF growth cross in signal direction + rising ADX + non-mixed
        // Tightened: require conf >= 0.65, ADX >= 20, positive price action, no near-level penalty
        const growthCross = direction === 'bullish' ? htfTf?.dmi.growthCrossUp : htfTf?.dmi.growthCrossDown;
        const phaseChangeStructural = !!htfTf && cb.total >= 0.65 && alignment !== 'mixed' && growthCross
          && htfTf.dmi.adx >= 20
          && cb.recentPriceActionBonus >= 0
          && cb.nearLevelPenalty > -0.03;
        // Simplified timing checks for phase-change
        let phaseChangeTimingOk = true;
        if (phaseChangeStructural && htfTf) {
          const rp = htfTf.priceStructure.rangePosition;
          if (direction === 'bullish' && rp > 0.85) phaseChangeTimingOk = false;
          if (direction === 'bearish' && rp < 0.15) phaseChangeTimingOk = false;
          if (htfTf.dmi.adx > 50) phaseChangeTimingOk = false;
          // VWAP alignment
          const ltfTf = tfIndicators[0];
          if (ltfTf) {
            const vwapPct = ltfTf.vwap.priceVsVwap;
            if (direction === 'bullish' && vwapPct < -0.30) phaseChangeTimingOk = false;
            if (direction === 'bearish' && vwapPct > 0.30) phaseChangeTimingOk = false;
          }
          // ORB alignment
          if (signal.orb.orbFormed) {
            const orbDir = signal.orb.breakoutDirection;
            if (direction === 'bullish' && orbDir === 'bearish') phaseChangeTimingOk = false;
            if (direction === 'bearish' && orbDir === 'bullish') phaseChangeTimingOk = false;
          }
        }
        const phaseChangeOverride = phaseChangeStructural && phaseChangeTimingOk;

        let gateResult: EntryRecord['gateResult'];
        let stage1ConfValue: number | undefined;

        // Strong-signal bypass: conf >= 75% + all_aligned can skip stage-2.
        // Backtest showed no false positives at this level on losing days,
        // but captures +53.3% and +9.2% entries on trending days.
        const strongSignalBypass = cb.total >= 0.75 && alignment === 'all_aligned';

        if (highConvOverride) {
          gateResult = 'HIGH_CONV_OVERRIDE';
          confirmStage1 = null; // reset after entry
        } else if (!confirmStage1) {
          // No prior stage-1 → this is Stage-1 OBSERVE (or immediate entry if strong)
          if (phaseChangeOverride) {
            gateResult = 'PHASE_CHANGE_OVERRIDE';
            confirmStage1 = null;
          } else if (strongSignalBypass) {
            gateResult = 'PASSED';
            confirmStage1 = null;
            lastEntryTs = currentTs;
          } else {
            gateResult = 'STAGE1_OBSERVE';
            confirmStage1 = { direction, confidence: cb.total, time: timeStr };
          }
        } else {
          // Stage-2: we have a prior stage-1 in the same direction
          stage1ConfValue = confirmStage1.confidence;
          const confDelta = Math.abs(cb.total - confirmStage1.confidence);
          const staleThreshold = Math.min(0.03, Math.max(0.01, (1 - confirmStage1.confidence) * 0.15));

          if (cb.total < confirmStage1.confidence) {
            gateResult = 'WEAKENING_BLOCK';
            // Keep stage-1 alive — next tick can still try stage-2
          } else if (confDelta < staleThreshold) {
            gateResult = 'STALE_BLOCK';
            // Keep stage-1 alive
          } else {
            gateResult = 'PASSED';
            confirmStage1 = null; // reset after confirmed entry
            lastEntryTs = currentTs;
          }
        }

        const fwd = computeForwardMoves();

        // Track trend entries for daily limit/cooldown
        const isConfirmedTrend = gateResult === 'PASSED' || gateResult === 'HIGH_CONV_OVERRIDE' || gateResult === 'PHASE_CHANGE_OVERRIDE';
        if (isConfirmedTrend) {
          lastTrendEntryTs = currentTs;
          trendEntryCount++;
          dailyEntryCount++;
          if (fwd.entryGrade === 'F' || fwd.entryGrade === 'D') intradayLosses++;
        }

        entries.push({
          time: timeStr, timeET, direction, alignment, confidence: cb.total,
          price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
          gateResult, stage1Conf: stage1ConfValue,
        });
      }
      } // end trend limit/cooldown check
      } // end else (trend mode gate)
    }

    // Progress indicator every 30 ticks
    if (tickCount % 30 === 0) {
      process.stdout.write(`  Processed ${tickCount} ticks (${timeET} ET, $${currentPrice.toFixed(2)}, ${direction} ${alignment} conf=${cb.total.toFixed(2)} regime=${regimeScore.toFixed(0)})\n`);
    }


  }

  // ── Step 3: Report ─────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  RESULTS: ${tickCount} ticks processed, ${entries.length} potential entries found`);
  console.log(`${'='.repeat(80)}\n`);

  // Deduplicate consecutive entries (same direction within 5 min = same signal)
  // Within each 5-min window, prefer confirmed entries over blocked ones.
  const isConfirmed = (e: EntryRecord) => e.gateResult === 'PASSED' || e.gateResult === 'HIGH_CONV_OVERRIDE' || e.gateResult === 'PHASE_CHANGE_OVERRIDE';
  const dedupedEntries: EntryRecord[] = [];
  for (const entry of entries) {
    const prev = dedupedEntries[dedupedEntries.length - 1];
    if (prev && prev.direction === entry.direction) {
      const prevTs = new Date(prev.time).getTime();
      const currTs = new Date(entry.time).getTime();
      if (currTs - prevTs < 5 * 60_000) {
        // Within same window: upgrade if current is confirmed but prev was blocked
        if (isConfirmed(entry) && !isConfirmed(prev)) {
          dedupedEntries[dedupedEntries.length - 1] = entry;
        }
        continue;
      }
    }
    dedupedEntries.push(entry);
  }

  // Gate statistics
  const confirmedEntries = dedupedEntries.filter(e => isConfirmed(e));
  const blockedEntries = dedupedEntries.filter(e => !isConfirmed(e));

  // ── Confirmed Entries (what would actually trade) ──
  console.log(`  Confirmed entries: ${confirmedEntries.length} (of ${dedupedEntries.length} signals)\n`);

  for (let i = 0; i < confirmedEntries.length; i++) {
    const e = confirmedEntries[i]!;
    const gradeIcon = { A: '🟢 A', B: '🔵 B', C: '🟡 C', D: '🟠 D', F: '🔴 F' }[e.entryGrade];
    const gateTag = e.gateResult === 'PASSED' ? '🟢 CONFIRMED'
      : e.gateResult === 'HIGH_CONV_OVERRIDE' ? '⚡ HIGH-CONV OVERRIDE'
      : '⚡ PHASE-CHANGE OVERRIDE';
    const modeTag = e.signalMode === 'range' ? ' [RANGE]' : e.signalMode === 'breakout' ? ' [BREAKOUT]' : '';
    const dirTag = e.directionCorrect ? '✅' : '❌';
    console.log(`  Entry #${i + 1}: Grade ${gradeIcon} | ${gateTag}${modeTag}`);
    console.log(`    Time:       ${e.timeET} ET (${e.time.slice(11, 19)} UTC)`);
    console.log(`    Direction:  ${e.direction.toUpperCase()} ${dirTag} | Alignment: ${e.alignment} | Strength: ${e.strengthScore}${e.signalMode === 'range' ? ' | Mode: RANGE' : ''}`);
    console.log(`    Price:      $${e.price.toFixed(2)} | Confidence: ${(e.confidence * 100).toFixed(1)}%${e.stage1Conf !== undefined ? ` (Stage-1 was ${(e.stage1Conf * 100).toFixed(1)}%)` : ''}`);
    console.log(`    ATR: $${e.atr.toFixed(3)} | Regime: ${e.regimeScore ?? '-'} | RangeExh: ${e.rangeExhaustion?.toFixed(1) ?? '-'} | DispVel: ${e.displacementVelocity?.toFixed(3) ?? '-'} | Chop: ${e.choppiness?.toFixed(2) ?? '-'} | TrendStr: ${e.intradayTrendStrength ?? '-'}`);
    // Entry quality (stock-price-based — primary metric)
    console.log(`    Entry Quality: MFE=${e.mfePct.toFixed(2)}% | MAE=${e.maePct.toFixed(2)}% | MFE/MAE=${e.mfeOverMae.toFixed(1)} | Fav=$${e.maxFavorable.toFixed(2)} | Adv=$${e.maxAdverse.toFixed(2)}`);
    // Directional moves at intervals
    const fmtMove = (label: string, pct: number | null, price: number | null) => {
      if (pct === null || price === null) return '';
      return `    ${label}:  $${price.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%)`;
    };
    const moveLines = [
      fmtMove('5m ', e.move5mPct, e.priceAt5m),
      fmtMove('10m', e.move10mPct, e.priceAt10m),
      fmtMove('15m', e.move15mPct, e.priceAt15m),
      fmtMove('30m', e.move30mPct, e.priceAt30m),
    ].filter(l => l);
    if (moveLines.length > 0) console.log(moveLines.join('\n'));
    // Sim trade (secondary — approximate)
    const simIcon = e.sim.pnlPct >= 0 ? '📈' : '📉';
    const simExitTag = e.sim.exitReason === 'TP' ? '🎯 TP'
      : e.sim.exitReason === 'STOP' ? '🛑 STOP'
      : e.sim.exitReason === 'CLOSE' ? '🔔 CLOSE'
      : e.sim.exitReason;
    console.log(`    Sim (approx): ${simIcon} P&L ${e.sim.pnlPct >= 0 ? '+' : ''}${e.sim.pnlPct.toFixed(1)}% | Exit: ${simExitTag} after ${e.sim.holdMinutes}m | Peak: +${e.sim.peakPnlPct.toFixed(1)}% | DD: -${e.sim.maxDrawdownPct.toFixed(1)}%`);
    // Top confidence factors
    const cb = e.breakdown;
    const factors = [
      { name: 'DI Spread', val: cb.diSpreadBonus },
      { name: 'ADX', val: cb.adxBonus },
      { name: 'DI Cross', val: cb.diCrossBonus },
      { name: 'Alignment', val: cb.alignmentBonus },
      { name: 'VWAP', val: cb.vwapBonus },
      { name: 'OBV', val: cb.obvBonus },
      { name: 'Structure', val: cb.structureBonus },
      { name: 'ORB', val: cb.orbBonus },
      { name: 'Price Action', val: cb.recentPriceActionBonus },
      { name: 'Trend Phase', val: cb.trendPhaseBonus },
      { name: 'Momentum', val: cb.momentumAccelBonus },
      { name: 'ADX Maturity', val: cb.adxMaturityPenalty },
      { name: 'TR Contract', val: cb.trContractionPenalty },
      { name: 'Low Vol', val: cb.lowVolPenalty },
      { name: 'Exhaustion', val: cb.moveExhaustionPenalty },
      { name: 'Consolidation', val: cb.consolidationPenalty },
      { name: 'Near Level', val: cb.nearLevelPenalty },
      { name: 'Narrow Range', val: cb.narrowRangePenalty },
    ].filter(f => Math.abs(f.val) >= 0.01);
    const factorStr = factors.map(f => `${f.name}=${f.val >= 0 ? '+' : ''}${f.val.toFixed(3)}`).join(', ');
    console.log(`    Factors:    base=0.380, ${factorStr}`);
    if (e.aiDecision) {
      console.log(`    AI Decision: ${e.aiDecision} (execute=${e.aiShouldExecute}, count=${e.aiConfirmationCount})`);
      const reason = e.aiReasoning ?? '';
      console.log(`    AI Reason:  ${reason.length > 200 ? reason.slice(0, 200) + '...' : reason}`);
    }
    console.log('');
  }

  // ── Entry Quality Summary (PRIMARY — stock-price-based, fully accurate) ──
  const confirmedGood = confirmedEntries.filter(e => e.outcome === 'GOOD').length;
  const confirmedBad = confirmedEntries.filter(e => e.outcome === 'BAD').length;
  const confirmedMarginal = confirmedEntries.length - confirmedGood - confirmedBad;
  const dirCorrectCount = confirmedEntries.filter(e => e.directionCorrect).length;
  const dirAccuracy = confirmedEntries.length > 0 ? (dirCorrectCount / confirmedEntries.length * 100) : 0;
  const avgMfePct = confirmedEntries.length > 0 ? confirmedEntries.reduce((s, e) => s + e.mfePct, 0) / confirmedEntries.length : 0;
  const avgMaePct = confirmedEntries.length > 0 ? confirmedEntries.reduce((s, e) => s + e.maePct, 0) / confirmedEntries.length : 0;
  const avgMfeOverMae = confirmedEntries.length > 0 ? confirmedEntries.reduce((s, e) => s + e.mfeOverMae, 0) / confirmedEntries.length : 0;
  const gradeA = confirmedEntries.filter(e => e.entryGrade === 'A').length;
  const gradeB = confirmedEntries.filter(e => e.entryGrade === 'B').length;
  const gradeC = confirmedEntries.filter(e => e.entryGrade === 'C').length;
  const gradeD = confirmedEntries.filter(e => e.entryGrade === 'D').length;
  const gradeF = confirmedEntries.filter(e => e.entryGrade === 'F').length;

  console.log(`${'─'.repeat(80)}`);
  console.log(`  ENTRY QUALITY (stock-price-based — primary metric)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Entries:      ${confirmedEntries.length} confirmed | ${blockedEntries.length} blocked`);
  console.log(`  Direction:    ${dirCorrectCount}/${confirmedEntries.length} correct (${dirAccuracy.toFixed(0)}%)`);
  console.log(`  Avg MFE:      ${avgMfePct.toFixed(3)}% | Avg MAE: ${avgMaePct.toFixed(3)}% | Avg MFE/MAE: ${avgMfeOverMae.toFixed(1)}`);
  console.log(`  Grades:       🟢 A:${gradeA}  🔵 B:${gradeB}  🟡 C:${gradeC}  🟠 D:${gradeD}  🔴 F:${gradeF}`);
  console.log(`  Outcome:      ✅ ${confirmedGood} good (A+B) | ❌ ${confirmedBad} bad (F) | ⚠️  ${confirmedMarginal} marginal (C+D)`);

  // ── Mode breakdown by entry quality ──
  const rangeEntries = confirmedEntries.filter(e => e.signalMode === 'range');
  const trendEntries = confirmedEntries.filter(e => e.signalMode === 'trend');
  const breakoutEntries = confirmedEntries.filter(e => e.signalMode === 'breakout');
  if (rangeEntries.length > 0 || breakoutEntries.length > 0) {
    const modeSummary = (label: string, entries: typeof confirmedEntries) => {
      const correct = entries.filter(e => e.directionCorrect).length;
      const mfe = entries.reduce((s, e) => s + e.mfePct, 0) / (entries.length || 1);
      const mae = entries.reduce((s, e) => s + e.maePct, 0) / (entries.length || 1);
      const grades = entries.map(e => e.entryGrade).join('');
      return `${label}: ${correct}/${entries.length} dir (${mfe.toFixed(2)}/${mae.toFixed(2)} MFE/MAE) [${grades}]`;
    };
    const parts = [];
    if (rangeEntries.length > 0) parts.push(modeSummary('RANGE', rangeEntries));
    if (breakoutEntries.length > 0) parts.push(modeSummary('BREAKOUT', breakoutEntries));
    if (trendEntries.length > 0) parts.push(modeSummary('TREND', trendEntries));
    console.log(`  By mode:      ${parts.join(' | ')}`);
  }

  // ── Sim Summary (SECONDARY — approximate, option P&L not fully accurate) ──
  const confirmedSims = confirmedEntries.map(e => e.sim);
  const simWins = confirmedSims.filter(s => s.pnlPct > 0).length;
  const simLosses = confirmedSims.filter(s => s.pnlPct <= 0).length;
  const avgPnl = confirmedSims.reduce((sum, s) => sum + s.pnlPct, 0) / (confirmedSims.length || 1);
  const totalPnl = confirmedSims.reduce((sum, s) => sum + s.pnlPct, 0);
  const avgHold = confirmedSims.reduce((sum, s) => sum + s.holdMinutes, 0) / (confirmedSims.length || 1);
  const avgPeak = confirmedSims.reduce((sum, s) => sum + s.peakPnlPct, 0) / (confirmedSims.length || 1);
  const tpExits = confirmedSims.filter(s => s.exitReason === 'TP').length;
  const stopExits = confirmedSims.filter(s => s.exitReason === 'STOP').length;
  const closeExits = confirmedSims.filter(s => s.exitReason === 'CLOSE').length;
  console.log(`\n  SIM (approximate — option premium not fully modeled)`);
  console.log(`  Sim W/L:      ${simWins}W / ${simLosses}L (${confirmedSims.length > 0 ? ((simWins / confirmedSims.length) * 100).toFixed(0) : 0}%) | Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}% | Total: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`);
  console.log(`  Avg hold:     ${avgHold.toFixed(0)}m | Avg peak: +${avgPeak.toFixed(1)}%`);
  console.log(`  Exits:        🎯 TP: ${tpExits} | 🛑 STOP: ${stopExits} | 🔔 CLOSE: ${closeExits}`);

  // ── Blocked signals (brief) ──
  if (blockedEntries.length > 0) {
    const blockedGood = blockedEntries.filter(e => e.outcome === 'GOOD').length;
    const blockedBad = blockedEntries.filter(e => e.outcome === 'BAD').length;
    console.log(`\n  ── Blocked Signals ──`);
    console.log(`  ${blockedEntries.length} blocked (${blockedGood} good missed [A/B], ${blockedBad} bad avoided [F])`);
    for (const blocked of blockedEntries) {
      const gradeIcon = { A: '🟢A', B: '🔵B', C: '🟡C', D: '🟠D', F: '🔴F' }[blocked.entryGrade];
      const outcomeIcon = blocked.outcome === 'GOOD' ? '⚠️  MISSED' : blocked.outcome === 'BAD' ? '✅ AVOIDED' : '── MARGINAL';
      const blockTag = blocked.gateResult === 'STAGE1_OBSERVE' ? 'STAGE-1'
        : blocked.gateResult === 'WEAKENING_BLOCK' ? 'WEAKENING'
        : blocked.gateResult === 'STALE_BLOCK' ? 'STALE' : blocked.gateResult;
      const bcb = blocked.breakdown;
      const bFactors = [
        { name: 'DI Spread', val: bcb.diSpreadBonus }, { name: 'ADX', val: bcb.adxBonus },
        { name: 'DI Cross', val: bcb.diCrossBonus }, { name: 'Alignment', val: bcb.alignmentBonus },
        { name: 'VWAP', val: bcb.vwapBonus }, { name: 'OBV', val: bcb.obvBonus },
        { name: 'Structure', val: bcb.structureBonus }, { name: 'ORB', val: bcb.orbBonus },
        { name: 'PA', val: bcb.recentPriceActionBonus }, { name: 'Trend', val: bcb.trendPhaseBonus },
        { name: 'Mom', val: bcb.momentumAccelBonus }, { name: 'Maturity', val: bcb.adxMaturityPenalty },
        { name: 'Exhaust', val: bcb.moveExhaustionPenalty }, { name: 'Consol', val: bcb.consolidationPenalty },
        { name: 'NearLvl', val: bcb.nearLevelPenalty }, { name: 'LowVol', val: bcb.lowVolPenalty },
        { name: 'NarrowRng', val: bcb.narrowRangePenalty },
      ].filter(f => Math.abs(f.val) >= 0.01);
      const bFactorStr = bFactors.map(f => `${f.name}=${f.val >= 0 ? '+' : ''}${f.val.toFixed(3)}`).join(', ');
      console.log(`     ${blocked.timeET} ET ${blocked.direction} ${blockTag} → ${outcomeIcon} ${gradeIcon} (conf=${(blocked.confidence * 100).toFixed(1)}%, MFE=${blocked.mfePct.toFixed(2)}% MAE=${blocked.maePct.toFixed(2)}%)`);
      console.log(`       Factors: base=0.380, ${bFactorStr}`);
    }
  }

  // Show direction distribution
  const bullishTicks = allTicks.filter(t => t.direction === 'bullish').length;
  const bearishTicks = allTicks.filter(t => t.direction === 'bearish').length;
  const neutralTicks = allTicks.filter(t => t.direction === 'neutral').length;
  console.log(`\n  Direction distribution: ${bullishTicks} bullish, ${bearishTicks} bearish, ${neutralTicks} neutral ticks`);

  // Confidence distribution
  const aboveThreshold = allTicks.filter(t => t.meetsThreshold).length;
  console.log(`  Above threshold (${(MIN_CONFIDENCE * 100).toFixed(0)}%): ${aboveThreshold}/${tickCount} ticks (${(aboveThreshold / tickCount * 100).toFixed(1)}%)`);

  // Show price chart with confirmed entry markers only
  console.log(`\n  Price timeline with confirmed entries:`);
  const step = Math.max(1, Math.floor(allTicks.length / 60)); // ~60 data points
  for (let i = 0; i < allTicks.length; i += step) {
    const tick = allTicks[i]!;
    const entryHere = confirmedEntries.find(e => {
      const eDiff = Math.abs(new Date(e.time).getTime() - new Date(tick.time).getTime());
      return eDiff < step * 60_000;
    });
    const marker = entryHere
      ? ` ${({ A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' })[entryHere.entryGrade]} ${entryHere.entryGrade} MFE=${entryHere.mfePct.toFixed(2)}%`
      : '';
    const dir = tick.direction === 'bullish' ? '▲' : tick.direction === 'bearish' ? '▼' : '─';
    const confBar = '█'.repeat(Math.round(tick.confidence * 20));
    console.log(`    ${tick.timeET} ${dir} $${tick.price.toFixed(2)} [${confBar.padEnd(20)}] ${(tick.confidence * 100).toFixed(0)}%${marker}`);
  }

  console.log(`\n${'='.repeat(80)}\n`);

  if (gradeF > 0) {
    console.log(`  ⚠️  ${gradeF} F-grade entry(s) — wrong direction. Review filters to block these.\n`);
  } else if (gradeD > 0) {
    console.log(`  🟠 ${gradeD} D-grade entry(s) — direction correct but weak move. Consider tighter filters.\n`);
  } else if (confirmedEntries.length > 0) {
    console.log(`  ✅ All confirmed entries graded C or better on ${TARGET_DATE}.\n`);
  } else {
    console.log(`  ── No confirmed entries on ${TARGET_DATE}.\n`);
  }
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
