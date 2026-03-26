/**
 * Default ticker strategy — the current SPY-tuned logic.
 *
 * Confidence models are imported from analysis-agent.ts (the canonical source).
 * Mode detection and strength scoring are defined here (ported from signal-agent.ts).
 *
 * Range and breakout are evaluated independently in parallel, then resolved
 * by confidence score when both qualify. This prevents widening one mode's
 * thresholds from stealing ticks from the other.
 */

import type { TickerStrategy } from './strategy.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import type { ModeDetectionResult } from './strategy.js';
import {
  computeTrendConfidenceFn,
  computeRangeConfidenceFn,
  computeBreakoutConfidenceFn,
} from '../agents/analysis-agent.js';

// ── Parallel mode evaluation ────────────────────────────────────────────────

export interface ModeCandidate {
  result: ModeDetectionResult;
  score: number; // 0-1 tiebreaker when both qualify
}

/**
 * Evaluate range mode independently. Returns candidate or null.
 * Parameters are configurable so per-ticker strategies can widen thresholds.
 */
export function evaluateRange(
  htfTf: TimeframeIndicators,
  currentPrice: number,
  opts: { maxAdx?: number; minEdge?: number; maxEdge?: number; minSwingRangePct?: number } = {},
): ModeCandidate | null {
  const maxAdx = opts.maxAdx ?? 22;
  const minEdge = opts.minEdge ?? 0.30;
  const maxEdge = opts.maxEdge ?? 0.70;
  const minSwingRangePct = opts.minSwingRangePct ?? 0.20;

  const htfAdx = htfTf.dmi.adx;
  const htfHasFreshCross = htfTf.dmi.crossedUp || htfTf.dmi.crossedDown;
  const htfRangePos = htfTf.priceStructure.rangePosition;
  const htfSwingHigh = htfTf.priceStructure.swingHigh;
  const htfSwingLow = htfTf.priceStructure.swingLow;
  const htfSwingRange = htfSwingHigh - htfSwingLow;
  const htfSwingRangePct = htfSwingRange / currentPrice * 100;

  if (htfAdx >= maxAdx || htfHasFreshCross
      || htfRangePos < 0.05 || htfRangePos > 0.95
      || htfSwingRangePct < minSwingRangePct) {
    return null;
  }

  const atResistance = htfRangePos >= maxEdge;
  const atSupport = htfRangePos <= minEdge;
  if (!atResistance && !atSupport) return null;

  // Score: deeper into edge zone + lower ADX = stronger range signal
  const edgeDepth = atResistance
    ? (htfRangePos - maxEdge) / (1.0 - maxEdge)
    : (minEdge - htfRangePos) / minEdge;
  const adxScore = (maxAdx - htfAdx) / maxAdx;
  const rangeWidthScore = Math.min(1, htfSwingRangePct / 0.50);
  const score = 0.40 + 0.25 * edgeDepth + 0.20 * adxScore + 0.15 * rangeWidthScore;

  return {
    result: {
      signalMode: 'range',
      direction: atResistance ? 'bearish' : 'bullish',
      rangeSupport: htfSwingLow,
      rangeResistance: htfSwingHigh,
    },
    score,
  };
}

/**
 * Evaluate breakout mode independently. Returns candidate or null.
 */
