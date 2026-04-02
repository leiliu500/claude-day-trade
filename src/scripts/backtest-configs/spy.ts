/**
 * SPY backtest configuration.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Q4 2025 + Q1 2026 signal quality: 4A/2B/2C/1D/6F → tuned to 4A/2B/2C/1D/0F (100% F removal)
 *
 * SPY-specific filters:
 *   - shouldAllowEntry: blocks stale-ATR breakouts, negative-displacement
 *     breakouts, bullish trend entries at very high regime (>= 80),
 *     bullish entries with high exhaustion (>= 6.0), and bullish entries
 *     with low displacement velocity (< 0.08).
 *   - adjustConfidence: suppresses PA bonus for bullish trend at regime >= 75.
 *
 * Regime scoring:
 *   Production (strategies/spy.ts): hybrid candle-based (real-time choppiness,
 *   displacement velocity, trend strength) + ADX anchor, computed from LTF bars.
 *   Backtest: ctx.regimeScore — tick-by-tick DMI-based composite (choppiness,
 *   displacement, VWAP consistency, trend strength).
 *   Both are DMI/price-derived and produce comparable 50-100 ranges.
 *   Same thresholds (75, 80) apply to both.
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentSpy } from '../../lib/order-agent-sim-spy.js';

/**
 * SPY entry filter — mirrors strategies/spy.ts spyShouldAllowEntry.
 */
function spyShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice, displacementVelocity } = ctx;
  const regime = ctx.regimeScore;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'breakout' && displacementVelocity < -0.05) return `breakout dvel ${displacementVelocity.toFixed(4)} < -0.05`;
  if (signalMode === 'trend' && atr < 0.65) return `trend atr ${atr.toFixed(3)} < 0.65`;
  // trend_regime >= 80 removed: Q4+Q1 counterfactual net +12 costly
  if (signalMode === 'trend'
      && ctx.rangeExhaustion > 7.0
      && ctx.choppiness >= 0.55) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  if (direction === 'bullish' && ctx.rangeExhaustion >= 6.0) return `bullish rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 6.0`;
  if (direction === 'bullish' && displacementVelocity < -0.04) return `bullish dvel ${displacementVelocity.toFixed(4)} < -0.04`;
  if (signalMode === 'breakout' && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;
  if (signalMode === 'breakout'
      && ctx.choppiness >= 0.90 && ctx.displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)}`;
  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion >= 7.0 && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  if (signalMode === 'breakout' && ctx.choppiness >= 2.0) return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;
  if (signalMode === 'breakout' && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;
  if (signalMode === 'breakout' && regime >= 80) return `breakout regime ${regime} >= 80`;
  // breakout_atr < 0.80 removed: Q4+Q1 counterfactual net +9 costly
  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion >= 4.5 && regime >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${regime}`;

  return true;
}

/**
 * SPY confidence adjustment — mirrors strategies/spy.ts spyAdjustConfidence.
 * Suppress PA bonus for bullish trend entries at high regime (>= 75).
 */
function spyAdjustConfidence(breakdown: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  const regime = ctx.regimeScore;
  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && regime >= 75 && breakdown.recentPriceActionBonus > 0) {
    const adjusted = { ...breakdown };
    adjusted.total -= adjusted.recentPriceActionBonus;
    adjusted.recentPriceActionBonus = 0;
    adjusted.total = Math.max(0, Math.min(1, adjusted.total));
    return adjusted;
  }
  return breakdown;
}

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  // trendMaxExhaustion effectively disabled: Q4+Q1 counterfactual net +9 costly (14 good vs 5 bad).
  // Entries at rExh 20-30 were 10 good, 0 bad. trend_exhausted_reverting (dvel<0) catches actual reversals.
  trendMaxExhaustion: 999,

  maxDailyEntries: 6,

  // Strict trend phase for breakouts: require trendPhase >= 0, NO high-conf bypass.
  breakoutStrictTrendPhase: true,

  // Entry window: block first 30 min after open + last 30 min before close
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  // SPY-specific confidence adjustment (suppress PA at high bullish regime)
  adjustConfidence: spyAdjustConfidence,

  // SPY entry filter (stale ATR + neg displacement + bullish trend regime)
  shouldAllowEntry: spyShouldAllowEntry,

  // SPY-specific order simulation (higher premium floor, trailing stop floor)
  simulate: simulateOrderAgentSpy,
};
