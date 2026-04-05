/**
 * SPY-specific trading strategy.
 *
 * Dynamic confidence from 5 components with self-calibrating weights:
 *   VWAP        — price position relative to VWAP
 *   DI+/-       — directional indicator spread alignment
 *   OBV         — on-balance volume confirmation
 *   Seq counter — TD Sequential setup alignment
 *   ADX         — trend strength
 *
 * Weights are calibrated every run using a rolling backtest on the available
 * LTF bar history (~500 bars ≈ 2 trading days). Each component's prediction
 * accuracy over forward-looking windows determines its weight.
 *
 * Default weights (used when insufficient bar history):
 *   VWAP 30%, DI+/- 35%, OBV 25%, Seq 5%, ADX 5%
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
// (Calibration removed — 2-layer multiplicative model uses fixed layer weights)

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function dirSign(direction: SignalDirection): number {
  return direction === 'bullish' ? 1 : direction === 'bearish' ? -1 : 0;
}

/** Timeframe weights for multi-TF scoring: LTF=0.5, MTF=0.3, HTF=0.2 */
const TF_WEIGHTS = [0.5, 0.3, 0.2];

// ── Component Scorers (each returns 0..1) ───────────────────────────────────

/**
 * VWAP score: inverted-U — moderate extension in the right direction scores
 * highest, extreme extension is penalized (overextended = mean reversion risk).
 *
 *   Aligned side:
 *     0.00–0.10%  → 0.60–0.75  (just crossed, early signal)
 *     0.10–0.25%  → 0.75–0.90  (sweet spot — momentum confirmed, not extended)
 *     0.25–0.40%  → 0.70–0.80  (getting extended)
 *     0.40–0.60%  → 0.50–0.70  (overextended)
 *     >0.60%      → 0.30–0.50  (extreme — reversion risk)
 *   Wrong side:
 *     any         → 0.10–0.40
 */
function scoreVwap(tfs: TimeframeIndicators[], dir: SignalDirection): number {
  const sign = dirSign(dir);
  if (sign === 0) return 0.5;

  let total = 0, wSum = 0;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i]!;
    if (!tf.vwap) continue;
    const w = TF_WEIGHTS[i] ?? 0.1;
    const aligned = sign * tf.vwap.priceVsVwap; // positive = right side of VWAP
    let score: number;

    if (aligned <= 0) {
      // Wrong side of VWAP: 0.10 (far wrong) to 0.40 (barely wrong)
      score = clamp(0.40 + aligned * 1.5, 0.10, 0.40);
    } else if (aligned <= 0.10) {
      // Just crossed: 0.60 → 0.75
      score = 0.60 + (aligned / 0.10) * 0.15;
    } else if (aligned <= 0.25) {
      // Sweet spot: 0.75 → 0.90
      score = 0.75 + ((aligned - 0.10) / 0.15) * 0.15;
    } else if (aligned <= 0.40) {
      // Getting extended: 0.90 → 0.70
      score = 0.90 - ((aligned - 0.25) / 0.15) * 0.20;
    } else if (aligned <= 0.60) {
      // Overextended: 0.70 → 0.50
      score = 0.70 - ((aligned - 0.40) / 0.20) * 0.20;
    } else {
      // Extreme: 0.50 → 0.30
      score = clamp(0.50 - ((aligned - 0.60) / 0.40) * 0.20, 0.30, 0.50);
    }

    total += score * w;
    wSum += w;
  }
  return wSum > 0 ? total / wSum : 0.5;
}

// (scoreDI and scoreOBV removed — logic inlined into Layer 1/Layer 2 functions)

/**
 * TD Sequential score: setup count alignment with trade direction.
 * sell setup = prices rising → bullish confirmation.
 * Higher count = stronger persistence, completed (9) = tempered for exhaustion.
 */
