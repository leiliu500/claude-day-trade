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
function iwmShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.08) return `atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'breakout' && atrPct < 0.13) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.13%`;

  if (ctx.displacementVelocity < -0.003) return `dvel ${ctx.displacementVelocity.toFixed(4)} < -0.003`;

  if (signalMode === 'trend') {
    if (cb.trendPhaseBonus < 0) return `trend trendPhase ${cb.trendPhaseBonus.toFixed(3)} < 0`;
    if (ctx.choppiness >= 0.55) return `trend choppiness ${ctx.choppiness.toFixed(2)} >= 0.55`;
    if (ctx.rangeExhaustion >= 7.0 && ctx.displacementVelocity < 0.10) return `trend exhausted+lowDvel rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)}`;
  }

  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
    if (ctx.regimeScore < 60) return `breakout regime ${ctx.regimeScore} < 60`;
    if (ctx.choppiness >= 0.95) return `breakout choppiness ${ctx.choppiness.toFixed(2)} >= 0.95`;
    if (ctx.regimeScore >= 75) return `breakout regime ${ctx.regimeScore} >= 75`;
    if (ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.06
        && ctx.displacementVelocity >= 0) return `breakout lowDvel ${ctx.displacementVelocity.toFixed(4)} < 0.06`;
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
