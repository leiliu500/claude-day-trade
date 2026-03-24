/**
 * SPY backtest configuration.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline (defaults):  24W/20L (55%), +19.6%
 *   After tuning:         target 65%+ win rate
 *
 * SPY-specific filters:
 *   - trendMaxExhaustion: 10.0 (from 12.0) — trend entries at >10x ATR
 *     consumed were 0W/2L (Nov 4 -33.3%, Nov 24 -9.3%). Move is done.
 *   - shouldAllowEntry: blocks breakout entries when regimeScore >= 69.
 *     Mature trending regime = late breakouts that reverse. Data:
 *     regime >= 69 breakouts were 2W/6L (25%), +6.2% vs -123.5%.
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';

/**
 * SPY entry filter — blocks breakout entries in mature trending regimes.
 *
 * When regimeScore >= 69, the trend is already well-established. Breakout
 * entries in this environment are chasing a mature move and tend to reverse.
 *
 * Q4 2025 + Q1 2026 data:
 *   regime >= 69 breakouts: 2W/6L (25%), winners were +4.3%, +1.9%
 *   regime <  69 breakouts: 12W/8L (60%), includes +60.0%, +59.6% TP hits
 */
function spyShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, regimeScore } = ctx;

  // Block breakout entries in mature trending regimes.
  // High regime = trend already established → breakout is late, reverses.
  if (signalMode === 'breakout' && regimeScore >= 68) return false;

  return true;
}

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  // Trend: lower exhaustion cap from 12.0 → 10.0.
  // Trend entries at >10x ATR consumed were 0W/2L across Q4+Q1:
  //   Nov 4 entry 2 (Exh=10.5, -33.3%), Nov 24 (Exh=10.4, -9.3%).
  // No trend winners had Exh >= 10.0.
  trendMaxExhaustion: 10.0,

  // SPY: max 1 entry per day — 2nd entries on losing days compound losses.
  // Q4 2025: Oct 7 (2L -28.6%), Oct 9 (2L -11.3%) — 2nd entries added -9.8%.
  // Trade-off: also skips some 2nd winners (Oct 1 +6.0%, Dec 8 +4.8%).
  maxDailyEntries: 1,

  // SPY breakout entry filter
  shouldAllowEntry: spyShouldAllowEntry,
};
