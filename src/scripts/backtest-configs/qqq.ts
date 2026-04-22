/**
 * QQQ backtest configuration.
 *
 * Baseline cloned from backtest-configs/spy.ts on 2026-04-22 — SPY filters,
 * confidence adjustments, and parameters are the starting point for tuning
 * QQQ. Replace / extend below as QQQ-specific backtest evidence emerges.
 *
 * The order-simulation function remains `simulateOrderAgentQqq`, which is
 * itself cloned from the SPY sim.
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentQqq } from '../../lib/order-agent-sim-qqq.js';

/**
 * QQQ entry filter — mirrors spyShouldAllowEntry.
 */
function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice, displacementVelocity } = ctx;
  const regime = ctx.regimeScore;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'breakout' && displacementVelocity < -0.05) return `breakout dvel ${displacementVelocity.toFixed(4)} < -0.05`;
  if (signalMode === 'trend' && atr < 0.45) return `trend atr ${atr.toFixed(3)} < 0.45`;
  if (signalMode === 'trend'
      && ctx.rangeExhaustion > 6.0
      && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  if (signalMode === 'trend'
      && ctx.rangeExhaustion >= 8.0
      && displacementVelocity < 0.04
      && ctx.alignment !== 'all_aligned') return `trend exhausted+fading rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${displacementVelocity.toFixed(4)} (stalled)`;
  if (direction === 'bullish' && displacementVelocity < -0.04) return `bullish dvel ${displacementVelocity.toFixed(4)} < -0.04`;
  if (signalMode === 'breakout' && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;
  if (signalMode === 'breakout'
      && ctx.choppiness >= 0.90 && ctx.displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)}`;
  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion >= 9.0 && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  if (signalMode === 'breakout' && ctx.choppiness >= 2.0) return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;
  if (signalMode === 'breakout' && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;
  if (signalMode === 'breakout' && regime >= 80) return `breakout regime ${regime} >= 80`;
  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion >= 4.5 && regime >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${regime}`;

  return true;
}

/**
 * QQQ confidence adjustment — mirrors spyAdjustConfidence.
 */
function qqqAdjustConfidence(breakdown: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  let bd = breakdown;
  const regime = ctx.regimeScore;

  // Reversal trap penalty: trendPhase flat/declining + strong PA = stale signal.
  if (ctx.signalMode === 'trend'
      && bd.trendPhaseBonus <= 0
      && bd.recentPriceActionBonus >= 0.06) {
    bd = { ...bd };
    const penalty = 0.06;
    bd.recentPriceActionBonus -= Math.min(bd.recentPriceActionBonus, penalty);
    bd.total -= penalty;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && regime >= 75 && bd.recentPriceActionBonus > 0) {
    bd = bd === breakdown ? { ...bd } : bd;
    bd.total -= bd.recentPriceActionBonus;
    bd.recentPriceActionBonus = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }
  return bd;
}

export const QQQ_CONFIG: Partial<TickerBacktestConfig> = {
  // trendMaxExhaustion effectively disabled — trend_exhausted_reverting (dvel<0) catches actual reversals.
  trendMaxExhaustion: 999,

  dailyRiskBudgetPct: 0.05,

  // Strict trend phase for breakouts: require trendPhase >= 0, NO high-conf bypass.
  breakoutStrictTrendPhase: true,

  // Entry window: block first 30 min after open + last 30 min before close
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  adjustConfidence: qqqAdjustConfidence,
  shouldAllowEntry: qqqShouldAllowEntry,

  // QQQ-specific order simulation (currently cloned from SPY sim)
  simulate: simulateOrderAgentQqq,
};
