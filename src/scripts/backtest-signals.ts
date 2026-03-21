/**
 * backtest-signals.ts — Multi-day signal & confidence backtest.
 *
 * Fetches all 1m bars for a ticker over a date range, walks market hours
 * minute-by-minute, computes signal indicators + confidence at each step,
 * and reports:
 *   (1) All intervals that would have triggered entries (conf >= MIN_CONFIDENCE)
 *   (2) Days/intervals with no bad entries (losing signals)
 *
 * Option P&L estimated via delta × underlying move (no historical option data).
 *
 * Usage:
 *   npx tsx src/scripts/backtest-signals.ts [START_DATE] [END_DATE] [TICKER]
 *
 * Defaults: 2026-03-02 to 2026-03-19, SPY
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
import type { OptionEvaluation } from '../types/options.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { v4 as uuidv4 } from 'uuid';

// ── Config ────────────────────────────────────────────────────────────────────

const START_DATE = process.argv[2] || '2026-03-02';
const END_DATE = process.argv[3] || '2026-03-19';
const TICKER = process.argv[4] || 'SPY';
const PROFILE = 'S' as const;
const MIN_CONFIDENCE = config.MIN_CONFIDENCE;
const MARKET_OPEN_UTC = 13 * 60 + 30;   // 13:30 UTC = 9:30 ET
const MARKET_CLOSE_UTC = 20 * 60;       // 20:00 UTC = 16:00 ET
const ASSUMED_DELTA = 0.50;
const ASSUMED_OPTION_PREMIUM = 4.00;

// ── Alpaca REST ───────────────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string, timeframe: Timeframe, start: string, end: string,
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
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    allBars.push(...normalizeAlpacaBars(data));
    if (data.next_page_token) pageToken = data.next_page_token; else break;
  }
  return allBars;
}

// ── Bar aggregation ──────────────────────────────────────────────────────────

function aggregate1mBars(oneMins: OHLCVBar[], timeframe: Timeframe, upToTs: number): OHLCVBar[] {
  const n = { '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }[timeframe] ?? 1;
  if (n <= 1) return oneMins.filter(b => new Date(b.timestamp).getTime() <= upToTs);
  const bucketMs = n * 60_000;
  const currentBucket = Math.floor(upToTs / bucketMs) * bucketMs;
  const groups = new Map<number, OHLCVBar[]>();
  for (const bar of oneMins) {
    const ts = new Date(bar.timestamp).getTime();
    if (ts > upToTs) continue;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue;
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

// ── Indicator computation ────────────────────────────────────────────────────

function computeTimeframeIndicators(
  bars: OHLCVBar[], timeframe: Timeframe, direction: 'bullish' | 'bearish' | 'neutral' = 'neutral',
): TimeframeIndicators {
  const skipGaps = timeframe !== '1d';
  return {
    timeframe, bars,
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

// ── Confidence (same as analysis-agent.ts) ───────────────────────────────────

function computeConfidence(signal: SignalPayload, option: OptionEvaluation): ConfidenceBreakdown {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) {
    return { base: 0.38, diSpreadBonus: 0, adxBonus: 0, diCrossBonus: 0, alignmentBonus: 0, tdAdjustment: 0, obvBonus: 0, vwapBonus: 0, oiVolumeBonus: 0, pricePositionAdjustment: 0, adxMaturityPenalty: 0, trendPhaseBonus: 0, momentumAccelBonus: 0, structureBonus: 0, orbBonus: 0, recentPriceActionBonus: 0, trContractionPenalty: 0, lowVolPenalty: 0, moveExhaustionPenalty: 0, consolidationPenalty: 0, nearLevelPenalty: 0, thetaDecayPenalty: 0, narrowRangePenalty: 0, total: 0.38 };
  }

  const base = 0.38;
  const avgDISpread = signal.direction === 'neutral' ? 0
    : tfs.reduce((sum, tf) => {
        const spread = signal.direction === 'bullish' ? tf.dmi.plusDI - tf.dmi.minusDI : tf.dmi.minusDI - tf.dmi.plusDI;
        return sum + spread;
      }, 0) / tfs.length;
  const diSpreadBonus = Math.max(-0.15, Math.min(0.15, (avgDISpread / 40) * 0.15));
  const adxBonus = htf.dmi.adx > 25 ? 0.05 : 0;
  let diCrossBonus = 0;
  if (signal.direction !== 'neutral') {
    if (signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown) diCrossBonus += 0.05;
    if (signal.direction === 'bullish' ? mtf.dmi.crossedUp : mtf.dmi.crossedDown) diCrossBonus += 0.03;
    if (signal.direction === 'bullish' ? htf.dmi.crossedDown : htf.dmi.crossedUp) diCrossBonus -= 0.05;
    if (signal.direction === 'bullish' ? mtf.dmi.crossedDown : mtf.dmi.crossedUp) diCrossBonus -= 0.03;
    if (signal.direction === 'bullish' ? htf.dmi.growthCrossUp : htf.dmi.growthCrossDown) diCrossBonus += 0.04;
    if (diCrossBonus > 0 && htf.dmi.adx < 20 && htf.dmi.adxSlope <= 0) diCrossBonus *= 0.50;
    diCrossBonus = Math.max(-0.06, Math.min(0.10, diCrossBonus));
  }
  const alignmentBonus = ({ all_aligned: 0.06, htf_mtf_aligned: 0.03, mtf_ltf_aligned: 0.02, mixed: 0 } as Record<string, number>)[signal.alignment] ?? 0;
  let tdAdjustment = 0;
  for (const tf of tfs) {
    const setup = tf.td.setup;
    const confirmDir = signal.direction === 'bullish' ? 'buy' : 'sell';
    const opposingDir = signal.direction === 'bullish' ? 'sell' : 'buy';
    if (setup.completed && setup.completedDirection === opposingDir) tdAdjustment -= 0.01;
    else if (!setup.completed && setup.direction === confirmDir) { if (setup.count >= 7) tdAdjustment += 0.01; else if (setup.count >= 5) tdAdjustment += 0.005; }
    else if (setup.direction === opposingDir && setup.count >= 7) tdAdjustment -= 0.005;
  }
  tdAdjustment = Math.max(-0.015, Math.min(0.02, tdAdjustment));
  let obvBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      if (tf.obv.trend === signal.direction) obvBonus += 0.03;
      if ((signal.direction === 'bullish' && tf.obv.divergence === 'bearish') || (signal.direction === 'bearish' && tf.obv.divergence === 'bullish')) obvBonus -= 0.02;
    }
    obvBonus = Math.max(-0.04, Math.min(0.06, obvBonus));
  }
  let vwapBonus = 0;
  if (signal.direction !== 'neutral') {
    for (const tf of [htf, mtf]) {
      const pvv = tf.vwap.priceVsVwap;
      if (signal.direction === 'bullish') { if (pvv > 0) vwapBonus += 0.04; else if (pvv < -0.2) vwapBonus -= 0.04; }
      else { if (pvv < 0) vwapBonus += 0.04; else if (pvv > 0.2) vwapBonus -= 0.04; }
    }
    const { vwap: htfVwap, upperBand: htfUpper, lowerBand: htfLower, deviation: htfDev } = htf.vwap;
    const htfPrice = htf.currentPrice;
    const beyond2sig = htf.dmi.adx > 35 ? -0.03 : -0.10;
    if (signal.direction === 'bullish') { if (htfPrice > htfUpper) vwapBonus += beyond2sig; else if (htfPrice > htfVwap + htfDev) vwapBonus += -0.02; }
    else { if (htfPrice < htfLower) vwapBonus += beyond2sig; else if (htfPrice < htfVwap - htfDev) vwapBonus += -0.02; }
    if (vwapBonus > 0 && htf.dmi.diSpreadSlope < -2) vwapBonus = 0;
    vwapBonus = Math.max(-0.12, Math.min(0.10, vwapBonus));
  }
  const oiVolumeBonus = 0;
  let adxMaturityPenalty = 0;
  const htfFreshCross = signal.direction === 'bullish' ? htf.dmi.crossedUp : htf.dmi.crossedDown;
  if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 20) adxMaturityPenalty = -0.15;
  else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 15) adxMaturityPenalty = -0.12;
  else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 10) adxMaturityPenalty = -0.08;
  else if (!htfFreshCross && htf.dmi.adxBarsAbove25 >= 5) adxMaturityPenalty = -0.04;
  let trendPhaseBonus = 0;
  if (signal.direction !== 'neutral' && (htf.dmi.adx >= 15 || (htf.dmi.adx >= 10 && htf.dmi.adxSlope > 3))) {
    if (htf.dmi.adxSlope > 2) { trendPhaseBonus += 0.04; if (mtf.dmi.adxSlope > 1) trendPhaseBonus += 0.02; }
    else if (htf.dmi.adxSlope > 0.5) trendPhaseBonus += 0.02;
    else if (htf.dmi.adxSlope < -2) { trendPhaseBonus -= 0.06; if (mtf.dmi.adxSlope < -1) trendPhaseBonus -= 0.02; }
    else if (htf.dmi.adxSlope < -0.5) trendPhaseBonus -= 0.03;
    trendPhaseBonus = Math.max(-0.08, Math.min(0.06, trendPhaseBonus));
  }
  let momentumAccelBonus = 0;
  const isExhaustingTrend = adxMaturityPenalty < 0 && trendPhaseBonus < 0;
  if (signal.direction !== 'neutral') {
    const htfDirSpreadNow = signal.direction === 'bullish' ? htf.dmi.plusDI - htf.dmi.minusDI : htf.dmi.minusDI - htf.dmi.plusDI;
    if (htfDirSpreadNow > 0 && htf.dmi.diSpreadSlope > 2) { momentumAccelBonus += 0.03; if (mtf.dmi.diSpreadSlope > 1) momentumAccelBonus += 0.02; }
    else if (htfDirSpreadNow > 0 && htf.dmi.diSpreadSlope > 0.5) momentumAccelBonus += 0.02;
    else if (htf.dmi.diSpreadSlope < -2) { momentumAccelBonus -= 0.04; if (mtf.dmi.diSpreadSlope < -1) momentumAccelBonus -= 0.02; }
    else if (htf.dmi.diSpreadSlope < -0.5) momentumAccelBonus -= 0.02;
    if (isExhaustingTrend && momentumAccelBonus > 0) momentumAccelBonus = 0;
    momentumAccelBonus = Math.max(-0.06, Math.min(0.05, momentumAccelBonus));
  }
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
  let structureBonus = 0;
  if (signal.direction !== 'neutral' && signal.priorDayLevels.pdh > 0) {
    const { abovePDH, belowPDL, pdc, priceVsPDH, priceVsPDL } = signal.priorDayLevels;
    const price = signal.currentPrice;
    if (signal.direction === 'bullish') { if (abovePDH) structureBonus = priceVsPDH < 0.10 ? 0.02 : 0.06; else if (price > pdc) structureBonus = 0.02; else if (belowPDL) structureBonus = -0.08; }
    else { if (belowPDL) structureBonus = Math.abs(priceVsPDL) < 0.10 ? 0.02 : 0.06; else if (price < pdc) structureBonus = 0.02; else if (abovePDH) structureBonus = -0.08; }
    structureBonus = Math.max(-0.08, Math.min(0.06, structureBonus));
  }
  let orbBonus = 0;
  if (signal.direction !== 'neutral' && signal.orb.orbFormed) {
    const { breakoutDirection, breakoutStrength } = signal.orb;
    if (breakoutDirection === signal.direction) orbBonus = breakoutStrength < 0.25 ? 0.02 : 0.06;
    else if (breakoutDirection !== 'none' && breakoutDirection !== signal.direction) orbBonus = -0.08;
    orbBonus = Math.max(-0.08, Math.min(0.06, orbBonus));
  }
  let recentPriceActionBonus = 0;
  if (signal.direction !== 'neutral' && ltf && ltf.bars.length >= 4) {
    const bars = ltf.bars;
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
  let trContractionPenalty = 0;
  if (signal.direction !== 'neutral' && ltf && ltf.bars.length >= 14) {
    const window = ltf.bars.slice(-14);
    const trValues: number[] = [];
    for (let i = 1; i < window.length; i++) {
      const curr = window[i]!; const prev = window[i - 1]!;
      trValues.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    }
    const baselineTR = trValues.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const recentTR = trValues.slice(-3).reduce((a, b) => a + b, 0) / 3;
    if (baselineTR > 0) { const r = recentTR / baselineTR; if (r < 0.50) trContractionPenalty = -0.08; else if (r < 0.70) trContractionPenalty = -0.05; }
  }
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
  let moveExhaustionPenalty = 0;
  if (signal.direction !== 'neutral' && !htfFreshCross && htf.bars.length >= 6) {
    const recentHTF = htf.bars.slice(-5); const htfATR = htf.atr.atr;
    if (htfATR > 0) {
      let maxHigh = -Infinity, minLow = Infinity;
      for (const bar of recentHTF) { if (bar.high > maxHigh) maxHigh = bar.high; if (bar.low < minLow) minLow = bar.low; }
      const moveInDir = signal.direction === 'bearish' ? recentHTF[0]!.high - recentHTF[recentHTF.length - 1]!.low : recentHTF[recentHTF.length - 1]!.high - recentHTF[0]!.low;
      if (moveInDir > 0) { const m = moveInDir / htfATR; if (m >= 2.5) moveExhaustionPenalty = -0.15; else if (m >= 1.5) moveExhaustionPenalty = -0.10; else if (m >= 1.0) moveExhaustionPenalty = -0.06; }
    }
  }
  let consolidationPenalty = 0;
  if (signal.direction !== 'neutral' && ltf && ltf.bars.length >= 8) {
    const chopBars = ltf.bars.slice(-6);
    const totalBarRange = chopBars.reduce((sum, b) => sum + (b.high - b.low), 0);
    let oH = -Infinity, oL = Infinity;
    for (const b of chopBars) { if (b.high > oH) oH = b.high; if (b.low < oL) oL = b.low; }
    const oR = oH - oL;
    if (oR > 0) { const r = totalBarRange / oR; if (r >= 3.0) consolidationPenalty = -0.10; else if (r >= 2.5) consolidationPenalty = -0.06; else if (r >= 2.0) consolidationPenalty = -0.03; }
  }
  let nearLevelPenalty = 0;
  if (signal.direction !== 'neutral') {
    const ps = htf.priceStructure; const price = signal.currentPrice;
    if (signal.direction === 'bearish') {
      const d = ps.swingLow > 0 ? ((price - ps.swingLow) / ps.swingLow) * 100 : 999;
      if (d > 0 && d <= 0.15) nearLevelPenalty = -0.10; else if (d > 0 && d <= 0.30) nearLevelPenalty = -0.06; else if (d > 0 && d <= 0.50) nearLevelPenalty = -0.03;
    } else {
      const d = ps.swingHigh > 0 ? ((ps.swingHigh - price) / ps.swingHigh) * 100 : 999;
      if (d > 0 && d <= 0.15) nearLevelPenalty = -0.10; else if (d > 0 && d <= 0.30) nearLevelPenalty = -0.06; else if (d > 0 && d <= 0.50) nearLevelPenalty = -0.03;
    }
  }
  const thetaDecayPenalty = 0;
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
  let total = Math.max(0, Math.min(1, base + diSpreadBonus + adxBonus + diCrossBonus + alignmentBonus + tdAdjustment + obvBonus + vwapBonus + oiVolumeBonus + pricePositionAdjustment + adxMaturityPenalty + trendPhaseBonus + momentumAccelBonus + structureBonus + orbBonus + recentPriceActionBonus + trContractionPenalty + lowVolPenalty + moveExhaustionPenalty + consolidationPenalty + nearLevelPenalty + thetaDecayPenalty + narrowRangePenalty));
  // Hard gates
  if (trContractionPenalty < 0 && recentPriceActionBonus <= 0) total = Math.min(total, 0.60);
  if (adxMaturityPenalty <= -0.15) total = Math.min(total, recentPriceActionBonus > 0 ? 0.64 : 0.55);
  if (recentPriceActionBonus <= -0.15) total = Math.min(total, 0.60);
  if (moveExhaustionPenalty <= -0.06 && consolidationPenalty < 0) total = Math.min(total, 0.58);
  if (moveExhaustionPenalty <= -0.15) total = Math.min(total, 0.60);
  if (adxMaturityPenalty <= -0.08 && moveExhaustionPenalty <= -0.06) total = Math.min(total, 0.62);
  if (narrowRangePenalty <= -0.08 && pricePositionAdjustment <= -0.04) total = Math.min(total, 0.60);
  {
    const rp = htf.priceStructure.rangePosition;
    const strongActiveTrend = htf.dmi.adx > 25 && htf.dmi.adxSlope > 0;
    const extremeGateApplies = !strongActiveTrend && htf.dmi.adx >= 15;
    const atExtreme = (signal.direction === 'bullish' && rp >= 0.85) || (signal.direction === 'bearish' && rp <= 0.15);
    if (atExtreme && extremeGateApplies) total = Math.min(total, 0.62);
    const nearExtreme = (signal.direction === 'bullish' && rp >= 0.75) || (signal.direction === 'bearish' && rp <= 0.25);
    if (nearExtreme && htf.dmi.diSpreadSlope < -3 && htf.dmi.adx >= 15) total = Math.min(total, 0.64);
  }
  return { base, diSpreadBonus, adxBonus, diCrossBonus, alignmentBonus, tdAdjustment, obvBonus, vwapBonus, oiVolumeBonus, pricePositionAdjustment, adxMaturityPenalty, trendPhaseBonus, momentumAccelBonus, structureBonus, orbBonus, recentPriceActionBonus, trContractionPenalty, lowVolPenalty, moveExhaustionPenalty, consolidationPenalty, nearLevelPenalty, thetaDecayPenalty, narrowRangePenalty, total };
}

function mockOptionEval(signal: SignalPayload): OptionEvaluation {
  return {
    signalId: signal.id, ticker: signal.ticker, evaluatedAt: signal.createdAt,
    desiredSide: signal.direction === 'bearish' ? 'put' : 'call',
    callCandidate: null, putCandidate: null,
    winner: signal.direction === 'bearish' ? 'put' : 'call',
    winnerCandidate: null, selectionReason: 'Backtest mock',
    liquidityOk: true, candidatePass: true,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function utcToET(utcTime: string): string {
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4);
  return d.toISOString().slice(11, 16);
}

function isWeekday(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow >= 1 && dow <= 5;
}

function getTradingDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  while (d <= endD) {
    if (isWeekday(d)) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ── Entry outcome simulation ─────────────────────────────────────────────────

interface DmiSnapshot {
  trend: string;
  adx: number;
  plusDI: number;
  minusDI: number;
  adxSlope: number;
  diSpreadSlope: number;
  adxBarsAbove25: number;
  crossedUp: boolean;
  crossedDown: boolean;
  recentCrossUp: boolean;
  recentCrossDown: boolean;
  growthCrossUp: boolean;
  growthCrossDown: boolean;
}

interface EntrySignal {
  date: string;
  time: string;
  timeET: string;
  price: number;
  direction: SignalDirection;
  alignment: AlignmentType;
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  atr: number;
  adx: number;
  // DMI snapshots per timeframe
  ltfDmi: DmiSnapshot;
  mtfDmi: DmiSnapshot;
  htfDmi: DmiSnapshot;
  // Price context
  priorBars: { time: string; o: number; h: number; l: number; c: number }[];  // last 5 1m bars before entry
  futureBarsSnap: { time: string; o: number; h: number; l: number; c: number }[];  // first 15 1m bars after entry
  // Structure context
  orbFormed: boolean;
  orbBreakoutDir: string;
  pdh: number;
  pdl: number;
  pdc: number;
  rangePosition: number;
  swingHigh: number;
  swingLow: number;
  // Forward-looking outcome
  outcome: 'winner' | 'loser' | 'scratch';
  maxFavorable: number;    // max % move in direction within 15 min
  maxAdverse: number;      // max % move against within 15 min
  pnl15m: number;          // P&L % at +15 min
  pnl30m: number;          // P&L % at +30 min
  optionPnl15m: number;    // estimated option P&L %
}

function evaluateOutcome(
  entryPrice: number, direction: SignalDirection, futureBars: OHLCVBar[],
): { outcome: 'winner' | 'loser' | 'scratch'; maxFavorable: number; maxAdverse: number; pnl15m: number; pnl30m: number; optionPnl15m: number } {
  let maxFav = 0, maxAdv = 0;
  const sign = direction === 'bullish' ? 1 : -1;

  for (let i = 0; i < Math.min(futureBars.length, 15); i++) {
    const bar = futureBars[i]!;
    const bestMove = sign * (direction === 'bullish' ? bar.high - entryPrice : entryPrice - bar.low);
    const worstMove = sign * (direction === 'bullish' ? bar.low - entryPrice : entryPrice - bar.high);
    const bestPct = (bestMove / entryPrice) * 100;
    const worstPct = (worstMove / entryPrice) * 100;
    if (bestPct > maxFav) maxFav = bestPct;
    if (-worstPct > maxAdv) maxAdv = -worstPct;
  }

  const bar15 = futureBars[Math.min(14, futureBars.length - 1)];
  const bar30 = futureBars[Math.min(29, futureBars.length - 1)];
  const pnl15m = bar15 ? ((sign * (bar15.close - entryPrice)) / entryPrice) * 100 : 0;
  const pnl30m = bar30 ? ((sign * (bar30.close - entryPrice)) / entryPrice) * 100 : 0;

  // Option P&L: delta × underlying move / option premium
  const optionPnl15m = bar15
    ? ((sign * (bar15.close - entryPrice) * ASSUMED_DELTA) / ASSUMED_OPTION_PREMIUM) * 100
    : 0;

  const outcome = optionPnl15m >= 2 ? 'winner' : optionPnl15m <= -2 ? 'loser' : 'scratch';
  return { outcome, maxFavorable: maxFav, maxAdverse: maxAdv, pnl15m, pnl30m, optionPnl15m };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  MULTI-DAY SIGNAL BACKTEST: ${TICKER} | ${START_DATE} → ${END_DATE}`);
  console.log(`  Walking market hours in 1-min intervals, computing confidence at each step`);
  console.log(`  MIN_CONFIDENCE threshold: ${(MIN_CONFIDENCE * 100).toFixed(0)}%`);
  console.log(`${'='.repeat(90)}\n`);

  const tradingDays = getTradingDays(START_DATE, END_DATE);
  console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} → ${tradingDays[tradingDays.length - 1]})\n`);

  // Fetch all data upfront — warmup bars start 5 days before START_DATE
  const warmupStart = new Date(START_DATE + 'T00:00:00Z');
  warmupStart.setUTCDate(warmupStart.getUTCDate() - 7);
  const fetchStart = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const fetchEnd = END_DATE + 'T23:59:59Z';

  console.log(`  Fetching 1m bars (${fetchStart.slice(0, 10)} → ${END_DATE})...`);
  const allOneMin = await fetchBarsRange(TICKER, '1m', fetchStart, fetchEnd);
  console.log(`  Fetching daily bars...`);
  const dailyBars = await fetchBarsRange(TICKER, '1d', fetchStart, fetchEnd);
  console.log(`  Total: ${allOneMin.length} 1m bars, ${dailyBars.length} daily bars\n`);

  // Process each day
  const allEntries: EntrySignal[] = [];
  const daySummaries: { date: string; entries: number; winners: number; losers: number; scratches: number; dayMove: string }[] = [];

  for (const date of tradingDays) {
    const dateBars = allOneMin.filter(b => b.timestamp.startsWith(date));
    if (dateBars.length === 0) {
      console.log(`  ${date}: NO DATA (holiday?)`);
      continue;
    }

    const dayOpen = dateBars[0]!.open;
    const dayClose = dateBars[dateBars.length - 1]!.close;
    const dayMovePct = ((dayClose - dayOpen) / dayOpen * 100).toFixed(2);

    const openMs = new Date(`${date}T00:00:00Z`).getTime() + MARKET_OPEN_UTC * 60_000;
    const closeMs = new Date(`${date}T00:00:00Z`).getTime() + MARKET_CLOSE_UTC * 60_000;

    const dayEntries: EntrySignal[] = [];
    let minutesProcessed = 0;

    for (let tMs = openMs; tMs <= closeMs; tMs += 60_000) {
      minutesProcessed++;
      const barsUpTo = allOneMin.filter(b => new Date(b.timestamp).getTime() <= tMs);
      if (barsUpTo.length < 20) continue;

      const ltfBars = barsUpTo.slice(-500);
      const mtfBars = aggregate1mBars(allOneMin, '3m', tMs).slice(-500);
      const htfBars = aggregate1mBars(allOneMin, '5m', tMs).slice(-500);
      if (ltfBars.length < 14 || mtfBars.length < 14 || htfBars.length < 14) continue;

      const dmiOnly = [computeDMI(ltfBars, 14, true), computeDMI(mtfBars, 14, true), computeDMI(htfBars, 14, true)];
      const bullish = dmiOnly.filter(d => d.trend === 'bullish').length;
      const bearish = dmiOnly.filter(d => d.trend === 'bearish').length;
      const direction: SignalDirection = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral';
      if (direction === 'neutral') continue;

      const tfIndicators: TimeframeIndicators[] = [
        computeTimeframeIndicators(ltfBars, '1m', direction),
        computeTimeframeIndicators(mtfBars, '3m', direction),
        computeTimeframeIndicators(htfBars, '5m', direction),
      ];
      const alignment = classifyAlignment(tfIndicators, direction);
      const currentPrice = ltfBars[ltfBars.length - 1]!.close;
      const atr = tfIndicators[2]?.atr.atr ?? tfIndicators[0]?.atr.atr ?? 0;
      const htfAdx = tfIndicators[2]?.dmi.adx ?? 0;
      const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
      const orb = computeORB(ltfBars, currentPrice);
      const timeStr = new Date(tMs).toISOString();

      const signal: SignalPayload = {
        id: uuidv4(), ticker: TICKER, profile: PROFILE,
        timeframes: tfIndicators, ltf: '1m', mtf: '3m', htf: '5m',
        direction, alignment, currentPrice, atr, atm: Math.round(currentPrice),
        strengthScore: Math.min(100, Math.round(htfAdx * 2)),
        priorDayLevels, orb, triggeredBy: 'AUTO', createdAt: timeStr,
      };
      const cb = computeConfidence(signal, mockOptionEval(signal));

      if (cb.total >= MIN_CONFIDENCE) {
        // Dedup: skip if same direction within 5 min of last entry
        const prev = dayEntries[dayEntries.length - 1];
        if (prev && prev.direction === direction && tMs - new Date(prev.time).getTime() < 5 * 60_000) continue;

        // Evaluate forward outcome
        const futureBars = allOneMin.filter(b => {
          const bTs = new Date(b.timestamp).getTime();
          return bTs > tMs && bTs <= closeMs;
        });
        const oc = evaluateOutcome(currentPrice, direction, futureBars);

        // Capture DMI snapshots
        const snapDmi = (tf: TimeframeIndicators): DmiSnapshot => ({
          trend: tf.dmi.trend, adx: tf.dmi.adx, plusDI: tf.dmi.plusDI, minusDI: tf.dmi.minusDI,
          adxSlope: tf.dmi.adxSlope, diSpreadSlope: tf.dmi.diSpreadSlope,
          adxBarsAbove25: tf.dmi.adxBarsAbove25,
          crossedUp: tf.dmi.crossedUp, crossedDown: tf.dmi.crossedDown,
          recentCrossUp: tf.dmi.recentCrossUp, recentCrossDown: tf.dmi.recentCrossDown,
          growthCrossUp: tf.dmi.growthCrossUp, growthCrossDown: tf.dmi.growthCrossDown,
        });
        // Capture prior bars (last 5 before entry)
        const priorBarsRaw = ltfBars.slice(-5);
        const priorBars = priorBarsRaw.map(b => ({ time: utcToET(b.timestamp), o: b.open, h: b.high, l: b.low, c: b.close }));
        // Capture future bars (first 15 after entry)
        const futureBarsSnap = futureBars.slice(0, 15).map(b => ({ time: utcToET(b.timestamp), o: b.open, h: b.high, l: b.low, c: b.close }));

        dayEntries.push({
          date, time: timeStr, timeET: utcToET(timeStr),
          price: currentPrice, direction, alignment, confidence: cb.total,
          confidenceBreakdown: cb, atr, adx: htfAdx,
          ltfDmi: snapDmi(tfIndicators[0]!), mtfDmi: snapDmi(tfIndicators[1]!), htfDmi: snapDmi(tfIndicators[2]!),
          priorBars, futureBarsSnap,
          orbFormed: orb.orbFormed, orbBreakoutDir: orb.breakoutDirection,
          pdh: priorDayLevels.pdh, pdl: priorDayLevels.pdl, pdc: priorDayLevels.pdc,
          rangePosition: tfIndicators[2]!.priceStructure.rangePosition,
          swingHigh: tfIndicators[2]!.priceStructure.swingHigh,
          swingLow: tfIndicators[2]!.priceStructure.swingLow,
          ...oc,
        });
      }
    }

    const winners = dayEntries.filter(e => e.outcome === 'winner').length;
    const losers = dayEntries.filter(e => e.outcome === 'loser').length;
    const scratches = dayEntries.filter(e => e.outcome === 'scratch').length;

    const tag = losers === 0 && dayEntries.length > 0 ? ' *** NO BAD ENTRIES ***' :
                dayEntries.length === 0 ? ' (no signals)' : '';

    console.log(`  ${date} (${dayMovePct > '0' ? '+' : ''}${dayMovePct}%): ${dayEntries.length} entries | W:${winners} L:${losers} S:${scratches}${tag}`);
    allEntries.push(...dayEntries);
    daySummaries.push({ date, entries: dayEntries.length, winners, losers, scratches, dayMove: dayMovePct });
  }

  // ── Detailed entry list ────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(90)}`);
  console.log(`  ALL TRIGGERED ENTRIES (${allEntries.length} total)`);
  console.log(`${'─'.repeat(90)}\n`);

  for (const e of allEntries) {
    const outcomeIcon = e.outcome === 'winner' ? '✅' : e.outcome === 'loser' ? '❌' : '➖';
    const confStr = (e.confidence * 100).toFixed(0);
    const topBonuses = getTopFactors(e.confidenceBreakdown);

    console.log(`  ${outcomeIcon} ${e.date} ${e.timeET} ET | ${e.direction.toUpperCase().padEnd(7)} | ${e.alignment.padEnd(15)} | conf=${confStr}% | $${e.price.toFixed(2)}`);
    console.log(`     ADX=${e.adx.toFixed(0)} ATR=${e.atr.toFixed(2)} | 15m: ${e.pnl15m >= 0 ? '+' : ''}${e.pnl15m.toFixed(3)}% | 30m: ${e.pnl30m >= 0 ? '+' : ''}${e.pnl30m.toFixed(3)}% | optPnl: ${e.optionPnl15m >= 0 ? '+' : ''}${e.optionPnl15m.toFixed(1)}%`);
    console.log(`     maxFav: +${e.maxFavorable.toFixed(3)}% | maxAdv: -${e.maxAdverse.toFixed(3)}% | top: ${topBonuses}`);
    console.log('');
  }

  // ── BAD ENTRY DEEP DIVES ──────────────────────────────────────────────────

  const losers = allEntries.filter(e => e.outcome === 'loser');
  console.log(`${'='.repeat(90)}`);
  console.log(`  BAD ENTRY DEEP DIVES (${losers.length} losers)`);
  console.log(`${'='.repeat(90)}`);

  for (let li = 0; li < losers.length; li++) {
    const e = losers[li]!;
    const cb = e.confidenceBreakdown;

    console.log(`\n${'━'.repeat(90)}`);
    console.log(`  LOSER #${li + 1}: ${e.date} ${e.timeET} ET — ${e.direction.toUpperCase()} @ $${e.price.toFixed(2)} (conf=${(e.confidence * 100).toFixed(0)}%)`);
    console.log(`${'━'.repeat(90)}`);

    // 1. Outcome summary
    console.log(`\n  ── OUTCOME ──`);
    console.log(`  15m P&L: ${e.pnl15m >= 0 ? '+' : ''}${e.pnl15m.toFixed(3)}%  |  30m P&L: ${e.pnl30m >= 0 ? '+' : ''}${e.pnl30m.toFixed(3)}%  |  Option P&L: ${e.optionPnl15m >= 0 ? '+' : ''}${e.optionPnl15m.toFixed(1)}%`);
    console.log(`  Max favorable: +${e.maxFavorable.toFixed(3)}%  |  Max adverse: -${e.maxAdverse.toFixed(3)}%`);
    const neverFavorable = e.maxFavorable < 0.01;
    const instantReversal = e.maxAdverse > 0.1 && e.maxFavorable < 0.03;
    if (neverFavorable) console.log(`  ** NEVER MOVED IN DIRECTION — immediate counter-move **`);
    else if (instantReversal) console.log(`  ** INSTANT REVERSAL — barely moved, then dropped hard **`);

    // 2. Full confidence breakdown
    console.log(`\n  ── CONFIDENCE BREAKDOWN ── (total: ${(cb.total * 100).toFixed(1)}%)`);
    console.log(`  base:           ${fmt(cb.base)}`);
    console.log(`  diSpreadBonus:  ${fmt(cb.diSpreadBonus)}  ${flag(cb.diSpreadBonus, 0.10, 'HIGH')}`);
    console.log(`  adxBonus:       ${fmt(cb.adxBonus)}`);
    console.log(`  diCrossBonus:   ${fmt(cb.diCrossBonus)}  ${flag(cb.diCrossBonus, 0.05, 'FRESH CROSS')}`);
    console.log(`  alignmentBonus: ${fmt(cb.alignmentBonus)}`);
    console.log(`  tdAdjustment:   ${fmt(cb.tdAdjustment)}`);
    console.log(`  obvBonus:       ${fmt(cb.obvBonus)}`);
    console.log(`  vwapBonus:      ${fmt(cb.vwapBonus)}  ${flag(cb.vwapBonus, 0.06, 'STRONG VWAP')}`);
    console.log(`  oiVolumeBonus:  ${fmt(cb.oiVolumeBonus)}`);
    console.log(`  pricePosition:  ${fmt(cb.pricePositionAdjustment)}`);
    console.log(`  adxMaturity:    ${fmt(cb.adxMaturityPenalty)}  ${flagNeg(cb.adxMaturityPenalty, -0.08, 'MATURE TREND')}`);
    console.log(`  trendPhase:     ${fmt(cb.trendPhaseBonus)}  ${flagNeg(cb.trendPhaseBonus, -0.03, 'DECLINING ADX')}`);
    console.log(`  momentumAccel:  ${fmt(cb.momentumAccelBonus)}`);
    console.log(`  structureBonus: ${fmt(cb.structureBonus)}`);
    console.log(`  orbBonus:       ${fmt(cb.orbBonus)}`);
    console.log(`  priceAction:    ${fmt(cb.recentPriceActionBonus)}  ${flag(cb.recentPriceActionBonus, 0.04, 'CONFIRMING')}`);
    console.log(`  trContraction:  ${fmt(cb.trContractionPenalty)}  ${flagNeg(cb.trContractionPenalty, -0.05, 'LOW RANGE')}`);
    console.log(`  lowVol:         ${fmt(cb.lowVolPenalty)}  ${flagNeg(cb.lowVolPenalty, -0.05, 'LOW ADX')}`);
    console.log(`  moveExhaustion: ${fmt(cb.moveExhaustionPenalty)}  ${flagNeg(cb.moveExhaustionPenalty, -0.06, 'BIG MOVE DONE')}`);
    console.log(`  consolidation:  ${fmt(cb.consolidationPenalty)}`);
    console.log(`  nearLevel:      ${fmt(cb.nearLevelPenalty)}  ${flagNeg(cb.nearLevelPenalty, -0.03, 'NEAR S/R')}`);
    console.log(`  thetaDecay:     ${fmt(cb.thetaDecayPenalty)}`);
    console.log(`  narrowRange:    ${fmt(cb.narrowRangePenalty)}  ${flagNeg(cb.narrowRangePenalty, -0.04, 'TIGHT RANGE')}`);

    // 3. DMI per timeframe
    console.log(`\n  ── DMI STATE ──`);
    for (const [label, dmi] of [['LTF(1m)', e.ltfDmi], ['MTF(3m)', e.mtfDmi], ['HTF(5m)', e.htfDmi]] as const) {
      const d = dmi as DmiSnapshot;
      const diSpread = d.plusDI - d.minusDI;
      const crossFlags = [
        d.crossedUp ? 'crossUp' : '', d.crossedDown ? 'crossDn' : '',
        d.recentCrossUp ? 'recentUp' : '', d.recentCrossDown ? 'recentDn' : '',
        d.growthCrossUp ? 'growthUp' : '', d.growthCrossDown ? 'growthDn' : '',
      ].filter(Boolean).join(', ');
      console.log(`  ${label.padEnd(10)} trend=${d.trend.padEnd(7)} ADX=${d.adx.toFixed(1).padEnd(5)} +DI=${d.plusDI.toFixed(1).padEnd(5)} -DI=${d.minusDI.toFixed(1).padEnd(5)} spread=${diSpread >= 0 ? '+' : ''}${diSpread.toFixed(1).padEnd(6)} adxSlope=${d.adxSlope >= 0 ? '+' : ''}${d.adxSlope.toFixed(1)} diSlope=${d.diSpreadSlope >= 0 ? '+' : ''}${d.diSpreadSlope.toFixed(1)}`);
      console.log(`  ${''.padEnd(10)} bars>25=${d.adxBarsAbove25}  crosses: ${crossFlags || 'none'}`);
    }

    // 4. Market structure
    console.log(`\n  ── STRUCTURE ──`);
    console.log(`  PDH=$${e.pdh.toFixed(2)}  PDL=$${e.pdl.toFixed(2)}  PDC=$${e.pdc.toFixed(2)}  Price=$${e.price.toFixed(2)}`);
    const abovePDH = e.price > e.pdh;
    const belowPDL = e.price < e.pdl;
    console.log(`  Position: ${abovePDH ? 'ABOVE PDH' : belowPDL ? 'BELOW PDL' : e.price > e.pdc ? 'above PDC' : 'below PDC'}`);
    console.log(`  ORB formed: ${e.orbFormed}  breakout: ${e.orbBreakoutDir}`);
    console.log(`  HTF range position: ${(e.rangePosition * 100).toFixed(0)}%  swingH=$${e.swingHigh.toFixed(2)}  swingL=$${e.swingLow.toFixed(2)}`);

    // 5. Price path — before and after
    console.log(`\n  ── PRICE PATH (5 bars before → 15 bars after) ──`);
    console.log(`  BEFORE:`);
    for (const b of e.priorBars) {
      const barDir = b.c >= b.o ? '▲' : '▼';
      const range = (b.h - b.l).toFixed(2);
      console.log(`    ${b.time} ET  O=${b.o.toFixed(2)} H=${b.h.toFixed(2)} L=${b.l.toFixed(2)} C=${b.c.toFixed(2)} ${barDir} range=${range}`);
    }
    console.log(`  >>> ENTRY @ $${e.price.toFixed(2)} (${e.direction.toUpperCase()}) <<<`);
    console.log(`  AFTER:`);
    for (let fi = 0; fi < e.futureBarsSnap.length; fi++) {
      const b = e.futureBarsSnap[fi]!;
      const barDir = b.c >= b.o ? '▲' : '▼';
      const movePct = ((e.direction === 'bullish' ? b.c - e.price : e.price - b.c) / e.price * 100).toFixed(3);
      const tag = fi === 0 ? ' ← +1m' : fi === 4 ? ' ← +5m' : fi === 14 ? ' ← +15m' : '';
      console.log(`    ${b.time} ET  O=${b.o.toFixed(2)} H=${b.h.toFixed(2)} L=${b.l.toFixed(2)} C=${b.c.toFixed(2)} ${barDir} move=${movePct}%${tag}`);
    }

    // 6. Diagnosis — what should have caught this?
    console.log(`\n  ── DIAGNOSIS ──`);
    const issues: string[] = [];

    // Check: was price action actually confirming?
    if (cb.recentPriceActionBonus > 0 && neverFavorable) {
      issues.push(`priceAction gave +${(cb.recentPriceActionBonus*100).toFixed(0)}% bonus but price NEVER moved in direction — recent bars were misleading`);
    }
    // Check: high DI spread but move was done
    if (cb.diSpreadBonus >= 0.10 && (cb.moveExhaustionPenalty < 0 || cb.adxMaturityPenalty < 0)) {
      issues.push(`diSpread +${(cb.diSpreadBonus*100).toFixed(0)}% was high but trend is mature/exhausted — spread alone isn't enough`);
    }
    // Check: DI cross bonus but reversal came
    if (cb.diCrossBonus >= 0.05 && neverFavorable) {
      issues.push(`diCross gave +${(cb.diCrossBonus*100).toFixed(0)}% bonus but cross did not translate to price continuation`);
    }
    // Check: VWAP confirmation but overextended
    if (cb.vwapBonus >= 0.06 && e.optionPnl15m < -5) {
      issues.push(`VWAP gave +${(cb.vwapBonus*100).toFixed(0)}% but entry was likely overextended from VWAP (mean-reversion trap)`);
    }
    // Check: alignment bonus masked weak signals
    if (cb.alignmentBonus >= 0.06 && cb.total - cb.alignmentBonus < MIN_CONFIDENCE) {
      issues.push(`Without alignment bonus (+${(cb.alignmentBonus*100).toFixed(0)}%), conf would be ${((cb.total - cb.alignmentBonus)*100).toFixed(0)}% < ${(MIN_CONFIDENCE*100).toFixed(0)}% threshold — alignment masked weakness`);
    }
    // Check: structure bonus unjustified
    if (cb.structureBonus > 0 && e.optionPnl15m < -10) {
      issues.push(`Structure bonus +${(cb.structureBonus*100).toFixed(0)}% but big loss — PDH/PDL level didn't provide support`);
    }
    // Check: OBV divergence missed
    if (cb.obvBonus >= 0.03 && neverFavorable) {
      issues.push(`OBV gave +${(cb.obvBonus*100).toFixed(0)}% but price never confirmed — volume trend diverged from price action`);
    }
    // Check: low ADX but no penalty
    if (e.htfDmi.adx < 20 && cb.lowVolPenalty === 0) {
      issues.push(`HTF ADX=${e.htfDmi.adx.toFixed(0)} is low but lowVolPenalty=0 — likely had a recentCross that waived the penalty`);
    }
    // Check: mature trend not penalized enough
    if (e.htfDmi.adxBarsAbove25 >= 5 && cb.adxMaturityPenalty === 0) {
      issues.push(`HTF has ${e.htfDmi.adxBarsAbove25} bars>25 but adxMaturityPenalty=0 — fresh cross waived penalty but trend may still be stale`);
    }
    // Check: ADX declining but entered anyway
    if (e.htfDmi.adxSlope < -1 && cb.trendPhaseBonus >= 0) {
      issues.push(`HTF ADX slope=${e.htfDmi.adxSlope.toFixed(1)} is declining but trendPhaseBonus=${(cb.trendPhaseBonus*100).toFixed(0)}% — exhaustion not captured`);
    }
    // Check: range position extreme
    if ((e.direction === 'bullish' && e.rangePosition > 0.8) || (e.direction === 'bearish' && e.rangePosition < 0.2)) {
      issues.push(`Range position ${(e.rangePosition*100).toFixed(0)}% — entering ${e.direction} at range extreme`);
    }
    // Check: spread between DI lines is narrowing (diSpreadSlope negative for direction)
    const htfDirSpread = e.direction === 'bullish' ? e.htfDmi.plusDI - e.htfDmi.minusDI : e.htfDmi.minusDI - e.htfDmi.plusDI;
    if (htfDirSpread > 0 && e.htfDmi.diSpreadSlope < -1) {
      issues.push(`HTF DI spread is positive (${htfDirSpread.toFixed(1)}) but NARROWING (slope=${e.htfDmi.diSpreadSlope.toFixed(1)}) — momentum fading`);
    }
    // Check: near support/resistance
    if (cb.nearLevelPenalty < 0) {
      issues.push(`Near S/R level (penalty ${(cb.nearLevelPenalty*100).toFixed(0)}%) — price may bounce/reject at this level`);
    }
    if (cb.narrowRangePenalty < 0) {
      issues.push(`Narrow intraday range (penalty ${(cb.narrowRangePenalty*100).toFixed(0)}%) — choppy/range-bound day, low follow-through`);
    }
    // Check: what SINGLE factor, if removed, would have blocked this entry?
    const removable = [
      { name: 'diSpreadBonus', val: cb.diSpreadBonus },
      { name: 'diCrossBonus', val: cb.diCrossBonus },
      { name: 'alignmentBonus', val: cb.alignmentBonus },
      { name: 'vwapBonus', val: cb.vwapBonus },
      { name: 'obvBonus', val: cb.obvBonus },
      { name: 'priceAction', val: cb.recentPriceActionBonus },
      { name: 'structureBonus', val: cb.structureBonus },
      { name: 'orbBonus', val: cb.orbBonus },
      { name: 'trendPhaseBonus', val: cb.trendPhaseBonus },
      { name: 'momentumAccel', val: cb.momentumAccelBonus },
    ].filter(f => f.val > 0);
    const blockableBy = removable.filter(f => cb.total - f.val < MIN_CONFIDENCE);
    if (blockableBy.length > 0) {
      issues.push(`WOULD BE BLOCKED by removing any of: ${blockableBy.map(f => `${f.name}(${(f.val*100).toFixed(0)}%)`).join(', ')}`);
    }

    if (issues.length === 0) {
      issues.push(`No single obvious issue — confidence was marginal and outcome was close`);
    }
    for (const issue of issues) {
      console.log(`  → ${issue}`);
    }
  }
  console.log('');

  // ── Days with no bad entries ───────────────────────────────────────────────

  console.log(`${'─'.repeat(90)}`);
  console.log(`  DAYS WITH NO BAD ENTRIES (all signals were winners or scratches)`);
  console.log(`${'─'.repeat(90)}\n`);

  const cleanDays = daySummaries.filter(d => d.losers === 0 && d.entries > 0);
  if (cleanDays.length === 0) {
    console.log(`  None — every day with signals had at least one loser\n`);
  } else {
    for (const d of cleanDays) {
      console.log(`  ${d.date} (${d.dayMove}%): ${d.entries} entries, ${d.winners}W ${d.scratches}S`);
    }
    console.log('');
  }

  // ── Summary statistics ─────────────────────────────────────────────────────

  const totalW = allEntries.filter(e => e.outcome === 'winner').length;
  const totalL = allEntries.filter(e => e.outcome === 'loser').length;
  const totalS = allEntries.filter(e => e.outcome === 'scratch').length;
  const avgConf = allEntries.length > 0 ? allEntries.reduce((s, e) => s + e.confidence, 0) / allEntries.length : 0;
  const avgOptPnl = allEntries.length > 0 ? allEntries.reduce((s, e) => s + e.optionPnl15m, 0) / allEntries.length : 0;
  const winnerAvgPnl = totalW > 0 ? allEntries.filter(e => e.outcome === 'winner').reduce((s, e) => s + e.optionPnl15m, 0) / totalW : 0;
  const loserAvgPnl = totalL > 0 ? allEntries.filter(e => e.outcome === 'loser').reduce((s, e) => s + e.optionPnl15m, 0) / totalL : 0;

  // Confidence band analysis
  const confBands = [
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80-85%', min: 0.80, max: 0.85 },
    { label: '85-90%', min: 0.85, max: 0.90 },
    { label: '90%+',   min: 0.90, max: 1.01 },
  ];

  console.log(`${'─'.repeat(90)}`);
  console.log(`  OVERALL SUMMARY: ${START_DATE} → ${END_DATE}`);
  console.log(`${'─'.repeat(90)}\n`);

  console.log(`  Trading days:     ${tradingDays.length}`);
  console.log(`  Days with signals: ${daySummaries.filter(d => d.entries > 0).length}`);
  console.log(`  Clean days:        ${cleanDays.length} (no losers)`);
  console.log(`  Total entries:     ${allEntries.length}`);
  console.log(`  Winners:           ${totalW} (${allEntries.length > 0 ? (totalW / allEntries.length * 100).toFixed(0) : 0}%)`);
  console.log(`  Losers:            ${totalL} (${allEntries.length > 0 ? (totalL / allEntries.length * 100).toFixed(0) : 0}%)`);
  console.log(`  Scratches:         ${totalS}`);
  console.log(`  Avg confidence:    ${(avgConf * 100).toFixed(1)}%`);
  console.log(`  Avg option P&L:    ${avgOptPnl >= 0 ? '+' : ''}${avgOptPnl.toFixed(1)}%`);
  console.log(`  Winner avg P&L:    +${winnerAvgPnl.toFixed(1)}%`);
  console.log(`  Loser avg P&L:     ${loserAvgPnl.toFixed(1)}%`);

  console.log(`\n  CONFIDENCE BAND ANALYSIS:`);
  console.log(`  ${'Band'.padEnd(10)} ${'Count'.padEnd(7)} ${'Win%'.padEnd(7)} ${'Avg OptPnl'.padEnd(12)} AvgMaxFav  AvgMaxAdv`);
  for (const band of confBands) {
    const inBand = allEntries.filter(e => e.confidence >= band.min && e.confidence < band.max);
    if (inBand.length === 0) continue;
    const bW = inBand.filter(e => e.outcome === 'winner').length;
    const bAvgPnl = inBand.reduce((s, e) => s + e.optionPnl15m, 0) / inBand.length;
    const bAvgFav = inBand.reduce((s, e) => s + e.maxFavorable, 0) / inBand.length;
    const bAvgAdv = inBand.reduce((s, e) => s + e.maxAdverse, 0) / inBand.length;
    console.log(`  ${band.label.padEnd(10)} ${String(inBand.length).padEnd(7)} ${(bW / inBand.length * 100).toFixed(0).padEnd(7)}% ${(bAvgPnl >= 0 ? '+' : '') + bAvgPnl.toFixed(1) + '%'}${' '.repeat(Math.max(1, 8 - bAvgPnl.toFixed(1).length))} +${bAvgFav.toFixed(3)}%    -${bAvgAdv.toFixed(3)}%`);
  }

  // Direction analysis
  console.log(`\n  DIRECTION ANALYSIS:`);
  for (const dir of ['bullish', 'bearish'] as const) {
    const inDir = allEntries.filter(e => e.direction === dir);
    if (inDir.length === 0) continue;
    const dW = inDir.filter(e => e.outcome === 'winner').length;
    const dAvgPnl = inDir.reduce((s, e) => s + e.optionPnl15m, 0) / inDir.length;
    console.log(`  ${dir.toUpperCase().padEnd(10)} ${inDir.length} entries | Win: ${(dW / inDir.length * 100).toFixed(0)}% | Avg: ${dAvgPnl >= 0 ? '+' : ''}${dAvgPnl.toFixed(1)}%`);
  }

  // Alignment analysis
  console.log(`\n  ALIGNMENT ANALYSIS:`);
  for (const align of ['all_aligned', 'htf_mtf_aligned', 'mtf_ltf_aligned', 'mixed'] as const) {
    const inAlign = allEntries.filter(e => e.alignment === align);
    if (inAlign.length === 0) continue;
    const aW = inAlign.filter(e => e.outcome === 'winner').length;
    const aAvgPnl = inAlign.reduce((s, e) => s + e.optionPnl15m, 0) / inAlign.length;
    console.log(`  ${align.padEnd(17)} ${String(inAlign.length).padEnd(4)} entries | Win: ${(aW / inAlign.length * 100).toFixed(0).padEnd(3)}% | Avg: ${aAvgPnl >= 0 ? '+' : ''}${aAvgPnl.toFixed(1)}%`);
  }

  // Time-of-day analysis
  console.log(`\n  TIME-OF-DAY ANALYSIS (ET):`);
  const timeSlots = [
    { label: '9:30-10:00', startMin: 570, endMin: 600 },
    { label: '10:00-10:30', startMin: 600, endMin: 630 },
    { label: '10:30-11:00', startMin: 630, endMin: 660 },
    { label: '11:00-12:00', startMin: 660, endMin: 720 },
    { label: '12:00-13:00', startMin: 720, endMin: 780 },
    { label: '13:00-14:00', startMin: 780, endMin: 840 },
    { label: '14:00-15:00', startMin: 840, endMin: 900 },
    { label: '15:00-16:00', startMin: 900, endMin: 960 },
  ];
  for (const slot of timeSlots) {
    const inSlot = allEntries.filter(e => {
      const [hh, mm] = e.timeET.split(':').map(Number);
      const mins = hh! * 60 + mm!;
      return mins >= slot.startMin && mins < slot.endMin;
    });
    if (inSlot.length === 0) continue;
    const sW = inSlot.filter(e => e.outcome === 'winner').length;
    const sL = inSlot.filter(e => e.outcome === 'loser').length;
    const sAvgPnl = inSlot.reduce((s, e) => s + e.optionPnl15m, 0) / inSlot.length;
    console.log(`  ${slot.label.padEnd(12)} ${String(inSlot.length).padEnd(4)} entries | W:${sW} L:${sL} | Avg: ${sAvgPnl >= 0 ? '+' : ''}${sAvgPnl.toFixed(1)}%`);
  }

  console.log(`\n${'─'.repeat(90)}\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number): string {
  const pct = (v * 100).toFixed(1);
  return (v >= 0 ? '+' + pct : pct).padEnd(7) + '%';
}

function flag(v: number, threshold: number, label: string): string {
  return v >= threshold ? `<< ${label}` : '';
}

function flagNeg(v: number, threshold: number, label: string): string {
  return v <= threshold ? `<< ${label}` : '';
}

function getTopFactors(cb: ConfidenceBreakdown): string {
  const factors: { name: string; value: number }[] = [
    { name: 'diSpread', value: cb.diSpreadBonus },
    { name: 'adx', value: cb.adxBonus },
    { name: 'diCross', value: cb.diCrossBonus },
    { name: 'align', value: cb.alignmentBonus },
    { name: 'td', value: cb.tdAdjustment },
    { name: 'obv', value: cb.obvBonus },
    { name: 'vwap', value: cb.vwapBonus },
    { name: 'pricePos', value: cb.pricePositionAdjustment },
    { name: 'adxMat', value: cb.adxMaturityPenalty },
    { name: 'phase', value: cb.trendPhaseBonus },
    { name: 'momAccel', value: cb.momentumAccelBonus },
    { name: 'structure', value: cb.structureBonus },
    { name: 'orb', value: cb.orbBonus },
    { name: 'priceAct', value: cb.recentPriceActionBonus },
    { name: 'trContract', value: cb.trContractionPenalty },
    { name: 'lowVol', value: cb.lowVolPenalty },
    { name: 'moveExh', value: cb.moveExhaustionPenalty },
    { name: 'consol', value: cb.consolidationPenalty },
    { name: 'nearLvl', value: cb.nearLevelPenalty },
    { name: 'narrowRng', value: cb.narrowRangePenalty },
  ];
  // Sort by absolute value, show top 3
  factors.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return factors.slice(0, 3)
    .filter(f => f.value !== 0)
    .map(f => `${f.name}=${f.value >= 0 ? '+' : ''}${(f.value * 100).toFixed(0)}%`)
    .join(', ');
}

main().catch(err => { console.error('Backtest failed:', err); process.exit(1); });
