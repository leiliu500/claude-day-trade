/**
 * entry-gate.ts — Shared pure function for entry gate decisions.
 *
 * This is the SINGLE SOURCE OF TRUTH for all entry bypass/gate logic.
 * Both the live DecisionOrchestrator and the backtest call this function.
 *
 * The function is pure: no side effects, no API calls, no Date.now().
 * Callers provide pre-computed state (entry counts, cooldown ages, etc.).
 */

import type { SignalDirection, AlignmentType } from '../types/signal.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type GateResult =
  | 'PASSED'
  | 'STAGE1_OBSERVE'
  | 'HIGH_CONV_OVERRIDE'
  | 'PHASE_CHANGE_OVERRIDE';

export type GateBypassType =
  | 'high_conviction'
  | 'phase_change'
  | 'strong_signal'
  | 'trend_consolidation'
  | 'range'
  | 'breakout'
  | 'vwap_reversion'
  | 'stage2_confirm'
  | null;

export interface GateDecision {
  result: GateResult;
  bypass: GateBypassType;
  /** Whether the phase-change structural signal was present but rejected by timing. */
  phaseChangeTimingRejected: boolean;
  phaseChangeTimingRejectReason: string;
}

export interface GateInput {
  // Signal characteristics
  confidence: number;
  alignment: AlignmentType;
  direction: SignalDirection;
  signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none';
  strengthScore: number;

  // Confidence breakdown components needed for gate checks
  trendPhaseBonus: number;
  adxBonus: number;
  recentPriceActionBonus: number;
  nearLevelPenalty: number;

  // HTF indicators for phase-change check
  htf: {
    adx: number;
    growthCrossUp: boolean;
    growthCrossDown: boolean;
    rangePosition: number;
  } | null;

  // LTF VWAP for phase-change timing check
  ltfVwapPriceVsVwap: number | null;

  // ORB for phase-change timing check
  orbFormed: boolean;
  orbBreakoutDirection: string | null;

  // Range exhaustion for breakout check
  rangeExhaustion: number | null;

  // Pre-computed state (differs between live and backtest)
  priorCount: number;
  minutesSinceOpen: number;

  // Mode-specific state (pre-computed by caller)
  rangeEntryCount: number;
  /** Minutes since last range entry, null if no prior entry */
  lastRangeEntryAgeMin: number | null;
  breakoutEntryCount: number;
  lastBreakoutEntryAgeMin: number | null;
  vwapRevEntryCount: number;
  lastVwapRevEntryAgeMin: number | null;
  hasRecentPhaseChangeEntry: boolean;
  /** True when LTF bars show a tight consolidation breakout in signal direction. */
  trendConsolidationBreakout: boolean;
}

// ── Gate evaluation ─────────────────────────────────────────────────────────

