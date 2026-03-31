/**
 * SPY backtest configuration.
 *
 * Structural trigger system — entry decisions use binary conditions per mode.
 * Entry filters reduced to data-quality checks only (ATR sanity).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import { simulateOrderAgentSpy } from '../../lib/order-agent-sim-spy.js';

/**
 * SPY entry filter — data-quality checks only.
 * Structural trigger conditions handle market-condition filtering.
 */
function spyShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, atr, currentPrice } = ctx;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'trend' && atr < 0.70) return `trend atr ${atr.toFixed(3)} < 0.70`;

  return true;
}

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  trendMaxExhaustion: 999,
  maxDailyEntries: 6,

  // Entry window: block first 30 min after open + last 30 min before close
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  // SPY entry filter (data-quality: ATR sanity only)
  shouldAllowEntry: spyShouldAllowEntry,

  // SPY-specific order simulation
  simulate: simulateOrderAgentSpy,
};
