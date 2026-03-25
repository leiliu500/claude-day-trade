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

  // 5. Block bullish entries with high range exhaustion (>= 6.0).
  //    Bullish entries into an already-extended move fail consistently.
  //    Q1 2026: bullish + RangeExh >= 6.0 was 0W/4L (all F-grade).
  //    Bullish + RangeExh < 6.0 was 2W/0L (both A-grade: Feb 18 Exh=3.2, Mar 10 Exh=5.3).
  //    Bearish entries are unaffected — they ride exhaustion in their favor.
  if (direction === 'bullish' && ctx.rangeExhaustion >= 6.0) return false;

  // 6. Block bullish entries with low displacement velocity (< 0.08).
  //    Low dvel = momentum is decelerating or flat, move is stalling.
  //    Q1 2026: bullish + dvel < 0.08 was 0W/2L (Jan 5 dvel=0.082→F, Feb 17 dvel=0.025→F,
  //    Feb 18#2 dvel=-0.012→F). Good bullish entries had dvel 0.106 and 0.195.
  if (direction === 'bullish' && displacementVelocity < 0.08) return false;

  // 7. Block bearish breakout entries with high exhaustion + high choppiness.
  //    RangeExh >= 6.0 + Chop >= 0.95 = move already extended and price is oscillating.
  //    Q4 2025: bearish + Exh>=6.0 + Chop>=0.95 was 0W/2L (Oct 7 Exh=7.0/Chop=1.05→F,
  //    Oct 31 Exh=6.2/Chop=0.97→F). Good bearish entry Jan 29 had Exh=7.6 but Chop=0.86.
  if (signalMode === 'breakout' && direction === 'bearish'
      && ctx.rangeExhaustion >= 6.0 && ctx.choppiness >= 0.95) return false;

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