export function evaluateEntryGate(input: GateInput): GateDecision {
  const {
    confidence, alignment, direction, signalMode, strengthScore,
    trendPhaseBonus, adxBonus, recentPriceActionBonus, nearLevelPenalty,
    htf, ltfVwapPriceVsVwap, orbFormed, orbBreakoutDirection,
    rangeExhaustion, priorCount, minutesSinceOpen,
    rangeEntryCount, lastRangeEntryAgeMin,
    breakoutEntryCount, lastBreakoutEntryAgeMin,
    vwapRevEntryCount, lastVwapRevEntryAgeMin,
    hasRecentPhaseChangeEntry,
    trendConsolidationBreakout,
  } = input;

  // ── High-conviction override ──
  const highConvOverride = confidence >= 0.92 && alignment === 'all_aligned';

  // ── Phase-change override ──
  const isBullish = direction === 'bullish';
  const growthCross = !!htf && (isBullish ? htf.growthCrossUp : htf.growthCrossDown);
  const phaseChangeStructuralOk = !!htf &&
    confidence >= 0.65 &&
    alignment !== 'mixed' &&
    growthCross &&
    htf.adx >= 20 &&
    recentPriceActionBonus >= 0 &&
    nearLevelPenalty > -0.03;

  let phaseChangeTimingOk = true;
  let phaseChangeTimingRejectReason = '';
  if (phaseChangeStructuralOk && htf) {
    const rp = htf.rangePosition;
    if (isBullish && rp > 0.85) {
      phaseChangeTimingOk = false;
      phaseChangeTimingRejectReason = `price at range extreme (rangePos=${rp.toFixed(2)}, bullish needs ≤0.85)`;
    } else if (!isBullish && rp < 0.15) {
      phaseChangeTimingOk = false;
      phaseChangeTimingRejectReason = `price at range extreme (rangePos=${rp.toFixed(2)}, bearish needs ≥0.15)`;
    }
    if (phaseChangeTimingOk && htf.adx > 50) {
      phaseChangeTimingOk = false;
      phaseChangeTimingRejectReason = `ADX exhausted (${htf.adx.toFixed(1)} > 50)`;
    }
    if (phaseChangeTimingOk && hasRecentPhaseChangeEntry) {
      phaseChangeTimingOk = false;
      phaseChangeTimingRejectReason = `already entered via phase-change for ${direction} recently — cooldown`;
    }
    if (phaseChangeTimingOk && ltfVwapPriceVsVwap != null) {
      if (isBullish && ltfVwapPriceVsVwap < -0.30) {
        phaseChangeTimingOk = false;
        phaseChangeTimingRejectReason = `price below VWAP (${ltfVwapPriceVsVwap.toFixed(2)}% < -0.30% for bullish)`;
      } else if (!isBullish && ltfVwapPriceVsVwap > 0.30) {
        phaseChangeTimingOk = false;
        phaseChangeTimingRejectReason = `price above VWAP (${ltfVwapPriceVsVwap.toFixed(2)}% > 0.30% for bearish)`;
      }
    }
    if (phaseChangeTimingOk && orbFormed) {
      if (isBullish && orbBreakoutDirection === 'bearish') {
        phaseChangeTimingOk = false;
        phaseChangeTimingRejectReason = `ORB breakout is bearish — bullish entry fights day momentum`;
      } else if (!isBullish && orbBreakoutDirection === 'bullish') {
        phaseChangeTimingOk = false;
        phaseChangeTimingRejectReason = `ORB breakout is bullish — bearish entry fights day momentum`;
      }
    }
  }
  const phaseChangeOk = phaseChangeStructuralOk && phaseChangeTimingOk;
  const phaseChangeTimingRejected = phaseChangeStructuralOk && !phaseChangeTimingOk;

  // ── Strong-signal bypass ──
  // conf >= 0.75 + all_aligned → immediate entry for ALL non-breakout modes.
  // Breakout is excluded: breakout entries have their own bypass with trendPhase >= 0.
  // Require non-negative PA: when recent candles are against the signal (PA < 0),
  // price is pulling back — defer to normal 2-stage gate so the pullback can resolve.
  // Apr 9 SPY: bypass at PA=-0.08 entered 20min before the move → 3 quick losses.
  // Same day: bypass at PA=0 entered during the trend → TP hit at +32%.
  const strongSignalBypass = !highConvOverride && !phaseChangeOk && priorCount < 1
    && signalMode !== 'breakout'
    && confidence >= 0.75 && alignment === 'all_aligned'
    && recentPriceActionBonus >= 0;

  // ── Trend consolidation breakout bypass ──
  // Price broke out of a tight consolidation within an established trend.
  // This is a "bull flag" / "bear flag" continuation pattern — the consolidation
  // IS the confirmation. Lower confidence bar (0.60) since the pattern itself
  // provides structural confirmation that the 2-stage gate normally requires.
  // Apr 16 SPY: 15-min consolidation at $699.65-$700.11, broke out at 11:00,
  // but system couldn't enter until 11:22 because confidence was 61-66% (below
  // the 0.75 strong-signal bar) and the entry gate blocked at Stage-1.
  const trendConsolBypass = !highConvOverride && !phaseChangeOk && !strongSignalBypass
    && priorCount < 1
    && signalMode === 'trend'
    && alignment === 'all_aligned'
    && trendConsolidationBreakout
    && confidence >= 0.60;

  // ── Range bypass ──
  let rangeBypass = false;
  if (signalMode === 'range' && priorCount < 1) {
    const RANGE_MIN_CONF = 0.70;
    const pastWaitPeriod = minutesSinceOpen >= 45;
    const meetsRangeThreshold = confidence >= RANGE_MIN_CONF;
    const underLimit = rangeEntryCount < 1; // max 1 range entry per day
    const cooldownOk = lastRangeEntryAgeMin == null || lastRangeEntryAgeMin >= 20;
    rangeBypass = meetsRangeThreshold && pastWaitPeriod && underLimit && cooldownOk;
  }

  // ── Breakout bypass ──
  let breakoutBypass = false;
  if (signalMode === 'breakout' && priorCount < 1) {
    const pastWaitPeriod = minutesSinceOpen >= 45;
    const notTooLate = minutesSinceOpen < 360; // 15:30 ET = open + 6h
    const alignmentOk = alignment !== 'mixed';
    const trendPhaseOk = trendPhaseBonus >= 0;
    const adxOk = adxBonus >= 0.03;
    const strengthOk = strengthScore >= 35;
    const notExhausted = rangeExhaustion == null || rangeExhaustion <= 10.0;
    const underLimit = breakoutEntryCount < 2;
    const cooldownOk = lastBreakoutEntryAgeMin == null || lastBreakoutEntryAgeMin >= 30;
    breakoutBypass = pastWaitPeriod && underLimit && cooldownOk && notTooLate &&
      alignmentOk && trendPhaseOk && adxOk && strengthOk && notExhausted;
  }

  // ── VWAP reversion bypass ──
  let vwapRevBypass = false;
  if (signalMode === 'vwap_reversion' && priorCount < 1) {
    const VWAP_REV_MIN_CONF = 0.68;
    const pastWaitPeriod = minutesSinceOpen >= 30;
    const meetsThreshold = confidence >= VWAP_REV_MIN_CONF;
    const underLimit = vwapRevEntryCount < 1;
    const cooldownOk = lastVwapRevEntryAgeMin == null || lastVwapRevEntryAgeMin >= 15;
    vwapRevBypass = meetsThreshold && pastWaitPeriod && underLimit && cooldownOk;
  }

  // ── Final decision ──
  // Daily risk budget is enforced downstream in safety-gates (DAILY_RISK_BUDGET_GATE)
  // where the proposed cost is known, instead of a hard entry-count cap here.
  const anyBypass = highConvOverride || phaseChangeOk || strongSignalBypass ||
    trendConsolBypass || rangeBypass || breakoutBypass || vwapRevBypass;

  if (!anyBypass && priorCount < 1) {
    return { result: 'STAGE1_OBSERVE', bypass: null, phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }

  // Determine which bypass fired (in priority order matching live DecisionOrchestrator)
  if (rangeBypass) {
    return { result: 'PASSED', bypass: 'range', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }
  if (breakoutBypass) {
    return { result: 'PASSED', bypass: 'breakout', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }
  if (vwapRevBypass) {
    return { result: 'PASSED', bypass: 'vwap_reversion', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }
  if (strongSignalBypass) {
    return { result: 'PASSED', bypass: 'strong_signal', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }
  if (trendConsolBypass) {
    return { result: 'PASSED', bypass: 'trend_consolidation', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }
  if (phaseChangeOk && priorCount < 1 && !highConvOverride) {
    return { result: 'PHASE_CHANGE_OVERRIDE', bypass: 'phase_change', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }
  if (highConvOverride) {
    return { result: 'HIGH_CONV_OVERRIDE', bypass: 'high_conviction', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
  }

  // priorCount >= 1 — stage-2 confirmation
  return { result: 'PASSED', bypass: 'stage2_confirm', phaseChangeTimingRejected, phaseChangeTimingRejectReason };
}
