/**
 * QQQ backtest configuration.
 *
 * Clean baseline: same 2-layer multiplicative confidence model as SPY.
 * No static filters or confidence adjustments.
 */

import type { TickerBacktestConfig } from './types.js';
import { simulateOrderAgentQqq } from '../../lib/order-agent-sim-qqq.js';

export const QQQ_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  trendMaxExhaustion: 999,
  maxDailyEntries: 6,
  breakoutStrictTrendPhase: true,
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,
  adjustConfidence: (cb) => cb,
  shouldAllowEntry: () => true,
  simulate: simulateOrderAgentQqq,
};