export function evaluateBreakout(
  htfTf: TimeframeIndicators,
  tfIndicators: TimeframeIndicators[],
  currentPrice: number,
): ModeCandidate | null {
  const htfAdx = htfTf.dmi.adx;
  if (htfAdx >= 25 || htfTf.dmi.adxSlope <= 0) return null;

  const htfBarsForBO = htfTf.bars.slice(-20, -3);
  let boSwingHigh = -Infinity, boSwingLow = Infinity;
  for (const b of htfBarsForBO) {
    if (b.high > boSwingHigh) boSwingHigh = b.high;
    if (b.low < boSwingLow) boSwingLow = b.low;
  }
  const boSwingRange = boSwingHigh - boSwingLow;
  const brokeHigh = currentPrice > boSwingHigh && boSwingRange > 0;
  const brokeLow = currentPrice < boSwingLow && boSwingRange > 0;
  if (!brokeHigh && !brokeLow) return null;

  const beyondPct = brokeHigh
    ? ((currentPrice - boSwingHigh) / currentPrice) * 100
    : ((boSwingLow - currentPrice) / currentPrice) * 100;
  if (beyondPct <= 0.02 || beyondPct >= 0.40) return null;

  const htfObv = tfIndicators[2]!.obv;
  const obvConfirms = brokeHigh ? htfObv.trend === 'bullish' : htfObv.trend === 'bearish';
  const htfDiCross = brokeHigh ? htfTf.dmi.crossedUp : htfTf.dmi.crossedDown;
  const diSpreadConfirms = htfTf.dmi.diSpreadSlope > 1;
  if (!obvConfirms && !htfDiCross && !diSpreadConfirms) return null;

  // Score: further beyond + steeper ADX slope + more confirmations = stronger breakout
  const beyondScore = Math.min(1, beyondPct / 0.20);
  const slopeScore = Math.min(1, htfTf.dmi.adxSlope / 3);
  const confirmCount = (obvConfirms ? 1 : 0) + (htfDiCross ? 1 : 0) + (diSpreadConfirms ? 1 : 0);
  const confirmScore = confirmCount / 3;
  const score = 0.40 + 0.20 * beyondScore + 0.20 * slopeScore + 0.20 * confirmScore;

  return {
    result: {
      signalMode: 'breakout',
      direction: brokeHigh ? 'bullish' : 'bearish',
      breakoutLevel: brokeHigh ? boSwingHigh : boSwingLow,
      breakoutBeyond: beyondPct,
    },
    score,
  };
}

/**
 * Evaluate trend mode independently. Returns candidate or null.
 * Qualifies when ADX shows established directional movement with positive slope.
 * Without this, trend is a catch-all for choppy/ambiguous markets that shouldn't be traded.
 */
export function evaluateTrend(
  htfTf: TimeframeIndicators,
): ModeCandidate | null {
  const htfAdx = htfTf.dmi.adx;
  const adxSlope = htfTf.dmi.adxSlope;
  const diSpread = Math.abs(htfTf.dmi.plusDI - htfTf.dmi.minusDI);

  // Trend requires established directional movement
  if (htfAdx < 18) return null;           // ADX below 18 = no trend
  if (adxSlope <= 0) return null;          // flat/declining ADX = trend fading
  if (diSpread < 5) return null;           // no clear directional dominance

  // Direction from DI dominance
  const direction: SignalDirection = htfTf.dmi.plusDI > htfTf.dmi.minusDI ? 'bullish' : 'bearish';

  // Score: same 0.40 base + bonuses scale as other modes (0.40–0.80)
  const adxStrength = Math.min(1, (htfAdx - 18) / 20);      // ADX 18→0, 38→1
  const diSpreadScore = Math.min(1, diSpread / 20);           // spread 0→0, 20→1
  const slopeScore = Math.min(1, adxSlope / 3);               // slope 0→0, 3→1
  const score = 0.40 + 0.15 * adxStrength + 0.15 * diSpreadScore + 0.10 * slopeScore;

  return {
    result: { signalMode: 'trend', direction },
    score,
  };
}

/**
 * Evaluate VWAP mean reversion mode independently. Returns candidate or null.
 * Fires when price is overextended from VWAP on a low-ADX day and a reversal candle appears.
 */
