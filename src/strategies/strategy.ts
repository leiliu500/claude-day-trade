/**
 * TickerStrategy — per-symbol overridable trading logic.
 *
 * Each stock symbol can provide its own implementation of any of these hooks.
 * Hooks that are not overridden use the default SPY-tuned logic.
 *
 * To create a strategy for a new symbol:
 *   1. Create src/strategies/<symbol>.ts
 *   2. Export a partial TickerStrategy with only the hooks you want to override
 *   3. Register it in src/ticker-configs.ts TICKER_OVERRIDES
 *
 * The system merges your overrides with the default strategy at startup.
 */

import type { SignalPayload, AlignmentType } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

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
  /** Rate of change in price displacement from day open.
   *  Positive = accelerating away from open (trending), negative = reverting.
   *  Computed from LTF bars: avg displacement of last 5 bars minus prior 5 bars. */
  displacementVelocity?: number;
  /** Intraday range exhaustion: (dayHigh - dayLow) / HTF ATR.
   *  Higher = more of the daily range consumed, less room for follow-through. */
  rangeExhaustion?: number;
  /** Direction flip frequency in recent LTF bars (0 = perfectly smooth, >1 = choppy).
   *  Computed as (actual flips) / (expected flips at random = barCount / 4). */
  choppiness?: number;
  /** True when recent LTF bars form a tight consolidation (range < 0.4% of price
   *  over 10+ bars) that price is now breaking out of in the signal direction.
   *  Detects "bull flag" / "bear flag" continuation patterns within established trends. */
  trendConsolidationBreakout?: boolean;
  /** Minutes elapsed since regular-session open (9:30 AM ET = 0).
   *  Negative before open. Derived from the latest LTF bar's timestamp so it
   *  works identically in live mode (last bar = wall-clock now) and backtest
   *  mode (last bar = simulated time). Use for time-of-day-based filters. */
  minutesSinceOpen?: number;
}

// ── Mode detection result ────────────────────────────────────────────────────

export interface ModeDetectionResult {
  signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none';
  /** Overridden direction (e.g. range mode flips direction based on range position) */
  direction?: SignalDirection;
  /** Range mode: support/resistance levels */
  rangeSupport?: number;
  rangeResistance?: number;
  /** Breakout mode: level broken and how far beyond */
  breakoutLevel?: number;
  breakoutBeyond?: number;
  /** VWAP reversion mode: VWAP target and distance */
  vwapReversionTarget?: number;
  vwapDistance?: number;
}

// ── Strategy interface ───────────────────────────────────────────────────────

export interface TickerStrategy {
  /**
   * Compute confidence score for trend mode entries.
   * Receives the full signal payload and option evaluation.
   * Returns a ConfidenceBreakdown with individual factor scores and total.
   */
  computeTrendConfidence: (signal: SignalPayload, option: OptionEvaluation) => ConfidenceBreakdown;

  /**
   * Compute confidence score for range (mean-reversion) mode entries.
   */
  computeRangeConfidence: (signal: SignalPayload) => ConfidenceBreakdown;

  /**
   * Compute confidence score for breakout entries.
   */
  computeBreakoutConfidence: (signal: SignalPayload) => ConfidenceBreakdown;

  /**
   * Detect whether the current market state is trend, range, or breakout.
   * Called after indicators are computed, before confidence scoring.
   *
   * @param tfIndicators — [LTF, MTF, HTF] timeframe indicators
   * @param direction — current signal direction from DMI voting
   * @param currentPrice — latest price
   */
  detectMode: (
    tfIndicators: TimeframeIndicators[],
    direction: SignalDirection,
    currentPrice: number,
  ) => ModeDetectionResult;

  /**
   * Compute numeric strength score (0-100) from indicators.
   * Default: HTF ADX * 2, capped at 100.
   */
  computeStrength: (tfIndicators: TimeframeIndicators[]) => number;

  /**
   * Custom confidence adjustment — called after the shared confidence model.
   * Returns a modified breakdown. Use for ticker-specific caps/penalties.
   * Default: returns the breakdown unchanged.
   */
  adjustConfidence: (breakdown: ConfidenceBreakdown, ctx: EntryContext) => ConfidenceBreakdown;

  /**
   * Custom entry filter — called before the orchestrator decides on an entry.
   * Return `true` to allow, or a string describing the block reason.
   * Use for ticker-specific rules that don't fit into parameters.
   * Default: always returns true.
   */
  shouldAllowEntry: (ctx: EntryContext) => true | string;
}

/**
 * Partial strategy — only override what you need.
 * All other hooks fall back to the default (SPY-tuned) implementation.
 */
export type PartialTickerStrategy = Partial<TickerStrategy>;
