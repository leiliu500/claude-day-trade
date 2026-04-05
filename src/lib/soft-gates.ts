/**
 * soft-gates.ts — Sigmoid-based soft penalty functions to replace hard confidence caps.
 *
 * Hard gates create cliff effects (0.64 → miss, 0.66 → entry) that make tuning
 * impossible across different market days. Sigmoid penalties produce smooth,
 * continuous degradation that is robust to day-to-day variation.
 *
 * Each soft gate returns a penalty in [0, maxPenalty] that is subtracted from
 * the raw confidence total. The penalty increases smoothly as the input crosses
 * the center threshold.
 */

/**
 * Logistic sigmoid: output in [0, 1].
 *   value < center → output near 0 (no penalty)
 *   value > center → output near 1 (full penalty)
 *   steepness controls transition sharpness (higher = sharper, closer to hard gate)
 *
 * For "penalty when value is LOW" (e.g. low ADX), pass inverted=true.
 */
export function sigmoid(value: number, center: number, steepness: number, inverted = false): number {
  const x = inverted ? center - value : value - center;
  return 1 / (1 + Math.exp(-steepness * x));
}

/**
 * Compute a soft penalty: smooth degradation around a threshold.
 *
 * @param value     - The indicator value (e.g. ADX, rangePosition)
 * @param center    - Threshold center (where penalty = 50% of max)
 * @param steepness - How sharp the transition is (2-8 typical; higher = sharper)
 * @param maxPenalty - Maximum confidence penalty (positive number, e.g. 0.15)
 * @param inverted  - If true, penalize when value is BELOW center (e.g. low ADX)
 * @returns Penalty value in [0, maxPenalty] to subtract from confidence
 */
export function softPenalty(
  value: number,
  center: number,
  steepness: number,
  maxPenalty: number,
  inverted = false,
): number {
  return sigmoid(value, center, steepness, inverted) * maxPenalty;
}

// ── Pre-configured soft gate functions for trend confidence ─────────────────

/**
 * Low ADX penalty — replaces hard gates at ADX < 15 (cap 0.55) and ADX < 20 (cap 0.64).
 * Smooth degradation: ADX 25+ → 0 penalty, ADX 17 → moderate, ADX 12 → heavy.
 * Returns penalty to subtract from confidence (0 to 0.15).
 */
export function softLowAdxPenalty(adx: number): number {
  // Two-stage sigmoid: severe below 15, moderate 15-20
  const severePenalty = softPenalty(adx, 14, 0.8, 0.12, true);   // heavy below 14
  const moderatePenalty = softPenalty(adx, 19, 0.5, 0.06, true); // moderate below 19
  return Math.min(0.15, severePenalty + moderatePenalty);
}

/**
 * Opposing price action penalty — replaces hard gate at recentPriceActionBonus < 0 (cap 0.64).
 * Smooth: mildly negative PA → small penalty; strongly negative → heavy penalty.
 * Returns penalty to subtract (0 to 0.12).
 */
export function softOpposingPAPenalty(recentPriceActionBonus: number): number {
  if (recentPriceActionBonus >= 0) return 0;
  // Scale: -0.15 (direction change) → 0.12 penalty; -0.04 → ~0.03 penalty
  const severity = -recentPriceActionBonus; // positive magnitude
  return Math.min(0.12, severity * 0.8);
}

/**
 * ADX maturity penalty — replaces hard gates at various maturity thresholds.
 * Smooth degradation based on how negative adxMaturityPenalty already is.
 * Returns additional penalty to subtract (0 to 0.10).
 */
export function softAdxMaturityGate(
  adxMaturityPenalty: number,
  alignment: string,
  adx: number,
  recentPriceActionBonus: number,
): number {
  if (adxMaturityPenalty >= -0.04) return 0; // not mature enough to gate
  // Exempt all_aligned with ADX >= 20 (genuine continuation)
  if ((alignment === 'all_aligned' || alignment === 'htf_mtf_aligned') && adx >= 20) return 0;

  const severity = -adxMaturityPenalty; // positive magnitude (0.04 to 0.20)
  // Smooth: 0.04 → 0 penalty, 0.10 → moderate, 0.15+ → heavy
  let penalty = softPenalty(severity, 0.08, 15, 0.10);
  // Reduce penalty if price action is actively confirming
  if (recentPriceActionBonus > 0) penalty *= 0.5;
  return penalty;
}

