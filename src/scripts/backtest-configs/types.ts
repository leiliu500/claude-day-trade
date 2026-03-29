/**
 * Per-ticker backtest configuration.
 *
 * Each ticker has its own file (spy.ts, qqq.ts) that exports a partial config.
 * Includes both numeric parameters AND code hooks (functions) that override
 * core trading logic per-symbol.
 *
 * backtest-day.ts merges it with defaults at runtime.
 */

import type { ConfidenceBreakdown } from '../../types/analysis.js';
import type { SignalDirection, AlignmentType } from '../../types/signal.js';
import { simulateOrderAgent, type OHLCVBar, type SimResult, type SimConfig } from '../../lib/order-agent-sim.js';

// ── Entry context passed to hooks ────────────────────────────────────────────

export interface EntryContext {
  signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none';
  direction: SignalDirection;
  alignment: AlignmentType;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  strengthScore: number;
  currentPrice: number;
  atr: number;
  rangeExhaustion: number;
  displacementVelocity: number;
  choppiness: number;
  intradayTrendStrength: number;
  regimeScore: number;
  dailyEntryCount: number;
  /** Minutes since market open */
  minutesSinceOpen: number;
  /** LTF bars for per-ticker regime computation — matches live strategy access */
  ltfBars?: Array<{ timestamp: string; open: number; high: number; low: number; close: number }>;
  /** LTF VWAP price-vs-VWAP for per-ticker regime computation */
  ltfVwapPriceVs?: number;
}

// ── Config interface ─────────────────────────────────────────────────────────

export interface TickerBacktestConfig {
  // ── Numeric parameters ─────────────────────────────────────────────────────
  minConfidence: number;
  /** Minimum ATR% to accept breakout entry — filters stale/pre-market data */
  minAtrPct: number;
  /** Max entries per day across all modes */
  maxDailyEntries: number;
  /** Breakout: max rangeExhaustion to accept */
  breakoutMaxExhaustion: number;
  /** Breakout: max choppiness to accept */
  breakoutMaxChop: number;
  /** Breakout: min strength score */
  breakoutMinStrength: number;
  /** Breakout: require trendPhase >= 0 always (no strongSignal bypass) */
  breakoutStrictTrendPhase: boolean;
  /** Breakout: minimum confidence (above base threshold) */
  breakoutMinConfidence: number;
  /** Sim: stop multiplier for breakout mode */
  breakoutStopMult: number;
  /** Sim: TP multiplier for breakout mode */
  breakoutTpMult: number;
  /** Trend: max rangeExhaustion for confirmation gate entries */
  trendMaxExhaustion: number;
  /** Trend: min rangeExhaustion to trigger exhausted+reverting block (rExh > N && dvel < 0). Default 7.0. */
  trendExhaustedRevertMinExh: number;
  /** Trend: min confidence for strong-signal bypass (skips 2-stage gate when all_aligned). Default 0.75. */
  trendStrongSignalMinConf: number;
  /** Entry window: earliest entry in minutes since market open (default 0 = open) */
  entryWindowStartMin: number;
  /** Entry window: latest entry in minutes since market open (default 390 = close) */
  entryWindowEndMin: number;

  // ── Code hooks — override with custom per-ticker logic ─────────────────────

  /**
   * Custom entry filter — called after all standard filters pass.
   * Return `true` to allow entry, or a string describing the block reason.
   * Use this for ticker-specific logic that doesn't fit into parameters.
   *
   * Default: always returns true (no additional filtering).
   */
  shouldAllowEntry: (ctx: EntryContext) => true | string;

  /**
   * Custom confidence adjustment — called after the shared confidence model.
   * Receives the computed breakdown, returns a modified one.
   * Use this for ticker-specific confidence caps, bonuses, or penalties.
   *
   * Default: returns the breakdown unchanged.
   */
  adjustConfidence: (breakdown: ConfidenceBreakdown, ctx: EntryContext) => ConfidenceBreakdown;

  /**
   * Per-ticker order simulation function.
   * Each ticker can override with its own exit rules, premium estimation, etc.
   *
   * Default: shared simulateOrderAgent from order-agent-sim.ts.
   */
  simulate: (
    entryPrice: number,
    direction: SignalDirection,
    atr: number,
    futureBars: OHLCVBar[],
    cfg?: SimConfig,
  ) => SimResult;
}

export const DEFAULT_BT_CONFIG: TickerBacktestConfig = {
  minConfidence: 0.65,
  minAtrPct: 0,
  maxDailyEntries: 2,
  breakoutMaxExhaustion: 10.0,
  breakoutMaxChop: 999,
  breakoutMinStrength: 35,
  breakoutStrictTrendPhase: false,
  breakoutMinConfidence: 0,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  trendMaxExhaustion: 12.0,
  trendExhaustedRevertMinExh: 7.0,
  trendStrongSignalMinConf: 0.75,
  entryWindowStartMin: 0,
  entryWindowEndMin: 390,
  shouldAllowEntry: () => true,
  adjustConfidence: (cb) => cb,
  simulate: simulateOrderAgent,
};
