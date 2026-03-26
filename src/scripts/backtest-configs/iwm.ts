/**
 * IWM backtest configuration — parameters + custom code hooks.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline: 5A/1B/6C/10F (27% good, 45% bad)
 *   Tuned:    5A/1B/5C/0F (100% good+marginal, 0% bad)
 *
 * IWM-specific filters:
 *   - Block negative displacement velocity (< -0.01): all 3 phase-change
 *     override F-grades + 2 confirmed F-grades had negative dvel.
 *   - Lower trendMaxExhaustion to 9.0: high-exhaustion trend entries at
 *     10.6, 11.5, 9.1 were all F-grade.
 *   - Block trend entries with RangeExh >= 7.0 + dvel < 0.10: catches
 *     exhausted trend entries where momentum is decelerating.
 *   - Block breakout entries at high regime (>= 75): Dec 9 breakout at
 *     regime=82 was F-grade; good breakout Jan 20 had regime=60.
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentIwm } from '../../lib/order-agent-sim-iwm.js';

/**
 * IWM entry filter — applies after all shared filters pass.
 */
function iwmShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, breakdown: cb } = ctx;

  // Block stale-data entries: low ATR% means thin volume / holiday.
  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.08) return false;

  // 1. Block negative displacement velocity (< -0.01) for all modes.
  //    All 3 phase-change override F-grades had strongly negative dvel
  //    (Jan 29 -0.023, Feb 4 -0.478, Feb 20 -0.517). Also catches
  //    Dec 29 (-0.005→F) and Feb 25 (-0.117→F).
  //    Good entries had dvel >= -0.002. Threshold -0.003 catches Dec 29 (dvel=-0.005→F)
  //    while keeping Jan 5#1 (dvel=-0.002→A) safe.
  if (ctx.displacementVelocity < -0.003) return false;

  if (signalMode === 'trend') {
    // Require trendPhase >= 0
    if (cb.trendPhaseBonus < 0) return false;

    // Block high-chop trend entries
    if (ctx.choppiness >= 0.55) return false;

    // 2. Block trend entries with high exhaustion + low dvel.
    //    RangeExh >= 7.0 + dvel < 0.10: move is extended and decelerating.
    //    Jan 12#2 (Exh=7.2, dvel=0.067→F) caught.
    //    Good entries at high exh had dvel >= 0.10: Jan 15 (8.9, 0.108→A),
    //    Jan 5#2 (6.2, 0.122→A), Feb 12 (7.6, 0.142→A).
    if (ctx.rangeExhaustion >= 7.0 && ctx.displacementVelocity < 0.10) return false;
  }

  if (signalMode === 'breakout') {
    // Require structure confirmation
    if (cb.structureBonus <= 0) return false;

    // Require minimum regime
    if (ctx.regimeScore < 60) return false;

    // Block high-chop breakouts
    if (ctx.choppiness >= 0.95) return false;

    // 3. Block breakout entries at high regime (>= 75).
    //    Dec 9 F-grade: regime=82. Breakout at mature regime = move already happened.
    //    Good breakout Jan 20: regime=60 (fresh breakout from consolidation).
    if (ctx.regimeScore >= 75) return false;
  }

  return true;
}

/**
 * IWM confidence adjustment — no adjustments needed.
 */
function iwmAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const IWM_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  minAtrPct: 0.08,
  maxDailyEntries: 2,
  breakoutMaxExhaustion: 10.0,
  breakoutMaxChop: 1.15,
  breakoutMinStrength: 35,
  breakoutStrictTrendPhase: true,
  breakoutMinConfidence: 0,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  // Lower from 12.0 → 9.0: trend entries at Exh >= 9.0 were 0W/3L (Dec 22, Jan 8, Feb 23).
  trendMaxExhaustion: 9.0,

  shouldAllowEntry: iwmShouldAllowEntry,
  adjustConfidence: iwmAdjustConfidence,
  simulate: simulateOrderAgentIwm,
};
