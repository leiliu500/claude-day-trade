/**
 * DIA backtest configuration — built from scratch via DIA-specific F-mining.
 *
 * Built from scratch 2026-04-27 (NOT a SPY/IWM clone). All filters were derived
 * from 15-mo DIA F-cluster mining, factor orthogonality, time-of-day analysis,
 * and direction × mode breakdowns. See strategies/dia.ts for the full filter
 * chain (single source of truth — backtest delegates to LIVE_TICKER_CFG).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentDia } from '../../lib/order-agent-sim-dia.js';

// Backtest-side mirror of strategies/dia.ts diaShouldAllowEntry. Kept in sync
// because backtest-day.ts also calls TCFG.shouldAllowEntry on some code paths
// (rare but exists). Order matches the strategy file exactly.
function diaShouldAllowEntry(ctx: EntryContext): true | string {
  if (ctx.minutesSinceOpen >= 180 && ctx.minutesSinceOpen < 210) {
    return `midday-deep ${ctx.minutesSinceOpen}m (12:30-13:00 ET)`;
  }
  if (ctx.minutesSinceOpen >= 270 && ctx.minutesSinceOpen < 360) {
    return `mid-afternoon ${ctx.minutesSinceOpen}m (14:00-15:30 ET)`;
  }
  if (ctx.atr < 0.35) {
    return `atr ${ctx.atr.toFixed(2)} < 0.35 (dead zone)`;
  }
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout') {
    return `bullish breakout (15-mo exp -0.736)`;
  }
  if (ctx.direction === 'bearish'
      && ctx.minutesSinceOpen >= 60 && ctx.minutesSinceOpen < 90) {
    return `bearish 10:30-11:00 ET window ${ctx.minutesSinceOpen}m`;
  }
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout' && ctx.atr < 0.50) {
    return `bearish breakout low-atr ${ctx.atr.toFixed(2)} < 0.50`;
  }
  if (ctx.direction === 'bearish' && ctx.signalMode !== 'breakout'
      && (ctx.atr < 0.40 || ctx.regimeScore < 50)) {
    return `bearish trend weak (atr=${ctx.atr.toFixed(2)} regime=${ctx.regimeScore})`;
  }
  if (ctx.direction === 'bullish' && ctx.signalMode !== 'breakout' && ctx.atr < 0.40) {
    return `bullish trend low-atr ${ctx.atr.toFixed(2)} < 0.40 (no-A zone)`;
  }
  if (ctx.direction === 'bullish' && ctx.signalMode !== 'breakout'
      && ctx.rangeExhaustion >= 7.0 && ctx.choppiness >= 2.0) {
    return `bullish trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  }
  if (ctx.direction === 'bearish' && ctx.signalMode !== 'breakout'
      && ctx.strengthScore >= 40 && ctx.strengthScore < 80 && ctx.atr < 0.55) {
    return `bearish trend mid-strength+lowAtr s=${ctx.strengthScore} atr=${ctx.atr.toFixed(2)}`;
  }
  return true;
}

function diaAdjustConfidence(cb: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  let bd = cb;
  if (bd.trendPhaseBonus <= 0 && bd.moveExhaustionPenalty !== 0) {
    bd = { ...bd };
    bd.total -= bd.moveExhaustionPenalty;
    bd.moveExhaustionPenalty = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }
  if (ctx.signalMode !== 'breakout'
      && bd.trendPhaseBonus <= 0
      && bd.recentPriceActionBonus >= 0.06) {
    bd = bd === cb ? { ...bd } : bd;
    const penalty = 0.06;
    bd.recentPriceActionBonus -= Math.min(bd.recentPriceActionBonus, penalty);
    bd.total -= penalty;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }
  if (ctx.signalMode !== 'breakout'
      && ctx.alignment === 'all_aligned'
      && bd.trendPhaseBonus > 0
      && bd.adxBonus >= 0.05
      && bd.moveExhaustionPenalty <= -0.10) {
    bd = bd === cb ? { ...bd } : bd;
    const exhRelief = -bd.moveExhaustionPenalty * 0.5;
    bd.moveExhaustionPenalty *= 0.5;
    bd.total += exhRelief;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }
  return bd;
}

export const DIA_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  dailyRiskBudgetPct: 0.05,

  // Entry window: block first 30 min after open + last 30 min before close.
  // Same convention as SPY/QQQ/IWM/TSLA — 9:30+30m bucket exp -0.762 (worst by
  // raw count, n=202), 15:30+ bucket exp -1.319 (highest F-rate, 74%).
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  shouldAllowEntry: diaShouldAllowEntry,
  adjustConfidence: diaAdjustConfidence,
  simulate: simulateOrderAgentDia,
};
