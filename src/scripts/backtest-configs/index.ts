/**
 * Backtest config loader — resolves per-ticker config by symbol name.
 */

import { DEFAULT_BT_CONFIG, type TickerBacktestConfig } from './types.js';
import { SPY_CONFIG } from './spy.js';
import { QQQ_CONFIG } from './qqq.js';
import { IWM_CONFIG } from './iwm.js';
import { NVDA_CONFIG } from './nvda.js';
import { AAPL_CONFIG } from './aapl.js';

const CONFIGS: Record<string, Partial<TickerBacktestConfig>> = {
  SPY: SPY_CONFIG,
  QQQ: QQQ_CONFIG,
  IWM: IWM_CONFIG,
  NVDA: NVDA_CONFIG,
  AAPL: AAPL_CONFIG,
};

export function loadBacktestConfig(ticker: string): TickerBacktestConfig {
  const overrides = CONFIGS[ticker] ?? {};
  return { ...DEFAULT_BT_CONFIG, ...overrides };
}

export type { TickerBacktestConfig };
