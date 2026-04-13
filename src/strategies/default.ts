/**
 * Default ticker strategy — price-action based mode detection.
 *
 * Confidence models are imported from analysis-agent.ts (the canonical source).
 * Mode detection uses non-lagging indicators: VWAP, price velocity, volume surge,
 * and price structure instead of DMI/ADX.
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
 * Uses price-action: low velocity + near VWAP + at swing edge.
 */
export function evaluateRange(
  htfTf: TimeframeIndicators,
  currentPrice: number,
  opts: { maxAdx?: number; minEdge?: number; maxEdge?: number; minSwingRangePct?: number } = {},
): ModeCandidate | null {
  const minEdge = opts.minEdge ?? 0.30;
  const maxEdge = opts.maxEdge ?? 0.70;
  const minSwingRangePct = opts.minSwingRangePct ?? 0.20;

  const htfRangePos = htfTf.priceStructure.rangePosition;
  const htfSwingHigh = htfTf.priceStructure.swingHigh;
  const htfSwingLow = htfTf.priceStructure.swingLow;
  const htfSwingRange = htfSwingHigh - htfSwingLow;
  const htfSwingRangePct = htfSwingRange / currentPrice * 100;

  // Price-action gates: low velocity + near VWAP
  const absVel = Math.abs(htfTf.priceVelocity.directionalVelocity);
  if (absVel > 0.05) return null; // strong velocity = trending, not ranging
  if (Math.abs(htfTf.vwap.priceVsVwap) > 0.40) return null; // too far from VWAP

  if (htfRangePos < 0.05 || htfRangePos > 0.95
      || htfSwingRangePct < minSwingRangePct) {
    return null;
  }

  const atResistance = htfRangePos >= maxEdge;
  const atSupport = htfRangePos <= minEdge;
  if (!atResistance && !atSupport) return null;

  // Score: deeper into edge zone + lower velocity = stronger range signal
  const edgeDepth = atResistance
    ? (htfRangePos - maxEdge) / (1.0 - maxEdge)
    : (minEdge - htfRangePos) / minEdge;
  const velScore = Math.max(0, 1 - absVel / 0.05);
  const rangeWidthScore = Math.min(1, htfSwingRangePct / 0.50);
  const score = 0.40 + 0.25 * edgeDepth + 0.20 * velScore + 0.15 * rangeWidthScore;

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
 * Uses price-action: level break + volume surge + velocity accelerating.
 */
export function evaluateBreakout(
  htfTf: TimeframeIndicators,
  tfIndicators: TimeframeIndicators[],
  currentPrice: number,
): ModeCandidate | null {
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

  // Require volume surge or velocity acceleration (not DMI)
  const ltf = tfIndicators[0];
  const volumeConfirms = ltf ? ltf.volumeSurge.recentVolumeRatio > 1.3 : false;
  const velocityAccelerating = ltf ? ltf.priceVelocity.acceleration > 0.01 : false;
  const obvConfirms = brokeHigh
    ? htfTf.obv.trend === 'bullish'
    : htfTf.obv.trend === 'bearish';
  if (!volumeConfirms && !velocityAccelerating && !obvConfirms) return null;

  const beyondScore = Math.min(1, beyondPct / 0.20);
  const confirmCount = (volumeConfirms ? 1 : 0) + (velocityAccelerating ? 1 : 0) + (obvConfirms ? 1 : 0);
  const confirmScore = confirmCount / 3;
  const velScore = ltf ? Math.min(1, Math.abs(ltf.priceVelocity.directionalVelocity) / 0.08) : 0;
  const score = 0.40 + 0.20 * beyondScore + 0.20 * velScore + 0.20 * confirmScore;

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
 * Uses price-action: sustained directional velocity + VWAP confirms + swing structure trending.
 */
export function evaluateTrend(
  htfTf: TimeframeIndicators,
): ModeCandidate | null {
  const absVel = Math.abs(htfTf.priceVelocity.directionalVelocity);
  const vwapPct = htfTf.vwap.priceVsVwap;

  // Trend requires sustained directional movement
  if (absVel < 0.02) return null;

  // VWAP must confirm: price on correct side of VWAP
  const velBullish = htfTf.priceVelocity.directionalVelocity > 0;
  const vwapConfirms = velBullish ? vwapPct > 0 : vwapPct < 0;
  if (!vwapConfirms && absVel < 0.05) return null; // weak velocity + no VWAP confirm = not trend

  // Volume not declining
  const volOk = htfTf.volumeSurge.recentVolumeRatio >= 0.6;
  if (!volOk && absVel < 0.04) return null;

  const direction: SignalDirection = velBullish ? 'bullish' : 'bearish';

  // Score: velocity magnitude + VWAP distance + volume
  const velStrength = Math.min(1, absVel / 0.10);
  const vwapStrength = Math.min(1, Math.abs(vwapPct) / 0.30);
  const volStrength = Math.min(1, htfTf.volumeSurge.recentVolumeRatio / 2.0);
  const score = 0.40 + 0.25 * velStrength + 0.20 * vwapStrength + 0.15 * volStrength;

  return {
    result: { signalMode: 'trend', direction },
    score,
  };
}

/**
 * Evaluate VWAP mean reversion mode independently. Returns candidate or null.
 * Fires when price is overextended from VWAP and a reversal candle appears.
 */
export function evaluateVwapReversion(
  ltfTf: TimeframeIndicators,
  htfTf: TimeframeIndicators,
  currentPrice: number,
): ModeCandidate | null {
  const vwapPct = ltfTf.vwap?.priceVsVwap ?? 0;
  const absVwapPct = Math.abs(vwapPct);
  const vwapPrice = ltfTf.vwap?.vwap ?? 0;

  // Must be overextended from VWAP (>= 0.30%)
  if (absVwapPct < 0.30 || vwapPrice <= 0) return null;

  // Velocity should be decelerating (move losing steam)
  const acceleration = ltfTf.priceVelocity.acceleration;
  // Don't require deceleration but bonus for it

  // Reversal candle: last LTF bar turns back toward VWAP, with 2+ prior opposing bars
  const bars = ltfTf.bars;
  if (bars.length < 4) return null;
  const lastBar = bars[bars.length - 1]!;
  const priorBars = bars.slice(-3, -1);
  const isBullishRev = vwapPct < 0 && lastBar.close > lastBar.open;
  const isBearishRev = vwapPct > 0 && lastBar.close < lastBar.open;
  if (!isBullishRev && !isBearishRev) return null;
  const priorInExtDir = priorBars.filter(b =>
    isBullishRev ? b.close < b.open : b.close > b.open
  ).length;
  if (priorInExtDir < 2) return null;

  const direction = vwapPct > 0 ? 'bearish' : 'bullish';

  // Score
  const vwapDistScore = Math.min(1, absVwapPct / 0.60) * 0.25;
  const reversalScore = (priorInExtDir >= 2 ? 0.10 : 0.05);
  const decelScore = acceleration < 0 ? 0.10 : 0;
  const score = 0.40 + vwapDistScore + reversalScore + decelScore;

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
  const vel = Math.abs(tfIndicators[0]?.priceVelocity?.directionalVelocity ?? 0);
  const vwapDist = Math.abs(tfIndicators[2]?.vwap?.priceVsVwap ?? 0);
  return Math.min(100, Math.round(vel * 500 + vwapDist * 50));
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