function scoreSeq(tfs: TimeframeIndicators[], dir: SignalDirection): number {
  const sign = dirSign(dir);
  if (sign === 0) return 0.5;

  const ltf = tfs[0];
  if (!ltf) return 0.5;

  const { setup } = ltf.td;
  const aligned =
    (sign > 0 && setup.direction === 'sell') ||
    (sign < 0 && setup.direction === 'buy');
  const opposing =
    (sign > 0 && setup.direction === 'buy') ||
    (sign < 0 && setup.direction === 'sell');

  if (aligned) {
    return setup.completed ? 0.60 : clamp(0.5 + (setup.count / 9) * 0.40, 0.5, 0.90);
  } else if (opposing) {
    return clamp(0.5 - (setup.count / 9) * 0.35, 0.15, 0.50);
  }
  return 0.50;
}

/**
 * ADX score: trend strength + slope (direction-agnostic strength measure).
 * ADX 50 → 1.0, ADX 25 → 0.5, ADX 0 → 0.0. Rising ADX boosts, falling penalizes.
 */
function scoreADX(tfs: TimeframeIndicators[]): number {
  const htf = tfs[tfs.length - 1];
  if (!htf) return 0.5;

  const { adx, adxSlope } = htf.dmi;
  let score = clamp(adx / 50, 0, 1);

  if (adxSlope > 0) score = clamp(score + Math.min(0.10, adxSlope / 20), 0, 1);
  else if (adxSlope < 0) score = clamp(score + Math.max(-0.10, adxSlope / 20), 0, 1);

  return score;
}

// ── Layer 1: Direction Strength (0..1) ──────────────────────────────────────
// How strongly do indicators agree on the direction?

function scoreDirectionStrength(tfs: TimeframeIndicators[], dir: SignalDirection): number {
  const sign = dirSign(dir);
  if (sign === 0) return 0;

  // A. DI spread alignment (50%) — absolute spread across TFs
  let diSpreadScore = 0, diW = 0;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i]!;
    const w = TF_WEIGHTS[i] ?? 0.1;
    const spread = sign > 0 ? (tf.dmi.plusDI - tf.dmi.minusDI) : (tf.dmi.minusDI - tf.dmi.plusDI);
    diSpreadScore += clamp(0.5 + spread / 50, 0, 1) * w;
    diW += w;
  }
  diSpreadScore = diW > 0 ? diSpreadScore / diW : 0.5;

  // B. OBV trend alignment (30%) — volume direction matches price direction
  let obvTrendScore = 0, obvW = 0;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i]!;
    const w = TF_WEIGHTS[i] ?? 0.1;
    let s = 0.45;
    if ((sign > 0 && tf.obv.trend === 'bullish') || (sign < 0 && tf.obv.trend === 'bearish')) s = 0.80;
    else if ((sign > 0 && tf.obv.trend === 'bearish') || (sign < 0 && tf.obv.trend === 'bullish')) s = 0.15;
    obvTrendScore += s * w;
    obvW += w;
  }
  obvTrendScore = obvW > 0 ? obvTrendScore / obvW : 0.45;

  // C. Multi-TF alignment (20%) — how many TFs agree on direction
  let aligned = 0;
  for (const tf of tfs) {
    if ((sign > 0 && tf.dmi.trend === 'bullish') || (sign < 0 && tf.dmi.trend === 'bearish')) aligned++;
  }
  const alignScore = tfs.length > 0 ? aligned / tfs.length : 0;

  return diSpreadScore * 0.50 + obvTrendScore * 0.30 + alignScore * 0.20;
}

// ── Layer 2: Entry Quality (0..1) ───────────────────────────────────────────
// Is this a good TIME to enter? Scores timing, not direction.