export function evaluateVwapReversion(
  ltfTf: TimeframeIndicators,
  htfTf: TimeframeIndicators,
  currentPrice: number,
): ModeCandidate | null {
  const htfAdx = htfTf.dmi.adx;
  const vwapPct = ltfTf.vwap?.priceVsVwap ?? 0; // % distance from VWAP (positive = above)
  const absVwapPct = Math.abs(vwapPct);
  const vwapPrice = ltfTf.vwap?.vwap ?? 0;

  // Must be overextended from VWAP (>= 0.30%)
  if (absVwapPct < 0.30 || vwapPrice <= 0) return null;

  // Must be low/declining ADX (< 25) — not a strong trend
  if (htfAdx >= 25) return null;

  // No fresh DI cross in extension direction (would indicate trend continuation)
  if (vwapPct > 0 && htfTf.dmi.crossedUp) return null;
  if (vwapPct < 0 && htfTf.dmi.crossedDown) return null;

  // Reversal candle: last LTF bar turns back toward VWAP, with 2+ prior opposing bars
  const bars = ltfTf.bars;
  if (bars.length < 4) return null;
  const lastBar = bars[bars.length - 1]!;
  const priorBars = bars.slice(-3, -1);
  const isBullishRev = vwapPct < 0 && lastBar.close > lastBar.open;
  const isBearishRev = vwapPct > 0 && lastBar.close < lastBar.open;
  if (!isBullishRev && !isBearishRev) return null;
  // Require 2+ prior bars in the extension direction (confirming overextension, not just noise)
  const priorInExtDir = priorBars.filter(b =>
    isBullishRev ? b.close < b.open : b.close > b.open
  ).length;
  if (priorInExtDir < 2) return null;

  // Direction: opposite to overextension
  const direction = vwapPct > 0 ? 'bearish' : 'bullish';

  // Score
  const vwapDistScore = Math.min(1, absVwapPct / 0.60) * 0.25;
  const adxScore = ((25 - htfAdx) / 25) * 0.15;
  // Reversal quality: 2+ opposing prior bars = stronger signal
  const priorOpposing = bars.slice(-3, -1).filter(b =>
    isBullishRev ? b.close < b.open : b.close > b.open
  ).length;
  const reversalScore = (priorOpposing >= 2 ? 0.10 : 0.05);
  const slopeScore = htfTf.dmi.adxSlope <= 0 ? 0.05 : 0;
  const score = 0.40 + vwapDistScore + adxScore + reversalScore + slopeScore;

  return {
    result: {
      signalMode: 'vwap_reversion' as const,
      direction,
      vwapReversionTarget: vwapPrice,
      vwapDistance: absVwapPct,
    },
    score,
  };
}

/**
 * Resolve between all mode candidates.
 * Picks the highest-scoring non-null candidate. Returns 'none' when nothing qualifies.
 * Every mode must earn its way in — there is no default/fallback mode.
 */
export function resolveMode(
  trendCandidate: ModeCandidate | null,
  rangeCandidate: ModeCandidate | null,
  breakoutCandidate: ModeCandidate | null,
  vwapRevCandidate?: ModeCandidate | null,
): ModeDetectionResult {
  const candidates = [trendCandidate, rangeCandidate, breakoutCandidate, vwapRevCandidate].filter(
    (c): c is ModeCandidate => c !== null && c !== undefined,
  );
  if (candidates.length === 0) return { signalMode: 'none' };
  if (candidates.length === 1) return candidates[0]!.result;
  // Multiple qualify — pick highest score
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.result;
}

// ── Default mode detection (parallel) ───────────────────────────────────────

function defaultDetectMode(
  tfIndicators: TimeframeIndicators[],
  _direction: SignalDirection,
  currentPrice: number,
): ModeDetectionResult {
  const htfTf = tfIndicators[2]!;
  const ltfTf = tfIndicators[0]!;
  const trendCandidate = evaluateTrend(htfTf);
  const rangeCandidate = evaluateRange(htfTf, currentPrice);
  const breakoutCandidate = evaluateBreakout(htfTf, tfIndicators, currentPrice);
  const vwapRevCandidate = evaluateVwapReversion(ltfTf, htfTf, currentPrice);
  return resolveMode(trendCandidate, rangeCandidate, breakoutCandidate, vwapRevCandidate);
}

function defaultComputeStrength(tfIndicators: TimeframeIndicators[]): number {
  const htfAdx = tfIndicators[2]?.dmi.adx ?? tfIndicators[1]?.dmi.adx ?? 0;
  return Math.min(100, Math.round(htfAdx * 2));
}

export const defaultStrategy: TickerStrategy = {
  computeTrendConfidence: computeTrendConfidenceFn,
  computeRangeConfidence: computeRangeConfidenceFn,
  computeBreakoutConfidence: computeBreakoutConfidenceFn,
  detectMode: defaultDetectMode,
  computeStrength: defaultComputeStrength,
  adjustConfidence: (cb) => cb,
  shouldAllowEntry: () => true,
};
