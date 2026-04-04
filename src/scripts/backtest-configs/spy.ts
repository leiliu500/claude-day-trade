/**
 * SPY backtest configuration.
 *
 * Clean baseline: dynamic 5-component confidence model with self-calibrating
 * weights (strategies/spy.ts). No static filters or confidence adjustments —
 * confidence is the sole entry criterion beyond the 2-stage gate.
 */

import type { TickerBacktestConfig } from './types.js';
import { simulateOrderAgentSpy } from '../../lib/order-agent-sim-spy.js';

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,

  // Effectively disabled — let confidence model handle quality
  trendMaxExhaustion: 999,

  maxDailyEntries: 6,

  // Strict trend phase for breakouts: require trendPhase >= 0, NO high-conf bypass.
  breakoutStrictTrendPhase: true,

  // Entry window: block first 30 min after open + last 30 min before close
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  // SPY-specific grade thresholds — lower than default to account for SPY's
  // lower intraday volatility (avg MFE ~0.19% vs IWM 0.33%, NVDA 0.53%)
  gradeA: 0.25,
  gradeB: 0.15,
  gradeC: 0.10,
  dirCorrectThreshold: 0.05,

  // No confidence adjustment — dynamic model handles everything
  adjustConfidence: (cb) => cb,

  // No entry filter — confidence is the sole gate
  shouldAllowEntry: () => true,

  // SPY-specific order simulation (higher premium floor, trailing stop floor)
  simulate: simulateOrderAgentSpy,
};
