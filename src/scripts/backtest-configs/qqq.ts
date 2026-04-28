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

// Bare baseline — no filters yet.
function qqqShouldAllowEntry(_ctx: EntryContext): true | string {
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
