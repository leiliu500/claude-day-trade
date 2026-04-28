/**
 * QQQ backtest configuration — built from scratch via QQQ-specific F-mining.
 *
 * Built from scratch 2026-04-28. All filters will be derived from 15-mo QQQ
 * F-cluster mining. See strategies/qqq.ts for the full filter chain (single
 * source of truth — backtest delegates to LIVE_TICKER_CFG).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentQqq } from '../../lib/order-agent-sim-qqq.js';

function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  // v1: bullish low-atr (any mode) — see strategies/qqq.ts.
  if (ctx.direction === 'bullish' && ctx.atr < 0.60) {
    return `bullish low atr ${ctx.atr.toFixed(2)} < 0.60`;
  }
  // v2: bullish afternoon 210-300m — see strategies/qqq.ts.
  if (ctx.direction === 'bullish'
      && ctx.minutesSinceOpen >= 210 && ctx.minutesSinceOpen < 300) {
    return `bullish afternoon ${ctx.minutesSinceOpen}m (14:00-15:30 ET)`;
  }
  // v3: bullish post-lunch 150-210m — see strategies/qqq.ts.
  if (ctx.direction === 'bullish'
      && ctx.minutesSinceOpen >= 150 && ctx.minutesSinceOpen < 210) {
    return `bullish post-lunch ${ctx.minutesSinceOpen}m (12:00-13:30 ET)`;
  }
  return true;
}

function qqqAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const QQQ_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  dailyRiskBudgetPct: 0.05,

  // Entry window: block first 30 min after open + last 30 min before close.
  // Same convention as SPY/IWM/DIA — open/EOD buckets typically lose money.
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  shouldAllowEntry: qqqShouldAllowEntry,
  adjustConfidence: qqqAdjustConfidence,
  simulate: simulateOrderAgentQqq,
};