function scoreEntryQuality(tfs: TimeframeIndicators[], dir: SignalDirection): number {
  const sign = dirSign(dir);
  if (sign === 0) return 0;

  // A. DI slope — momentum freshness (30%)
  //    Positive slope = accelerating (early in move) → high
  //    Negative slope = decelerating (late/reversal) → low
  let slopeScore = 0, slopeW = 0;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i]!;
    const w = TF_WEIGHTS[i] ?? 0.1;
    const slopeAligned = sign * tf.dmi.diSpreadSlope;
    let s: number;
    if (slopeAligned > 5) s = 0.95;
    else if (slopeAligned > 2) s = 0.80;
    else if (slopeAligned > 0) s = 0.60;
    else if (slopeAligned > -2) s = 0.35;
    else if (slopeAligned > -5) s = 0.15;
    else s = 0.05;

    // Fresh DI cross = definitive timing signal → boost
    const hasCross = (sign > 0 && tf.dmi.recentCrossUp) || (sign < 0 && tf.dmi.recentCrossDown);
    const hasGrowthCross = (sign > 0 && tf.dmi.growthCrossUp) || (sign < 0 && tf.dmi.growthCrossDown);
    if (hasGrowthCross) s = Math.max(s, 0.95);
    else if (hasCross) s = Math.max(s, 0.85);

    slopeScore += s * w;
    slopeW += w;
  }
  slopeScore = slopeW > 0 ? slopeScore / slopeW : 0.5;

  // B. VWAP extension — inverted-U (25%)
  //    Moderate extension is best, extreme is bad
  const vwapScore = scoreVwap(tfs, dir);

  // C. OBV divergence — volume quality warning (20%)
  //    No divergence = neutral, supporting = good, opposing = bad
  let divScore = 0, divW = 0;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i]!;
    const w = TF_WEIGHTS[i] ?? 0.1;
    let s = 0.55; // neutral — no divergence
    if ((sign > 0 && tf.obv.divergence === 'bullish') || (sign < 0 && tf.obv.divergence === 'bearish')) {
      s = 0.85; // volume supports before price confirms
    } else if ((sign > 0 && tf.obv.divergence === 'bearish') || (sign < 0 && tf.obv.divergence === 'bullish')) {
      s = 0.10; // volume strongly contradicts — worst timing signal
    }
    divScore += s * w;
    divW += w;
  }
  divScore = divW > 0 ? divScore / divW : 0.55;

  // D. ADX context (15%) — trend strength supports the entry
  const adxScore = scoreADX(tfs);

  // E. TD Sequential — exhaustion risk (10%)
  const seqScore = scoreSeq(tfs, dir);

  // Backtest-tuned weights: DI slope (slopeScore) at 0.30 rewarded chasing —
  // high slope = move already happening. Reduce to 0.15, redistribute to
  // VWAP extension (mean-reversion risk) and OBV divergence (volume quality).
  return slopeScore * 0.15 + vwapScore * 0.30 + divScore * 0.30 + adxScore * 0.15 + seqScore * 0.10;
}

// ── Main Confidence Builder (2-layer multiplicative) ────────────────────────

