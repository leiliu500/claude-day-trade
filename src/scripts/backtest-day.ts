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
import type { ConfidenceBreakdown } from '../types/analysis.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { v4 as uuidv4 } from 'uuid';

// ── Config ────────────────────────────────────────────────────────────────────

const TARGET_DATE = process.argv[2] || '2026-03-18';
const TICKER = process.argv[3] || 'SPY';
const PROFILE = 'S' as const; // Scalp: 1m, 3m, 5m
const MIN_CONFIDENCE = config.MIN_CONFIDENCE; // 0.65

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

// ── Confidence computation (extracted from analysis-agent.ts) ─────────────────
// We import the full computeConfidence logic inline to avoid needing the full
// AnalysisAgent class + OpenAI dependency.

function computeConfidence(signal: SignalPayload, option: OptionEvaluation): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, total: 0.38 };
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
  const diSpreadBonus = Math.max(-0.15, Math.min(0.15, (avgDISpread / 40) * 0.15));

  const adxBonus = htf.dmi.adx > 25 ? 0.05 : 0;

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
    diCrossBonus = Math.max(-0.06, Math.min(0.10, diCrossBonus));
  }

  const alignmentBonusMap: Record<string, number> = { all_aligned: 0.06, htf_mtf_aligned: 0.03, mtf_ltf_aligned: 0.02, mixed: 0 };
  const alignmentBonus = alignmentBonusMap[signal.alignment] ?? 0;

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
    if (signal.direction === 'bullish' && rp > 0.5) {
      if (rp >= 0.85 && extremePenaltyApplies) pricePositionAdjustment = -0.12;
      else if (adxMaturityPenalty === 0) pricePositionAdjustment = Math.max(-0.08, -(rp - 0.5) * 0.16);
    } else if (signal.direction === 'bearish' && rp < 0.5) {
      if (rp <= 0.15 && extremePenaltyApplies) pricePositionAdjustment = -0.12;
      else if (adxMaturityPenalty === 0) pricePositionAdjustment = Math.max(-0.08, -(0.5 - rp) * 0.16);
    }
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

      if (lastBarOpposes && priorConfirming >= 2) recentPriceActionBonus = -0.15;
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
      if (htfFreshCrossAligned) lowVolPenalty = 0;
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
      }
    }
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
    // PA does NOT reduce near-level penalty
  }

  // Theta decay — use backtest simulated time (no 0DTE concern for backtest, set to 0)
  const thetaDecayPenalty = 0;

  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty));

  // Hard gates
  if (trContractionPenalty < 0 && recentPriceActionBonus <= 0) total = Math.min(total, 0.60);
  if (adxMaturityPenalty <= -0.15) {
    total = Math.min(total, recentPriceActionBonus > 0 ? 0.64 : 0.55);
  }
  if (recentPriceActionBonus <= -0.15) total = Math.min(total, 0.60);
  if (moveExhaustionPenalty <= -0.06 && consolidationPenalty < 0) total = Math.min(total, 0.58);
  if (moveExhaustionPenalty <= -0.15) total = Math.min(total, 0.60);
  if (adxMaturityPenalty <= -0.08 && moveExhaustionPenalty <= -0.06) total = Math.min(total, 0.62);
  { const rp = htf.priceStructure.rangePosition; const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0; const extremeGateApplies = !strongActiveTrend && htf.dmi.adx >= 15; const atExtreme = (signal.direction === 'bullish' && rp >= 0.85) || (signal.direction === 'bearish' && rp <= 0.15); if (atExtreme && extremeGateApplies) total = Math.min(total, 0.62); const nearExtreme = (signal.direction === 'bullish' && rp >= 0.75) || (signal.direction === 'bearish' && rp <= 0.25); if (nearExtreme && htf.dmi.diSpreadSlope < -3 && htf.dmi.adx >= 15) total = Math.min(total, 0.64); }
  if (thetaDecayPenalty <= -0.10) total = Math.min(total, 0.55);

  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, total };
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
  // Price moves after entry (from remaining bars)
  maxFavorable: number;   // max price move in signal direction
  maxAdverse: number;     // max price move against signal direction
  priceAt5m: number | null;
  priceAt10m: number | null;
  priceAt15m: number | null;
  priceAt30m: number | null;
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  breakdown: ConfidenceBreakdown;
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
  console.log(`  BACKTEST: ${TICKER} on ${TARGET_DATE} (Profile: ${PROFILE}, Threshold: ${MIN_CONFIDENCE})`);
  console.log(`  Walking market hours ${MARKET_OPEN_UTC}–${MARKET_CLOSE_UTC} UTC in 1-min intervals`);
  console.log(`${'='.repeat(80)}\n`);

  // ── Step 1: Fetch historical bars ──────────────────────────────────────────
  // 2 days warmup for indicator computation
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 4); // go back 4 calendar days for 2 trading days
  const startStr = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = TARGET_DATE + 'T23:59:59Z';

  console.log(`Fetching 1m bars: ${startStr} → ${endStr}`);
  const allOneMin = await fetchBarsRange(TICKER, '1m', startStr, endStr);
  console.log(`  → ${allOneMin.length} 1-min bars fetched`);

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

  // ── Step 2: Walk through market hours in 1-min intervals ──────────────────
  const entries: EntryRecord[] = [];
  const allTicks: { time: string; timeET: string; price: number; direction: SignalDirection; alignment: AlignmentType; confidence: number; meetsThreshold: boolean }[] = [];

  // Generate 1-min timestamps from market open to close
  const openTime = new Date(`${TARGET_DATE}T${MARKET_OPEN_UTC}:00Z`);
  const closeTime = new Date(`${TARGET_DATE}T${MARKET_CLOSE_UTC}:00Z`);

  let tickCount = 0;
  for (let t = new Date(openTime); t <= closeTime; t.setMinutes(t.getMinutes() + 1)) {
    const currentTs = t.getTime();
    const timeStr = t.toISOString();
    const timeET = utcToET(timeStr);

    // Slice bars up to current timestamp
    const barsUpTo = allOneMin.filter(b => new Date(b.timestamp).getTime() <= currentTs);
    if (barsUpTo.length < 20) continue; // need minimum bars for indicators

    // Aggregate to 3m and 5m
    const ltfBars = barsUpTo.slice(-500); // 1m bars, last 500
    const mtfBars = aggregate1mBars(allOneMin, '3m', currentTs).slice(-500);
    const htfBars = aggregate1mBars(allOneMin, '5m', currentTs).slice(-500);

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
    const direction: SignalDirection = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral';

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
      triggeredBy: 'AUTO', createdAt: timeStr,
    };

    const optionEval = mockOptionEval(signal);
    const cb = computeConfidence(signal, optionEval);
    const meetsThreshold = cb.total >= MIN_CONFIDENCE;

    tickCount++;
    allTicks.push({ time: timeStr, timeET, price: currentPrice, direction, alignment, confidence: cb.total, meetsThreshold });

    if (meetsThreshold && direction !== 'neutral') {
      // Calculate forward price moves for outcome analysis
      const futureBars = targetDateBars.filter(b => new Date(b.timestamp).getTime() > currentTs);
      let maxFavorable = 0;
      let maxAdverse = 0;

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

      const priceAt5m = findPriceAt(5);
      const priceAt10m = findPriceAt(10);
      const priceAt15m = findPriceAt(15);
      const priceAt30m = findPriceAt(30);

      // Classify outcome: BAD if max adverse > max favorable, or if price moves against within 5-10 min
      const atrPct = atr / currentPrice;
      let outcome: 'GOOD' | 'BAD' | 'MARGINAL' = 'MARGINAL';
      if (maxFavorable > atr * 1.5 && maxFavorable > maxAdverse * 1.5) outcome = 'GOOD';
      else if (maxAdverse > atr * 1.0 && maxAdverse > maxFavorable) outcome = 'BAD';
      // Check 5-min follow-through
      if (priceAt5m !== null) {
        const move5m = direction === 'bullish' ? priceAt5m - currentPrice : currentPrice - priceAt5m;
        if (move5m < -atr * 0.5) outcome = 'BAD';
      }

      entries.push({
        time: timeStr, timeET, direction, alignment, confidence: cb.total,
        price: currentPrice, strengthScore, maxFavorable, maxAdverse,
        priceAt5m, priceAt10m, priceAt15m, priceAt30m, outcome, breakdown: cb,
      });
    }

    // Progress indicator every 30 ticks
    if (tickCount % 30 === 0) {
      process.stdout.write(`  Processed ${tickCount} ticks (${timeET} ET, $${currentPrice.toFixed(2)}, ${direction} ${alignment} conf=${cb.total.toFixed(2)})\n`);
    }
  }

  // ── Step 3: Report ─────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  RESULTS: ${tickCount} ticks processed, ${entries.length} potential entries found`);
  console.log(`${'='.repeat(80)}\n`);

  // Deduplicate consecutive entries (same direction within 5 min = same signal)
  const dedupedEntries: EntryRecord[] = [];
  for (const entry of entries) {
    const prev = dedupedEntries[dedupedEntries.length - 1];
    if (prev && prev.direction === entry.direction) {
      const prevTs = new Date(prev.time).getTime();
      const currTs = new Date(entry.time).getTime();
      if (currTs - prevTs < 5 * 60_000) continue; // skip if same direction within 5 min
    }
    dedupedEntries.push(entry);
  }

  console.log(`  Unique entry signals (deduped within 5-min windows): ${dedupedEntries.length}\n`);

  // Print each entry
  for (let i = 0; i < dedupedEntries.length; i++) {
    const e = dedupedEntries[i]!;
    const tag = e.outcome === 'BAD' ? '❌ BAD' : e.outcome === 'GOOD' ? '✅ GOOD' : '⚠️  MARGINAL';
    console.log(`  Entry #${i + 1}: ${tag}`);
    console.log(`    Time:       ${e.timeET} ET (${e.time.slice(11, 19)} UTC)`);
    console.log(`    Direction:  ${e.direction.toUpperCase()} | Alignment: ${e.alignment} | Strength: ${e.strengthScore}`);
    console.log(`    Price:      $${e.price.toFixed(2)} | Confidence: ${(e.confidence * 100).toFixed(1)}%`);
    console.log(`    Forward:    max favorable=$${e.maxFavorable.toFixed(2)}, max adverse=$${e.maxAdverse.toFixed(2)}`);
    if (e.priceAt5m !== null) {
      const m5 = e.direction === 'bullish' ? e.priceAt5m - e.price : e.price - e.priceAt5m;
      console.log(`    5m later:   $${e.priceAt5m.toFixed(2)} (${m5 >= 0 ? '+' : ''}${m5.toFixed(2)})`);
    }
    if (e.priceAt10m !== null) {
      const m10 = e.direction === 'bullish' ? e.priceAt10m - e.price : e.price - e.priceAt10m;
      console.log(`    10m later:  $${e.priceAt10m.toFixed(2)} (${m10 >= 0 ? '+' : ''}${m10.toFixed(2)})`);
    }
    if (e.priceAt15m !== null) {
      const m15 = e.direction === 'bullish' ? e.priceAt15m - e.price : e.price - e.priceAt15m;
      console.log(`    15m later:  $${e.priceAt15m.toFixed(2)} (${m15 >= 0 ? '+' : ''}${m15.toFixed(2)})`);
    }
    if (e.priceAt30m !== null) {
      const m30 = e.direction === 'bullish' ? e.priceAt30m - e.price : e.price - e.priceAt30m;
      console.log(`    30m later:  $${e.priceAt30m.toFixed(2)} (${m30 >= 0 ? '+' : ''}${m30.toFixed(2)})`);
    }
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
    ].filter(f => Math.abs(f.val) >= 0.01);
    const factorStr = factors.map(f => `${f.name}=${f.val >= 0 ? '+' : ''}${f.val.toFixed(3)}`).join(', ');
    console.log(`    Factors:    base=0.380, ${factorStr}`);
    console.log('');
  }

  // Summary
  const goodCount = dedupedEntries.filter(e => e.outcome === 'GOOD').length;
  const badCount = dedupedEntries.filter(e => e.outcome === 'BAD').length;
  const marginalCount = dedupedEntries.filter(e => e.outcome === 'MARGINAL').length;

  console.log(`${'─'.repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log(`  Total unique entries: ${dedupedEntries.length}`);
  console.log(`  ✅ Good:     ${goodCount}`);
  console.log(`  ⚠️  Marginal: ${marginalCount}`);
  console.log(`  ❌ Bad:      ${badCount}`);
  console.log(`  Win rate:    ${dedupedEntries.length > 0 ? ((goodCount / dedupedEntries.length) * 100).toFixed(0) : 0}% good, ${dedupedEntries.length > 0 ? ((badCount / dedupedEntries.length) * 100).toFixed(0) : 0}% bad`);

  // Show ticks above threshold that were NOT entries (direction neutral)
  const neutralAboveThreshold = allTicks.filter(t => t.meetsThreshold && t.direction === 'neutral');
  if (neutralAboveThreshold.length > 0) {
    console.log(`\n  ⚪ ${neutralAboveThreshold.length} ticks above threshold but NEUTRAL direction (correctly skipped)`);
  }

  // Show direction distribution
  const bullishTicks = allTicks.filter(t => t.direction === 'bullish').length;
  const bearishTicks = allTicks.filter(t => t.direction === 'bearish').length;
  const neutralTicks = allTicks.filter(t => t.direction === 'neutral').length;
  console.log(`\n  Direction distribution: ${bullishTicks} bullish, ${bearishTicks} bearish, ${neutralTicks} neutral ticks`);

  // Confidence distribution
  const aboveThreshold = allTicks.filter(t => t.meetsThreshold).length;
  console.log(`  Above threshold (${(MIN_CONFIDENCE * 100).toFixed(0)}%): ${aboveThreshold}/${tickCount} ticks (${(aboveThreshold / tickCount * 100).toFixed(1)}%)`);

  // Show price chart with entry markers
  console.log(`\n  Price timeline with entries:`);
  const step = Math.max(1, Math.floor(allTicks.length / 60)); // ~60 data points
  for (let i = 0; i < allTicks.length; i += step) {
    const tick = allTicks[i]!;
    const entryHere = dedupedEntries.find(e => {
      const eDiff = Math.abs(new Date(e.time).getTime() - new Date(tick.time).getTime());
      return eDiff < step * 60_000;
    });
    const marker = entryHere
      ? (entryHere.outcome === 'BAD' ? ' ❌' : entryHere.outcome === 'GOOD' ? ' ✅' : ' ⚠️')
      : '';
    const dir = tick.direction === 'bullish' ? '▲' : tick.direction === 'bearish' ? '▼' : '─';
    const confBar = '█'.repeat(Math.round(tick.confidence * 20));
    console.log(`    ${tick.timeET} ${dir} $${tick.price.toFixed(2)} [${confBar.padEnd(20)}] ${(tick.confidence * 100).toFixed(0)}%${marker}`);
  }

  console.log(`\n${'='.repeat(80)}\n`);

  if (badCount > 0) {
    console.log(`  ⚠️  ${badCount} BAD ENTRY(S) DETECTED — review confidence factors above for tuning opportunities.\n`);
  } else {
    console.log(`  ✅ No bad entries detected on ${TARGET_DATE}.\n`);
  }
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
