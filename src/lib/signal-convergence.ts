/**
 * signal-convergence.ts — Measure how many independent indicator families
 * FRESHLY converged to confirm the signal direction within the last few bars.
 *
 * Universal pattern: entries where multiple independent signals align for the
 * FIRST TIME outperform entries where indicators have been aligned for 20 bars.
 * Fresh convergence = early in move = high edge.
 * Stale alignment = late in move = low edge.
 *
 * 5 independent signal families:
 *   1. Momentum (DI cross / growth cross)
 *   2. Volume (OBV trend flip)
 *   3. Price level (VWAP side cross)
 *   4. Price action (velocity acceleration + candle pattern)
 *   5. Trend strength (ADX slope turning positive)
 */

import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

export interface ConvergenceResult {
  /** Number of indicator families that freshly confirmed (0-5) */
  freshCount: number;
  /** Number of indicator families currently confirming (0-5, includes stale) */
  totalConfirming: number;
  /** Convergence score: 0.0 (no convergence) to 1.0 (all fresh) */
  score: number;
  /** Per-family detail */
  families: {
    momentum: { confirming: boolean; fresh: boolean };
    volume: { confirming: boolean; fresh: boolean };
    priceLevel: { confirming: boolean; fresh: boolean };
    priceAction: { confirming: boolean; fresh: boolean };
    trendStrength: { confirming: boolean; fresh: boolean };
  };
}

/**
 * Compute signal convergence across 3 timeframes.
 *
 * "Fresh" means the indicator CHANGED to confirming within the last 2-3 bars.
 * Uses HTF as primary (most reliable), MTF/LTF as supporting evidence.
 */
export function computeConvergence(
  tfs: TimeframeIndicators[],
  direction: SignalDirection,
): ConvergenceResult {
  const empty: ConvergenceResult = {
    freshCount: 0,
    totalConfirming: 0,
    score: 0,
    families: {
      momentum: { confirming: false, fresh: false },
      volume: { confirming: false, fresh: false },
      priceLevel: { confirming: false, fresh: false },
      priceAction: { confirming: false, fresh: false },
      trendStrength: { confirming: false, fresh: false },
    },
  };

  if (direction === 'neutral' || tfs.length < 3) return empty;

  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) return empty;

  const isBull = direction === 'bullish';

  // ── 1. Momentum: DI spread alignment + freshness via cross ──
  const htfDiAligned = isBull
    ? htf.dmi.plusDI > htf.dmi.minusDI
    : htf.dmi.minusDI > htf.dmi.plusDI;
  const htfDiCross = isBull ? htf.dmi.recentCrossUp : htf.dmi.recentCrossDown;
  const mtfDiCross = isBull ? mtf.dmi.recentCrossUp : mtf.dmi.recentCrossDown;
  const momentumConfirming = htfDiAligned;
  // Fresh = cross happened within last 2 bars on HTF or MTF
  const momentumFresh = htfDiCross || mtfDiCross;

  // ── 2. Volume: OBV trend alignment + freshness ──
  const htfObvAligned = htf.obv.trend === direction;
  const mtfObvAligned = mtf.obv.trend === direction;
  const volumeConfirming = htfObvAligned || mtfObvAligned;
  // Fresh = OBV divergence in our direction (volume leading price — freshest signal)
  // or OBV trend just flipped (both HTF and MTF weren't aligned before but now one is)
  const obvDivergence = isBull
    ? (htf.obv.divergence === 'bullish' || mtf.obv.divergence === 'bullish')
    : (htf.obv.divergence === 'bearish' || mtf.obv.divergence === 'bearish');
  const volumeFresh = obvDivergence;

  // ── 3. Price Level: VWAP side alignment + freshness ──
  const htfVwapAligned = isBull ? htf.vwap.priceVsVwap > 0 : htf.vwap.priceVsVwap < 0;
  const priceLevelConfirming = htfVwapAligned;
  // Fresh = price just crossed VWAP (within narrow band: |priceVsVwap| < 0.10%)
  // meaning it RECENTLY crossed, not been on the right side for 20 bars
  const priceLevelFresh = htfVwapAligned && Math.abs(htf.vwap.priceVsVwap) < 0.15;

  // ── 4. Price Action: velocity + candle confirmation ──
  const ltfVelAligned = isBull
    ? ltf.priceVelocity.directionalVelocity > 0.02
    : ltf.priceVelocity.directionalVelocity < -0.02;
  const candleConfirms = isBull
    ? (ltf.allCandlePatterns.bullishEngulfing.present || ltf.allCandlePatterns.hammer.present)
    : (ltf.allCandlePatterns.bearishEngulfing.present || ltf.allCandlePatterns.shootingStar.present);
  const priceActionConfirming = ltfVelAligned;
  // Fresh = acceleration positive (velocity is building, not sustained) OR candle pattern
  const priceActionFresh = (ltfVelAligned && ltf.priceVelocity.acceleration > 0.01) || candleConfirms;

  // ── 5. Trend Strength: ADX slope positive + freshness ──
  const htfAdxRising = htf.dmi.adxSlope > 0.5;
  const trendStrengthConfirming = htfAdxRising;
  // Fresh = ADX was below 20 and is now rising (new trend forming)
  // or growth cross (DI cross + rising ADX = phase change)
  const growthCross = isBull ? htf.dmi.growthCrossUp : htf.dmi.growthCrossDown;
  const trendStrengthFresh = growthCross || (htf.dmi.adx < 22 && htfAdxRising);

  // ── Assemble ──
  const families = {
    momentum:      { confirming: momentumConfirming, fresh: momentumFresh },
    volume:        { confirming: volumeConfirming, fresh: volumeFresh },
    priceLevel:    { confirming: priceLevelConfirming, fresh: priceLevelFresh },
    priceAction:   { confirming: priceActionConfirming, fresh: priceActionFresh },
    trendStrength: { confirming: trendStrengthConfirming, fresh: trendStrengthFresh },
  };

  const totalConfirming = Object.values(families).filter(f => f.confirming).length;
  const freshCount = Object.values(families).filter(f => f.fresh).length;

  // Score: weighted combination of fresh convergence and total alignment
  // Fresh convergence matters MORE than stale alignment
  //   5 fresh → 1.0 (perfect convergence)
  //   3 fresh + 2 stale → 0.70
  //   0 fresh + 5 stale → 0.25 (all aligned but stale)
  //   0 fresh + 0 confirming → 0.0
  const freshScore = freshCount / 5;
  const staleScore = (totalConfirming - freshCount) / 5;
  const score = Math.min(1.0, freshScore * 0.80 + staleScore * 0.20);

  return { freshCount, totalConfirming, score, families };
}

/**
 * Convert convergence result to a confidence adjustment.
 *
 * High convergence → bonus (up to +0.06)
 * Low convergence with stale alignment → penalty (up to -0.04)
 * This replaces part of the alignment bonus + DI cross bonus with a
 * single meta-feature that captures the universal "fresh convergence" pattern.
 */
export function convergenceAdjustment(conv: ConvergenceResult): number {
  if (conv.freshCount >= 4) return 0.06;   // 4-5 families freshly converging
  if (conv.freshCount >= 3) return 0.04;   // 3 families freshly converging
  if (conv.freshCount >= 2) return 0.02;   // 2 families freshly converging
  if (conv.freshCount >= 1) return 0.01;   // 1 family freshly converging

  // No fresh convergence — check stale alignment
  if (conv.totalConfirming >= 4) return -0.02; // all aligned but stale = late entry
  if (conv.totalConfirming >= 3) return -0.01; // mostly aligned but stale
  return 0; // mixed signals, no adjustment
}
