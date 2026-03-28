/**
 * QQQ backtest configuration — parameters + custom code hooks.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Q4 2025 + Q1 2026 signal quality: 4A/2B/3F → tuned to 4A/2B/0F (0% bad)
 *
 * QQQ-specific code hooks:
 *   - shouldAllowEntry: blocks trend entries with negative trendPhase,
 *     near-level penalty, weak DI spread, high choppiness (>= 0.55),
 *     low ATR% (< 0.07 — holiday/thin volume), bearish trend at high
 *     regime + near-zero dvel, and breakout entries missing structure
 *     confirmation, low regime (< 60), or near-zero dvel + high chop.
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
function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.07) return `atrPct ${atrPct.toFixed(3)}% < 0.07%`;
  if (ctx.direction === 'bearish' && ctx.signalMode !== 'breakout' && atrPct < 0.09) return `bearish ${signalMode} atrPct ${atrPct.toFixed(3)}% < 0.09%`;

  if (signalMode === 'trend') {
    if (cb.trendPhaseBonus < 0) return `trend trendPhase ${cb.trendPhaseBonus.toFixed(3)} < 0`;
    if (cb.nearLevelPenalty < -0.05) return `trend nearLevelPenalty ${cb.nearLevelPenalty.toFixed(3)} < -0.05`;
    if (cb.diSpreadBonus < 0.04) return `trend diSpread ${cb.diSpreadBonus.toFixed(3)} < 0.04`;
    if (ctx.choppiness >= 0.55) return `trend choppiness ${ctx.choppiness.toFixed(2)} >= 0.55`;
    if (ctx.direction === 'bearish' && ctx.regimeScore >= 85
        && ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.03) return `bearish trend regime ${ctx.regimeScore} >= 85 + dvel ${ctx.displacementVelocity.toFixed(4)} near zero`;
    if (ctx.rangeExhaustion >= 7.0
        && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.05) return `trend exhausted+lowDvel rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)}`;
  }

  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
    if (ctx.regimeScore < 60) return `breakout regime ${ctx.regimeScore} < 60`;
    if (ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.07
        && ctx.choppiness !== undefined && ctx.choppiness >= 0.55) return `breakout lowDvel+chop dvel=${ctx.displacementVelocity.toFixed(4)} chop=${ctx.choppiness.toFixed(2)}`;
  }

  if (signalMode === 'vwap_reversion') {
    // vwap_reversion choppiness >= 1.5 removed: Q4+Q1 net +2 costly
    if (ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0) return `vwap_reversion dvel ${ctx.displacementVelocity.toFixed(4)} < 0`;
    if (ctx.regimeScore >= 73) return `vwap_reversion regime ${ctx.regimeScore} >= 73`;
    // vwap_reversion rangeExhaustion >= 14 removed: Q4+Q1 net +9 costly
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
  // QQQ: max 2 entries per day
  maxDailyEntries: 2,
  // Tighter breakout exhaustion (7.0 vs SPY 10.0)
  breakoutMaxExhaustion: 7.0,
  // Choppiness filter: Mar 05 chop=1.21, Mar 18 chop=1.01 — both F-grade.
  // Good breakout Feb 18 had chop=0.35. Lower from 1.15 → 0.95.
  breakoutMaxChop: 0.95,
  breakoutMinStrength: 35,
  // No strongSignal bypass — QQQ breakouts with neg trendPhase always fail
  breakoutStrictTrendPhase: true,
  // Higher min conf for breakouts
  breakoutMinConfidence: 0.72,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  // trendMaxExhaustion disabled: Q4+Q1 counterfactual net +3 costly (22 good vs 19 bad)
  trendMaxExhaustion: 999,

  // ── QQQ code hooks ──
  shouldAllowEntry: qqqShouldAllowEntry,
  adjustConfidence: qqqAdjustConfidence,

  // QQQ-specific order simulation (shared defaults for now)
  simulate: simulateOrderAgentQqq,
};
