/**
 * Per-symbol trading configuration.
 *
 * Each ticker has its own independent tuning parameters so that adjustments
 * to one symbol never affect another.  To add a new symbol, just add an entry
 * to TICKER_CONFIGS — no other code changes required.
 *
 * The pipeline, agents, and safety gates call `getTickerConfig(ticker)` to
 * resolve the effective config.  Unknown tickers fall back to DEFAULT_TICKER_CONFIG.
 */

import type { TradingProfile } from './types/market.js';
import type { TickerStrategy, PartialTickerStrategy } from './strategies/strategy.js';
import { defaultStrategy } from './strategies/default.js';
import { qqqStrategy } from './strategies/qqq.js';
import { spyStrategy } from './strategies/spy.js';
import { iwmStrategy } from './strategies/iwm.js';
import { nvdaStrategy } from './strategies/nvda.js';
import { aaplStrategy } from './strategies/aapl.js';

export interface TickerConfig {
  /** Ticker symbol (e.g. 'SPY') */
  ticker: string;
  /** Scalp / Medium / Long profile — determines which timeframes are used */
  profile: TradingProfile;
  /** Whether this ticker is actively traded by the scheduler */
  enabled: boolean;

  // ── Confidence & Entry ─────────────────────────────────────────────────────
  /** Minimum confidence to consider entry (0-1) */
  minConfidence: number;
  /** Max entries per day across all modes */
  maxDailyEntries: number;

  // ── Risk / Sizing ──────────────────────────────────────────────────────────
  /** Max fraction of equity risked per trade */
  maxRiskPct: number;
  /** Max option contracts per entry */
  maxContracts: number;
  /** Max option spread to accept (fraction, e.g. 0.02 = 2%) */
  maxSpreadPct: number;
  /** Minimum reward:risk ratio */
  minRRRatio: number;
  /** Halt new entries after this equity loss today (fraction) */
  dailyLossLimitPct: number;
  /** Skip entry if option mid drifted more than this since selection (fraction) */
  maxEntryDriftPct: number;
  /** Skip entry when LTF ATR% exceeds this (volatility spike filter) */
  maxLtfAtrPct: number;

  // ── Entry Window ───────────────────────────────────────────────────────────
  /** Earliest entry in minutes since market open (default 0 = 9:30 AM ET) */
  entryWindowStartMin: number;
  /** Latest entry in minutes since market open (default 390 = 4:00 PM ET) */
  entryWindowEndMin: number;

  // ── Direct Entry Mode ─────────────────────────────────────────────────────
  /** When true, skip all confirmation gates, bypass logic, cooldowns, daily caps,
   *  persistence bonus, and leading signal threshold adjustments in the pipeline.
   *  Confidence is the sole entry criterion — if it meets minConfidence, enter. */
  directEntry: boolean;

  // ── Per-symbol strategy (code-level overrides) ─────────────────────────────
  /** Resolved strategy — merged with defaults at startup. Do not set directly. */
  strategy: TickerStrategy;
}

// ── Default config — used as base for all tickers ────────────────────────────

export const DEFAULT_TICKER_CONFIG: Omit<TickerConfig, 'ticker'> = {
  profile: 'S',
  enabled: true,
  minConfidence: 0.65,
  maxDailyEntries: 4,
  maxRiskPct: 0.005,
  maxContracts: 10,
  maxSpreadPct: 0.02,
  minRRRatio: 0.6,
  dailyLossLimitPct: 0.02,
  maxEntryDriftPct: 0.05,
  maxLtfAtrPct: 0.25,
  entryWindowStartMin: 0,
  entryWindowEndMin: 390,
  directEntry: false,
  strategy: defaultStrategy,
};

// ── Per-ticker overrides ─────────────────────────────────────────────────────
// Only specify fields that differ from DEFAULT_TICKER_CONFIG.

/** Per-ticker overrides. `strategy` accepts a partial — unspecified hooks use defaults. */
const TICKER_OVERRIDES: Record<string, Partial<Omit<TickerConfig, 'ticker' | 'strategy'>> & { strategy?: PartialTickerStrategy }> = {
  SPY: {
    strategy: spyStrategy,
    directEntry: true,
    minConfidence: 0.65,
    entryWindowStartMin: 30,   // block first 30 min after open
    entryWindowEndMin: 360,    // block last 30 min before close
  },
  QQQ: {
    strategy: qqqStrategy,
    directEntry: true,
    maxContracts: 5,
    enabled: true,
    entryWindowStartMin: 30,
    entryWindowEndMin: 360,
  },
  IWM: {
    strategy: iwmStrategy,
    directEntry: true,
    maxContracts: 5,
    enabled: true,
    entryWindowStartMin: 30,
    entryWindowEndMin: 360,
  },
  NVDA: {
    minConfidence: 0.65,
    maxDailyEntries: 1,
    maxContracts: 5,
    enabled: false,
    strategy: nvdaStrategy,
  },
  AAPL: {
    minConfidence: 0.65,
    maxDailyEntries: 4,
    maxContracts: 5,
    enabled: false,
    strategy: aaplStrategy,
  },
};

// ── Resolved configs ─────────────────────────────────────────────────────────

const resolvedConfigs = new Map<string, TickerConfig>();

function resolveConfig(ticker: string): TickerConfig {
  const { strategy: strategyOverrides, ...paramOverrides } = TICKER_OVERRIDES[ticker] ?? {};
  // Merge strategy: partial overrides fill in from defaultStrategy
  const strategy: TickerStrategy = strategyOverrides
    ? { ...defaultStrategy, ...strategyOverrides }
    : defaultStrategy;
  return { ...DEFAULT_TICKER_CONFIG, ...paramOverrides, strategy, ticker };
}

// Pre-resolve all configured tickers
for (const ticker of Object.keys(TICKER_OVERRIDES)) {
  resolvedConfigs.set(ticker, resolveConfig(ticker));
}

/**
 * Get the trading config for a specific ticker.
 * Returns the per-symbol config if defined, otherwise falls back to defaults.
 */
export function getTickerConfig(ticker: string): TickerConfig {
  let cfg = resolvedConfigs.get(ticker);
  if (!cfg) {
    cfg = resolveConfig(ticker);
    resolvedConfigs.set(ticker, cfg);
  }
  return cfg;
}

/**
 * Get all tickers that are enabled for auto-trading.
 * Used by the scheduler and index.ts to determine what to subscribe/trade.
 */
export function getEnabledTickers(): Array<{ ticker: string; profile: TradingProfile }> {
  return Object.keys(TICKER_OVERRIDES)
    .map(ticker => getTickerConfig(ticker))
    .filter(cfg => cfg.enabled)
    .map(cfg => ({ ticker: cfg.ticker, profile: cfg.profile }));
}
