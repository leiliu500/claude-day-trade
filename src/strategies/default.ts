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
 * Resolve between range and breakout candidates.
 * When only one qualifies, returns it. When both qualify, picks higher score.
 * When neither qualifies, returns trend.
 */
export function resolveMode(
  rangeCandidate: ModeCandidate | null,
  breakoutCandidate: ModeCandidate | null,
): ModeDetectionResult {
  if (rangeCandidate && breakoutCandidate) {
    // Both qualify — pick higher score (breakout wins ties)
    return breakoutCandidate.score >= rangeCandidate.score
      ? breakoutCandidate.result
      : rangeCandidate.result;
  }
  if (rangeCandidate) return rangeCandidate.result;
  if (breakoutCandidate) return breakoutCandidate.result;
  return { signalMode: 'trend' };
}

// ── Default mode detection (parallel) ───────────────────────────────────────

function defaultDetectMode(
  tfIndicators: TimeframeIndicators[],
  _direction: SignalDirection,
  currentPrice: number,
): ModeDetectionResult {
  const htfTf = tfIndicators[2]!;
  const rangeCandidate = evaluateRange(htfTf, currentPrice);
  const breakoutCandidate = evaluateBreakout(htfTf, tfIndicators, currentPrice);
  return resolveMode(rangeCandidate, breakoutCandidate);
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
