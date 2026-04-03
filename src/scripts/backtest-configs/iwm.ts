/**
 * IWM backtest configuration.
 *
 * Clean baseline: same 2-layer multiplicative confidence model as SPY.
 * No static filters or confidence adjustments.
 */

import type { TickerBacktestConfig } from './types.js';
import { simulateOrderAgentIwm } from '../../lib/order-agent-sim-iwm.js';

export const IWM_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  trendMaxExhaustion: 999,
  maxDailyEntries: 6,
  breakoutStrictTrendPhase: true,
  trendCooldownMin: 0,
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,
  adjustConfidence: (cb) => cb,
  shouldAllowEntry: () => true,
  simulate: simulateOrderAgentIwm,
};
