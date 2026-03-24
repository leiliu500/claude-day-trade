/**
 * SPY backtest configuration.
 *
 * SPY is the reference symbol — uses all defaults.
 * No custom code hooks needed — the shared confidence models and
 * entry filters were tuned on SPY.
 *
 * Battle-tested Q1 2026: 13W/6L (68%), +159.8%
 */

import type { TickerBacktestConfig } from './types.js';

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  // SPY uses all defaults — the shared code IS SPY-tuned code.
  // No shouldAllowEntry or adjustConfidence overrides needed.
};
