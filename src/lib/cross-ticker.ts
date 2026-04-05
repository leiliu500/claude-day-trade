/**
 * cross-ticker.ts — Shared signal bus for cross-ticker directional confirmation.
 *
 * Universal pattern: when SPY, QQQ, and IWM all signal bullish simultaneously,
 * that's a macro regime signal no single-ticker model can capture.
 *
 * Each pipeline tick publishes its signal (direction, confidence, mode).
 * Before entry, the analysis agent checks how many other tickers agree.
 * Strong macro agreement → confidence boost.
 * Divergence (tickers disagree) → confidence penalty.
 *
 * Design:
 *   - Singleton signal bus stores the latest signal per ticker
 *   - Signals expire after 5 minutes (stale data protection)
 *   - Only index tickers (SPY, QQQ, IWM) count for macro consensus
 *     (NVDA/AAPL are single stocks, not macro indicators)
 *   - Backtest mode: signals injected directly (no real-time bus)
 */

import type { SignalDirection } from '../types/signal.js';

export interface TickerSignal {
  ticker: string;
  direction: SignalDirection;
  confidence: number;
  alignment: string;
  signalMode: string;
  timestamp: number; // Date.now() when published
}

/** How long a signal stays valid (5 minutes) */
const SIGNAL_TTL_MS = 5 * 60_000;

/** Index tickers that form the macro consensus group */
const INDEX_TICKERS = new Set(['SPY', 'QQQ', 'IWM']);

class CrossTickerBus {
  private signals = new Map<string, TickerSignal>();

  /**
   * Publish a signal from a pipeline tick.
   * Called at the end of each pipeline run (after signal generation, before analysis).
   */
  publish(signal: TickerSignal): void {
    this.signals.set(signal.ticker, signal);
  }

  /**
   * Get the latest signal for a ticker (null if expired or absent).
   */
  get(ticker: string, nowTs = Date.now()): TickerSignal | null {
    const sig = this.signals.get(ticker);
    if (!sig) return null;
    if (nowTs - sig.timestamp > SIGNAL_TTL_MS) return null;
    return sig;
  }

  /**
   * Compute macro consensus for a given ticker and direction.
   *
   * @param forTicker - The ticker we're evaluating (excluded from consensus)
   * @param direction - The direction we're evaluating
   * @param nowTs - Current timestamp (for TTL checks)
   * @returns CrossTickerResult with consensus details
   */
  computeConsensus(
    forTicker: string,
    direction: SignalDirection,
    nowTs = Date.now(),
  ): CrossTickerResult {
    if (direction === 'neutral') {
      return { agreeing: 0, disagreeing: 0, total: 0, consensusScore: 0, adjustment: 0, details: [] };
    }

    const details: { ticker: string; direction: SignalDirection; confidence: number; agrees: boolean }[] = [];
    let agreeing = 0;
    let disagreeing = 0;
    let total = 0;

    for (const indexTicker of INDEX_TICKERS) {
      if (indexTicker === forTicker) continue; // exclude self
      const sig = this.get(indexTicker, nowTs);
      if (!sig || sig.direction === 'neutral') continue;

      total++;
      const agrees = sig.direction === direction;
      if (agrees) agreeing++;
      else disagreeing++;

      details.push({
        ticker: indexTicker,
        direction: sig.direction,
        confidence: sig.confidence,
        agrees,
      });
    }

    // Consensus score: -1.0 (all disagree) to +1.0 (all agree)
    const consensusScore = total > 0 ? (agreeing - disagreeing) / total : 0;

    // Confidence adjustment based on consensus
    const adjustment = computeConsensusAdjustment(agreeing, disagreeing, total);

    return { agreeing, disagreeing, total, consensusScore, adjustment, details };
  }

  /** Clear all signals (for testing / session reset) */
  clear(): void {
    this.signals.clear();
  }
}

export interface CrossTickerResult {
  /** Number of index tickers agreeing on direction */
  agreeing: number;
  /** Number of index tickers disagreeing */
  disagreeing: number;
  /** Total index tickers with valid signals (excluding self) */
  total: number;
  /** Consensus score: -1.0 to +1.0 */
  consensusScore: number;
  /** Confidence adjustment to apply */
  adjustment: number;
  /** Per-ticker detail */
  details: { ticker: string; direction: SignalDirection; confidence: number; agrees: boolean }[];
}

/**
 * Compute confidence adjustment from cross-ticker consensus.
 *
 * Divergence-only mode: positive boost removed because it inflated stale/late
 * entries and dropped direction accuracy from 72% → 68%. Cross-ticker value
 * is in detecting when OTHER indices disagree — that's a genuine warning signal.
 *
 * All agree → 0 (no boost — single-ticker model is sufficient)
 * Mixed → 0
 * Majority disagree → -0.02 (divergence warning)
 * All disagree → -0.04 (strong divergence, caution)
 */
function computeConsensusAdjustment(_agreeing: number, disagreeing: number, total: number): number {
  if (total === 0) return 0;
  if (disagreeing === 0) return 0;         // all agree or mixed — no adjustment
  return disagreeing >= 2 ? -0.04 : -0.02; // divergence penalty only
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let _instance: CrossTickerBus | null = null;

export function getCrossTickerBus(): CrossTickerBus {
  if (!_instance) _instance = new CrossTickerBus();
  return _instance;
}

// ── Backtest support ───────────────────────────────────────────────────────────
// In backtest mode, we run one ticker at a time so the bus is empty.
// The backtest script can inject signals from other tickers manually.

/**
 * Create a standalone bus for backtest use (not the singleton).
 * Allows injecting signals from multiple tickers in a controlled way.
 */
export function createBacktestBus(): CrossTickerBus {
  return new CrossTickerBus();
}