function buildConfidence(signal: SignalPayload): ConfidenceBreakdown {
  const { timeframes: tfs, direction } = signal;

  // Layer 1: Direction Strength — does the market agree?
  const dirStrength = scoreDirectionStrength(tfs, direction);

  // Layer 2: Entry Quality — is this a good time?
  const entryQuality = scoreEntryQuality(tfs, direction);

  // Asymmetric multiplicative combination: direction strength matters more.
  // Backtest (Mar 2026, 117 entries): entries with high dirStrength and low
  // entryQuality were GOOD (r=+0.20); high entryQuality alone was counter-
  // predictive (r=-0.20) — entry quality model rewards chasing.
  // Old: sqrt(dir * quality) = dir^0.5 * quality^0.5 (equal weight)
  // New: dir^0.65 * quality^0.35 (direction-dominant)
  let total = clamp(Math.pow(dirStrength, 0.65) * Math.pow(entryQuality, 0.35), 0, 1);

  // Soft compression above 0.78: very high confidence entries (80%+) were
  // 0/3 GOOD in backtest — the model is most confident when chasing.
  if (total > 0.78) {
    total = 0.78 + (total - 0.78) * 0.30;
  }

  // Map into ConfidenceBreakdown for transparency.
  // base = direction strength, the bonuses show entry quality components.
  // Note: slopeScore is computed inside scoreEntryQuality; recompute for breakdown.
  const sign = dirSign(direction);
  let breakdownSlope = 0, bsW = 0;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i]!;
    const w = TF_WEIGHTS[i] ?? 0.1;
    const slopeAligned = sign * tf.dmi.diSpreadSlope;
    let s: number;
    if (slopeAligned > 5) s = 0.95;
    else if (slopeAligned > 2) s = 0.80;
    else if (slopeAligned > 0) s = 0.60;
    else if (slopeAligned > -2) s = 0.35;
    else if (slopeAligned > -5) s = 0.15;
    else s = 0.05;
    breakdownSlope += s * w;
    bsW += w;
  }
  breakdownSlope = bsW > 0 ? breakdownSlope / bsW : 0.5;

  return {
    base: dirStrength,
    vwapBonus: scoreVwap(tfs, direction) * 0.30,           // VWAP extension (quality)
    diSpreadBonus: dirStrength * 0.50,                      // DI spread (direction)
    obvBonus: breakdownSlope * 0.15,                        // DI slope freshness (quality)
    tdAdjustment: scoreSeq(tfs, direction) * 0.10,          // TD sequential (quality)
    adxBonus: scoreADX(tfs) * 0.15,                         // ADX context (quality)
    // Repurpose fields for layer transparency
    trendPhaseBonus: entryQuality,                          // full entry quality score
    momentumAccelBonus: dirStrength - entryQuality,         // gap between layers (positive = strong dir)
    // Unused components zeroed
    diCrossBonus: 0,
    alignmentBonus: 0,
    oiVolumeBonus: 0,
    pricePositionAdjustment: 0,
    adxMaturityPenalty: 0,
    structureBonus: 0,
    orbBonus: 0,
    recentPriceActionBonus: 0,
    trContractionPenalty: 0,
    lowVolPenalty: 0,
    moveExhaustionPenalty: 0,
    consolidationPenalty: 0,
    nearLevelPenalty: 0,
    thetaDecayPenalty: 0,
    narrowRangePenalty: 0,
    candlePatternBonus: 0,
    priceVelocityBonus: 0,
    volumeSurgeBonus: 0,
    trendPersistenceBonus: 0,
    total,
  };
}

// ── Direction Override ───────────────────────────────────────────────────────

/**
 * Override direction using leading indicators when DMI majority vote lags.
 *
 * Uses a weighted warning score from 5 conditions:
 *   1. VWAP extension — how far price has moved from VWAP
 *   2. DI slope — momentum acceleration/deceleration
 *   3. OBV — volume trend or divergence opposing direction
 *   4. Price velocity — raw price ROC opposing direction
 *   5. LTF DMI flip — fastest timeframe already reversed
 *
 * Tiered thresholds:
 *   - Extreme VWAP (>0.50%) + any 1 other signal → flip
 *   - Strong VWAP (>0.30%) + score >= 2.0 → flip
 *   - No VWAP requirement if score >= 3.0 (overwhelming evidence)
 */
