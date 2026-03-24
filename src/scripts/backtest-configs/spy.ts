/**
 * SPY backtest configuration.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Q1 2026 baseline: 8W/3L (73%), +81.9%
 *   Q1 2026 tuned:    7W/2L (78%), +93.9%
 *
 * SPY-specific filters:
 *   - shouldAllowEntry: blocks stale-ATR breakouts, negative-displacement
 *     breakouts, and bullish trend entries at very high regime (>= 80).
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
function spyShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, direction, atr, currentPrice, displacementVelocity } = ctx;
  const regime = ctx.regimeScore;

  // 1. Block stale-data breakouts: ATR% < 0.08 means 5m ATR collapsed during
  //    consolidation but breakout detection still fires. These are unreliable.
  //    Q4+Q1 data: ATR% < 0.08 was 1W/5L (17%).
  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return false;

  // 2. Block breakout entries with negative displacement velocity < -0.05:
  //    price is reverting toward open, momentum is fading.
  //    Q4+Q1 data: dvel < -0.05 was 1W/3L (25%), the 3 losses were EARLY_EXIT.
  if (signalMode === 'breakout' && displacementVelocity < -0.05) return false;

  // 3. Block trend entries in exhausted + choppy conditions.
  //    Exh > 7.0 + Chop >= 0.6: trend move is done, price is oscillating.
  //    Q4+Q1 data: 0W/3L (-9.0%). Sole high-Exh trend winner had Chop=0.25.
  if (signalMode === 'trend'
      && ctx.rangeExhaustion > 7.0
      && ctx.choppiness >= 0.6) return false;

  // 4. Block bullish trend entries at very high regime (>= 80).
  //    SPY bullish momentum at this level = price already ran to the day high,
  //    high probability of stalling or reversing. Bearish high-regime is fine.
  //    Q1 2026: bullish trend at regime >= 80 was 1W/1L, sole win +3.1%.
  if (signalMode === 'trend' && direction === 'bullish' && regime >= 80) return false;

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
  // Trend: lower exhaustion cap from 12.0 → 10.0.
  // Trend entries at >10x ATR consumed were 0W/2L across Q4+Q1:
  //   Nov 4 entry 2 (Exh=10.5, -33.3%), Nov 24 (Exh=10.4, -9.3%).
  trendMaxExhaustion: 10.0,

  // SPY: max 2 entries per day.
  // Q4 2025: 2nd entries on losing days compound losses, but trade-off is
  // acceptable — also captures 2nd winners (Oct 1 +6.0%, Dec 8 +4.8%).
  maxDailyEntries: 2,

  // Strict trend phase for breakouts: require trendPhase >= 0, NO high-conf bypass.
  breakoutStrictTrendPhase: true,

  // SPY-specific confidence adjustment (suppress PA at high bullish regime)
  adjustConfidence: spyAdjustConfidence,

  // SPY entry filter (stale ATR + neg displacement + bullish trend regime)
  shouldAllowEntry: spyShouldAllowEntry,

  // SPY-specific order simulation (higher premium floor, trailing stop floor)
  simulate: simulateOrderAgentSpy,
};
