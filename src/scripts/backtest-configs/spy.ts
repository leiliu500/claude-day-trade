/**
 * SPY backtest configuration — built from scratch via SPY-specific F-mining.
 *
 * Built from scratch 2026-04-28. All filters derived from 15-mo SPY F-cluster
 * mining. See strategies/spy.ts for the full filter chain (single source of
 * truth — backtest delegates to LIVE_TICKER_CFG).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentSpy } from '../../lib/order-agent-sim-spy.js';

function spyShouldAllowEntry(ctx: EntryContext): true | string {
  // v1: bullish low-atr (any mode) — see strategies/spy.ts.
  if (ctx.direction === 'bullish' && ctx.atr < 0.60) {
    return `bullish low atr ${ctx.atr.toFixed(2)} < 0.60`;
  }
  // v2: bearish-trend mid-conf [0.70, 0.90) — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.confidence >= 0.70 && ctx.confidence < 0.90) {
    return `bearish-trend mid-conf ${(ctx.confidence * 100).toFixed(0)}% anti-predictive`;
  }
  // v8: bearish-trend high-conf [0.90, 1.0) — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.confidence >= 0.90) {
    return `bearish-trend high-conf ${(ctx.confidence * 100).toFixed(0)}% anti-predictive`;
  }
  // v3: bullish-trend low-atr extension to 0.80 — see strategies/spy.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend' && ctx.atr < 0.80) {
    return `bullish-trend low atr ${ctx.atr.toFixed(2)} < 0.80`;
  }
  // v4: bearish-breakout low-atr <0.60 — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout' && ctx.atr < 0.60) {
    return `bearish-breakout low atr ${ctx.atr.toFixed(2)} < 0.60`;
  }
  // v10: bearish-breakout mid-atr [0.70, 1.00) — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout'
      && ctx.atr >= 0.70 && ctx.atr < 1.00) {
    return `bearish-breakout mid-atr ${ctx.atr.toFixed(2)} in [0.70, 1.00)`;
  }
  // v5: bearish-trend mid-atr [0.40, 0.60) — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.atr >= 0.40 && ctx.atr < 0.60) {
    return `bearish-trend mid-atr ${ctx.atr.toFixed(2)} in [0.40, 0.60)`;
  }
  // v12: bearish-trend lunch-flank × mid-atr — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen >= 90 && ctx.minutesSinceOpen < 150
      && ctx.atr >= 0.60 && ctx.atr < 0.80) {
    return `bearish-trend lunch-flank × mid-atr ${ctx.atr.toFixed(2)} ${ctx.minutesSinceOpen}m`;
  }
  // v11: bearish-trend pre-lunch (105-135m) — see strategies/spy.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen >= 105 && ctx.minutesSinceOpen < 135) {
    return `bearish-trend pre-lunch ${ctx.minutesSinceOpen}m (11:15-11:45 ET)`;
  }
  // v6: bullish-trend lunch dead-zone (105-150m) — see strategies/spy.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen >= 105 && ctx.minutesSinceOpen < 150) {
    return `bullish-trend lunch ${ctx.minutesSinceOpen}m (11:15-12:30 ET)`;
  }
  // v9: bullish-trend post-lunch (150-210m) — see strategies/spy.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen >= 150 && ctx.minutesSinceOpen < 210) {
    return `bullish-trend post-lunch ${ctx.minutesSinceOpen}m (12:00-13:30 ET)`;
  }
  // v7: bullish-breakout low-atr <0.80 — see strategies/spy.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout' && ctx.atr < 0.80) {
    return `bullish-breakout low atr ${ctx.atr.toFixed(2)} < 0.80`;
  }
  return true;
}

function spyAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  dailyRiskBudgetPct: 0.05,

  // Entry window: block first 30 min after open + last 30 min before close.
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  shouldAllowEntry: spyShouldAllowEntry,
  adjustConfidence: spyAdjustConfidence,
  simulate: simulateOrderAgentSpy,
};