function spyOverrideDirection(
  tfs: TimeframeIndicators[],
  direction: SignalDirection,
  _currentPrice: number,
): SignalDirection | null {
  if (direction === 'neutral') return null;
  const sign = direction === 'bullish' ? 1 : -1;

  let score = 0;

  // 1. VWAP extension (0 to 1.5 points based on severity)
  const ltfVwap = tfs[0]?.vwap?.priceVsVwap ?? 0;
  const vwapAligned = sign * ltfVwap; // positive = extended in our direction
  let vwapScore = 0;
  if (vwapAligned > 0.50) vwapScore = 1.5;       // extreme
  else if (vwapAligned > 0.35) vwapScore = 1.0;   // strong
  else if (vwapAligned > 0.25) vwapScore = 0.5;   // moderate
  score += vwapScore;

  // 2. DI slope decelerating (0 to 1.0 points)
  //    Weight LTF more (reacts first)
  const ltfSlope = sign * (tfs[0]?.dmi.diSpreadSlope ?? 0);
  const mtfSlope = sign * (tfs[1]?.dmi.diSpreadSlope ?? 0);
  const htfSlope = sign * (tfs[2]?.dmi.diSpreadSlope ?? 0);
  const weightedSlope = ltfSlope * 0.5 + mtfSlope * 0.3 + htfSlope * 0.2;
  if (weightedSlope < -3) score += 1.0;
  else if (weightedSlope < -1) score += 0.5;

  // 3. OBV opposing (0 to 1.0 points)
  //    OBV trend opposing is weaker signal; divergence is stronger
  for (const tf of tfs) {
    if ((direction === 'bullish' && tf.obv.divergence === 'bearish') ||
        (direction === 'bearish' && tf.obv.divergence === 'bullish')) {
      score += 1.0;
      break;
    }
    if ((direction === 'bullish' && tf.obv.trend === 'bearish') ||
        (direction === 'bearish' && tf.obv.trend === 'bullish')) {
      score += 0.5;
      break;
    }
  }

  // 4. Price velocity opposing (0 to 1.0 points)
  const ltfVelocity = tfs[0]?.priceVelocity;
  if (ltfVelocity) {
    const velAligned = sign * ltfVelocity.directionalVelocity;
    if (velAligned < -0.04) score += 1.0;       // strongly opposing
    else if (velAligned < -0.015) score += 0.5;  // mildly opposing
  }

  // 5. LTF DMI already flipped (0 to 1.0 points)
  const ltfDmi = tfs[0]?.dmi;
  if (ltfDmi) {
    const ltfOpposes = (direction === 'bullish' && ltfDmi.trend === 'bearish') ||
                       (direction === 'bearish' && ltfDmi.trend === 'bullish');
    if (ltfOpposes) score += 1.0;
  }

  // Tiered thresholds
  const flip = (vwapScore >= 1.5 && score >= 2.0)    // extreme VWAP + any 1 other
            || (vwapScore >= 1.0 && score >= 2.5)     // strong VWAP + decent evidence
            || (vwapScore >= 0.5 && score >= 3.0)     // moderate VWAP + strong evidence
            || (score >= 3.5);                         // overwhelming evidence, any VWAP

  if (flip) {
    return direction === 'bullish' ? 'bearish' : 'bullish';
  }

  return null;
}

// ── Strategy Export ─────────────────────────────────────────────────────────

/**
 * Stale data guard: block entries when recent LTF bars show near-zero price
 * variance. This catches stale/cached bars that produce artificial indicator
 * signals (e.g., Mar 3 2026 blowup: 60 minutes of identical $686.22 bars).
 */
function spyShouldAllowEntry(ctx: EntryContext): true | string {
  // Reject when key metrics are all zero — indicates flat/stale bar data
  if (ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 0.5
      && ctx.choppiness !== undefined && ctx.choppiness < 0.1
      && ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.001) {
    return `stale data: rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)} — all near zero`;
  }
  return true;
}

export const spyStrategy: PartialTickerStrategy = {
  computeTrendConfidence: (signal: SignalPayload, _option: OptionEvaluation) => buildConfidence(signal),
  computeRangeConfidence: (signal: SignalPayload) => buildConfidence(signal),
  computeBreakoutConfidence: (signal: SignalPayload) => buildConfidence(signal),
  overrideDirection: spyOverrideDirection,
  shouldAllowEntry: spyShouldAllowEntry,
};
