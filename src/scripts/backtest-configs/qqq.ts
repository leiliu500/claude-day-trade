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
function qqqShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, breakdown: cb } = ctx;

  // QQQ rule: block ALL modes with very low ATR% (holiday/thin volume).
  // Dec 24 F-grade had ATR%=0.059% (holiday session, $0.37 ATR on $623).
  // Dec 31 F-grade had ATR%=0.086% (holiday session, $0.53 ATR on $617).
  // All good QQQ entries had ATR% >= 0.08% (Jan 9) or >= 0.13%.
  // Bearish trend entries need slightly higher ATR floor — thin liquidity
  // means bearish moves stall without follow-through.
  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.07) return false;
  if (ctx.direction === 'bearish' && ctx.signalMode !== 'breakout' && atrPct < 0.09) return false;

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

    // QQQ trend rule 4: block high-chop entries.
    // Jan 13 loss had chop=0.64, all trend winners had chop <= 0.30.
    // High chop = price oscillating, trend signal is unreliable.
    if (ctx.choppiness >= 0.55) return false;

    // QQQ trend rule 5: block bearish trend at high regime + near-zero dvel.
    // Dec 31 F-grade: regime=87, dvel=0.017 — bearish momentum stalling at extremes.
    // Good bearish at high regime: Nov 4 (regime=85, dvel=0.036→B), Feb 12 (regime=89, dvel=0.218→A).
    // Near-zero dvel at high regime = price overextended but no longer accelerating.
    if (ctx.direction === 'bearish' && ctx.regimeScore >= 85
        && ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.03) return false;

    // QQQ trend rule 6: block trend entries with high exhaustion + near-zero dvel.
    // Feb 18#2 F-grade: RangeExh=7.3, DispVel=0.010 — extended move, stalling.
    if (ctx.rangeExhaustion >= 7.0
        && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.05) return false;
  }

  if (signalMode === 'breakout') {
    // QQQ breakout rule 1: require structure confirmation.
    // Jan 30 loss (-35.0%) had structureBonus=0 (no PDH/PDL alignment).
    // Both breakout winners (Feb 18 +71.6%, Mar 18 +7.9%) had structureBonus=+0.060.
    // Structure confirms the breakout has a real level behind it, not just noise.
    if (cb.structureBonus <= 0) return false;

    // QQQ breakout rule 2: require minimum regime (directional conviction).
    // Dec 10 loss (-35.0%) had regime=56 (low conviction, choppy market).
    // All breakout winners had regime >= 67. Below 60 = noise, not a real breakout.
    if (ctx.regimeScore < 60) return false;

    // QQQ breakout rule 3: block breakouts with low dvel + choppiness.
    // Oct 15 F-grade: dvel=-0.001, chop=0.65. Mar 24 F-grade: dvel=0.062, chop=0.67.
    // Good breakout Feb 18: dvel=-0.014, chop=0.35 (clean, low-chop breakout).
    // |dvel| < 0.07 + chop >= 0.55 = low momentum + oscillating price.
    if (ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.07
        && ctx.choppiness !== undefined && ctx.choppiness >= 0.55) return false;
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
  trendMaxExhaustion: 12.0,

  // ── QQQ code hooks ──
  shouldAllowEntry: qqqShouldAllowEntry,
  adjustConfidence: qqqAdjustConfidence,

  // QQQ-specific order simulation (shared defaults for now)
  simulate: simulateOrderAgentQqq,
};
