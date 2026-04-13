/**
 * entry-gate.ts — Simplified entry gate.
 *
 * With the price-action confidence model, confidence directly reflects signal
 * quality. If confidence >= threshold, enter. No bypass paths needed.
 *
 * This is the SINGLE SOURCE OF TRUTH for all entry gate logic.
 * Both the live DecisionOrchestrator and the backtest call this function.
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
  lastRangeEntryAgeMin: number | null;
  breakoutEntryCount: number;
  lastBreakoutEntryAgeMin: number | null;
  vwapRevEntryCount: number;
  lastVwapRevEntryAgeMin: number | null;
  hasRecentPhaseChangeEntry: boolean;
}

// ── Gate evaluation ─────────────────────────────────────────────────────────

export function evaluateEntryGate(input: GateInput): GateDecision {
  const { confidence } = input;

  // Simple threshold check — the price-action confidence model produces
  // actionable confidence directly. No bypass paths needed.
  // The threshold is applied by the caller (analysis-agent.ts meetsEntryThreshold).
  // Here we just check: does the confidence meet the implied threshold?
  // Since the caller already checks meetsEntryThreshold, if we get here
  // confidence is above threshold. Accept it.
  if (confidence >= 0.65) {
    return {
      result: 'PASSED',
      bypass: null,
      phaseChangeTimingRejected: false,
      phaseChangeTimingRejectReason: '',
    };
  }

  return {
    result: 'STAGE1_OBSERVE',
    bypass: null,
    phaseChangeTimingRejected: false,
    phaseChangeTimingRejectReason: '',
  };
}
