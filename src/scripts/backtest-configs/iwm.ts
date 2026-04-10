/**
 * IWM backtest configuration — parameters + custom code hooks.
 *
 * Synced with live strategy (strategies/iwm.ts) to ensure backtest
 * reproduces live system entry decisions accurately.
 *
 * IWM-specific filters (mirrors strategies/iwm.ts iwmShouldAllowEntry):
 *   - breakout atrPct < 0.08%
 *   - breakout negative dvel < -0.05
 *   - trend atrPct < 0.125%
 *   - trend high dvel > 0.05 (chasing)
 *   - trend exhausted+choppy (rExh > 7.0 + chop >= 2.0)
 *   - bullish dvel < -0.04 (strong reversion against entry)
 *   - breakout early morning (rExh < 1.0)
 *   - breakout chop+lowDvel, conf < 74%, highExh+highChop, extremeChop, extremeExhaustion
 *   - breakout regime >= 80
 *   - bullish breakout highExh+regime
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentIwm } from '../../lib/order-agent-sim-iwm.js';

/**
 * IWM entry filter — mirrors strategies/iwm.ts iwmShouldAllowEntry exactly.
 */
function iwmShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice, displacementVelocity } = ctx;
  const regime = ctx.regimeScore;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'breakout' && displacementVelocity < -0.05) return `breakout dvel ${displacementVelocity.toFixed(4)} < -0.05`;
  if (signalMode === 'trend' && atrPct < 0.125) return `trend atrPct ${atrPct.toFixed(3)}% < 0.125%`;
  // Block trend entries chasing accelerating displacement — mirrors SPY's proven filter.
  if (signalMode === 'trend' && displacementVelocity > 0.05) return `trend high dvel ${displacementVelocity.toFixed(4)} > 0.05 (chasing)`;
  if (signalMode === 'trend'
      && ctx.rangeExhaustion > 7.0
      && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  // bullish rangeExhaustion >= 6.0 removed: blocked Grade A moves on trending days.
  if (direction === 'bullish' && displacementVelocity < -0.04) return `bullish dvel ${displacementVelocity.toFixed(4)} < -0.04`;
  if (signalMode === 'breakout' && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;
  if (signalMode === 'breakout'
      && ctx.choppiness >= 0.90 && displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${displacementVelocity.toFixed(4)}`;
  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion >= 7.0 && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  if (signalMode === 'breakout'
      && ctx.choppiness >= 2.0) return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;
  if (signalMode === 'breakout' && regime >= 80) return `breakout regime ${regime} >= 80`;
  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion >= 4.5 && regime >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${regime}`;

  return true;
}

/**
 * IWM confidence adjustment — no adjustments needed.
 */
function iwmAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const IWM_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  minAtrPct: 0.08,
  dailyRiskBudgetPct: 0.05,
  breakoutMaxExhaustion: 10.0,
  breakoutMaxChop: 1.15,
  breakoutMinStrength: 35,
  breakoutStrictTrendPhase: true,
  breakoutMinConfidence: 0,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  trendMaxExhaustion: 999,

  // No trend cooldown — matches live decision-orchestrator which has no trend cooldown
  // (only range=20m, breakout=30m, vwap_rev=15m have cooldowns in live)
  trendCooldownMin: 0,

  shouldAllowEntry: iwmShouldAllowEntry,
  adjustConfidence: iwmAdjustConfidence,
  simulate: simulateOrderAgentIwm,
};