/**
 * Structure gate — replaces hard gates at structureBonus <= 0 (cap 0.68) and < 0 (cap 0.62).
 * Smooth: positive structure → 0 penalty; zero → moderate; negative → heavy.
 * Returns penalty to subtract (0 to 0.10).
 */
export function softStructureGate(structureBonus: number): number {
  if (structureBonus > 0.02) return 0;
  // Scale: 0.02 → 0 penalty; 0 → moderate; -0.08 → heavy
  return softPenalty(structureBonus, 0.01, 40, 0.10, true);
}

/**
 * Range extreme penalty — replaces hard gate at rangePosition >= 0.85 (cap 0.62).
 * Smooth: beyond 0.75 starts penalizing; 0.90+ heavy penalty.
 * Returns penalty to subtract (0 to 0.10).
 * @param rangePosition - 0 to 1 range position
 * @param direction - bullish or bearish
 * @param strongActiveTrend - ADX > 25 && rising
 * @param allAligned - all timeframes agree
 */
export function softRangeExtremePenalty(
  rangePosition: number,
  direction: string,
  strongActiveTrend: boolean,
  allAligned: boolean,
): number {
  if (strongActiveTrend) return 0;
  if (allAligned) return 0;

  let extremity: number;
  if (direction === 'bullish') {
    extremity = rangePosition; // higher = more extreme for bulls
  } else {
    extremity = 1 - rangePosition; // lower = more extreme for bears
  }

  if (extremity < 0.70) return 0;
  // Smooth: 0.70 → 0, 0.80 → moderate, 0.90+ → heavy
  return softPenalty(extremity, 0.80, 12, 0.10);
}

// ── Composite soft gate application ─────────────────────────────────────────

export interface SoftGateResult {
  /** Total penalty from all soft gates (to subtract from raw confidence) */
  totalPenalty: number;
  /** Individual gate penalties for transparency/logging */
  gates: {
    lowAdx: number;
    opposingPA: number;
    adxMaturity: number;
    structure: number;
    rangeExtreme: number;
  };
}

/**
 * Apply all soft gates and return total penalty + breakdown.
 * This replaces the block of hard `if (...) total = Math.min(total, X)` gates.
 *
 * IMPORTANT: Some hard gates are KEPT as-is because they represent genuine
 * safety boundaries (theta decay, severe exhaustion, direction change).
 * Only the "cliff effect" gates that cause zero-entry days are softened.
 */
export function applySoftGates(params: {
  adx: number;
  recentPriceActionBonus: number;
  adxMaturityPenalty: number;
  structureBonus: number;
  rangePosition: number;
  direction: string;
  alignment: string;
  adxSlope: number;
}): SoftGateResult {
  const strongActiveTrend = params.adx > 25 && params.adxSlope > 0;
  const allAligned = params.alignment === 'all_aligned' && params.adx >= 20;

  const gates = {
    lowAdx: softLowAdxPenalty(params.adx),
    opposingPA: softOpposingPAPenalty(params.recentPriceActionBonus),
    adxMaturity: softAdxMaturityGate(
      params.adxMaturityPenalty,
      params.alignment,
      params.adx,
      params.recentPriceActionBonus,
    ),
    structure: softStructureGate(params.structureBonus),
    rangeExtreme: softRangeExtremePenalty(
      params.rangePosition,
      params.direction,
      strongActiveTrend,
      allAligned,
    ),
  };

  const totalPenalty = gates.lowAdx + gates.opposingPA + gates.adxMaturity
    + gates.structure + gates.rangeExtreme;

  return { totalPenalty, gates };
}
