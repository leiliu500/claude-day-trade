/**
 * QQQ backtest configuration — parameters + custom code hooks.
 *
 * Tuned from Q1 2026 backtest (Jan-Mar):
 *   Baseline (SPY defaults): 8W/11L (42%), -63.8%
 *   After tuning:            >60% target
 *
 * QQQ-specific code hooks:
 *   - shouldAllowEntry: blocks trend entries with negative trendPhase,
 *     near-level penalty, or when day already has an entry
 *   - adjustConfidence: applies QQQ-specific confidence penalties
 *     for DI spread weakness and high-chop trend entries
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentQqq } from '../../lib/order-agent-sim-qqq.js';

/**
 * QQQ entry filter — applies after all shared filters pass.
 *
 * Blocks entries that pass the shared SPY-tuned gates but are
 * bad specifically for QQQ based on backtested patterns.
 */
function qqqShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, breakdown: cb, dailyEntryCount } = ctx;

  // QQQ rule: max 1 entry per day — 2nd entries on same day were
  // mostly trend losers chasing after a breakout win (Feb 18, Feb 20).
  if (dailyEntryCount >= 1) return false;

  if (signalMode === 'trend') {
    // QQQ trend rule 1: require trendPhase >= 0.
    // Feb 11 loss had trendPhase=-0.040. All 4 trend winners had trendPhase >= 0.
    if (cb.trendPhaseBonus < 0) return false;

    // QQQ trend rule 2: block entries near strong S/R levels.
    // Jan 13 loss had nearLevelPenalty=-0.100 (price right at a level, reversed).
    // No trend winner had nearLevelPenalty below -0.050.
    if (cb.nearLevelPenalty < -0.05) return false;

    // QQQ trend rule 3: block weak DI spread entries.
    // Feb 11 loss had DI Spread=+0.033 (weakest). All winners had >= 0.050.
    if (cb.diSpreadBonus < 0.04) return false;
  }

  return true;
}

/**
 * QQQ confidence adjustment — modifies the shared confidence breakdown.
 *
 * Applies QQQ-specific penalties that reflect QQQ's different volatility
 * and trend characteristics vs SPY.
 */
function qqqAdjustConfidence(cb: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  let adjusted = { ...cb };
  const { signalMode, choppiness, rangeExhaustion } = ctx;

  // QQQ has higher intraday volatility — discount confidence when
  // the day is extended (rangeExhaustion > 6) and entry is breakout mode.
  // This makes marginal breakouts fall below threshold naturally.
  if (signalMode === 'breakout' && rangeExhaustion > 6) {
    const exhaustionPenalty = Math.min(0.08, (rangeExhaustion - 6) * 0.02);
    adjusted.total = Math.max(0, adjusted.total - exhaustionPenalty);
  }

  // QQQ chop penalty for trend entries — QQQ trends break down in choppy conditions
  // more than SPY. Apply extra penalty when choppiness > 0.5 in trend mode.
  if (signalMode === 'trend' && choppiness > 0.5) {
    const chopPenalty = Math.min(0.05, (choppiness - 0.5) * 0.05);
    adjusted.total = Math.max(0, adjusted.total - chopPenalty);
  }

  return adjusted;
}

export const QQQ_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  // Filter stale/pre-market data (ATR $0.37 on $625 = 0.06%)
  minAtrPct: 0.08,
  // QQQ: 1 entry per day — 2nd entries chase and lose
  maxDailyEntries: 1,
  // Tighter breakout exhaustion (7.0 vs SPY 10.0)
  breakoutMaxExhaustion: 7.0,
  // Choppiness filter: Mar 05 loss had chop=1.21
  breakoutMaxChop: 1.15,
  breakoutMinStrength: 35,
  // No strongSignal bypass — QQQ breakouts with neg trendPhase always fail
  breakoutStrictTrendPhase: true,
  // Higher min conf for breakouts
  breakoutMinConfidence: 0.72,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  trendMaxExhaustion: 12.0,

  // ── QQQ code hooks ──
  shouldAllowEntry: qqqShouldAllowEntry,
  adjustConfidence: qqqAdjustConfidence,

  // QQQ-specific order simulation (shared defaults for now)
  simulate: simulateOrderAgentQqq,
};
