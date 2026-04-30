/**
 * SPY morning microtrend detector — narrow carve-out for SPY trend signals
 * during the 10:00-11:15 ET window where confirmation is strong enough that
 * 2-stage waiting gives back most of the move.
 *
 * Target use case: SPY morning near-threshold trend signals where the move is
 * already being confirmed by either live order-flow/options data or a tight
 * technical continuation shape. The bonus pushes 0.55-0.65 confidence signals
 * across the entry threshold; the bypass skips stage-2 wait so the entry catches
 * the move; and the filter carve-outs (v1/v3/v5 in spy.ts) keep this narrow
 * pattern from being blocked by SPY's existing low-atr / mid-atr filters which
 * were calibrated for the broader trend pool, not this specific morning slice.
 *
 * Design note: this detector applies THREE actions on the same signal —
 *   1. +0.10 confidence bonus (in adjustConfidence)
 *   2. Bypass of v1/v3/v5 filters (in shouldAllowEntry)
 *   3. Stage-2 bypass (via flowMicrotrendBypass in entry-gate)
 * Each layer compounds; the detector's 11-factor floor is what makes the
 * compound action safe. If thresholds are loosened, evaluate whether all
 * three actions are still warranted or just the bonus.
 *
 * Validation status (as of 2026-04-30): MERGE on 2025-01-02..2026-04-29 SPY
 * harness after adding the technical continuation branch (+26 confirmed entries,
 * expectancy -0.275 → -0.241, direction 60.7% → 61.3%). Bootstrap CI still spans
 * zero and 4/12 scored monthly chunks disagree, so keep this as a narrow SPY-only
 * carve-out and revalidate before loosening it further.
 *
 * Factor threshold provenance: flow branch is hand-tuned from the Apr 29 2026
 * PARITY GAP profiles (10:11 bullish + 10:58 bearish). Technical branch is mined
 * from the full 16mo rejected-entry pool, constrained to morning trend entries
 * in the near-threshold band.
 */

import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalDirection } from '../types/signal.js';

export const SPY_MORNING_MICROTREND_BONUS = 0.10;

export interface SpyMicrotrendInput {
  ticker?: string;
  signalMode: string;
  direction: SignalDirection;
  minutesSinceOpen?: number;
  breakdown: ConfidenceBreakdown;
}

function hasFlowConfirmedShape(input: SpyMicrotrendInput): boolean {
  const b = input.breakdown;
  const common =
    b.oiVolumeBonus >= 0.05
    && b.consolidationPenalty >= -0.04
    && b.thetaDecayPenalty >= -0.03;

  if (!common) return false;

  if (input.direction === 'bullish') {
    return b.orderFlowBonus >= 0.12
      && b.recentPriceActionBonus >= 0.06
      && b.vwapBonus >= 0.04
      && b.nearLevelPenalty >= -0.06
      && b.orbBonus >= 0
      && b.momentumAccelBonus >= -0.03;
  }

  if (input.direction === 'bearish') {
    return b.orderFlowBonus >= 0.15
      && b.vwapBonus >= 0.04
      && b.structureBonus >= 0.02
      && b.trendPhaseBonus >= 0.02
      && b.candlePatternBonus >= 0.04
      && b.nearLevelPenalty >= -0.01;
  }

  return false;
}

function hasTechnicalContinuationShape(input: SpyMicrotrendInput): boolean {
  const b = input.breakdown;

  if (b.consolidationPenalty < -0.03 || b.thetaDecayPenalty < -0.03) return false;

  if (input.direction === 'bullish') {
    return b.alignmentBonus >= 0.06
      && b.vwapBonus >= 0.06
      && b.recentPriceActionBonus >= 0.08
      && b.trendPhaseBonus >= 0.04
      && b.momentumAccelBonus >= 0
      && b.nearLevelPenalty >= -0.03;
  }

  if (input.direction === 'bearish') {
    return b.total < 0.70
      && b.alignmentBonus >= 0.06
      && b.vwapBonus >= 0.05
      && b.nearLevelPenalty >= 0
      && b.consolidationPenalty >= 0
      && b.trendPhaseBonus >= 0.06
      && b.momentumAccelBonus >= 0
      && b.recentPriceActionBonus >= -0.08;
  }

  return false;
}

function hasMorningMicrotrendShape(input: SpyMicrotrendInput): boolean {
  if (input.ticker !== undefined && input.ticker !== 'SPY') return false;
  if (input.signalMode !== 'trend') return false;
  const mins = input.minutesSinceOpen;
  if (mins === undefined || mins < 30 || mins >= 105) return false;

  const b = input.breakdown;
  if (b.total < 0.55 || b.total >= 0.75) return false;

  return hasFlowConfirmedShape(input) || hasTechnicalContinuationShape(input);
}

export function spyMorningMicrotrendBonus(input: SpyMicrotrendInput): number {
  if (!hasMorningMicrotrendShape(input)) return 0;

  const total = input.breakdown.total;
  if (hasTechnicalContinuationShape(input) && input.direction === 'bearish') {
    return total >= 0.55 && total < 0.60 ? SPY_MORNING_MICROTREND_BONUS : 0;
  }

  return total >= 0.55 && total < 0.65 ? SPY_MORNING_MICROTREND_BONUS : 0;
}

export function isSpyMorningMicrotrend(input: SpyMicrotrendInput): boolean {
  return hasMorningMicrotrendShape(input);
}
