/**
 * SPY backtest configuration.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline (defaults):  24W/20L (55%), +19.6%
 *   After tuning:         target 65%+ win rate
 *
 * SPY-specific filters:
 *   - trendMaxExhaustion: 10.0 (from 12.0) — trend entries at >10x ATR
 *     consumed were 0W/2L (Nov 4 -33.3%, Nov 24 -9.3%). Move is done.
 *   - shouldAllowEntry: blocks breakout entries when live-style regime >= 68.
 *     Uses the same regime computation as strategies/spy.ts (1m bar candle
 *     direction) instead of the backtest engine's DMI-based regime score.
 *     Mature trending regime = late breakouts that reverse. Data:
 *     regime >= 69 breakouts were 2W/6L (25%), +6.2% vs -123.5%.
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import { simulateOrderAgentSpy } from '../../lib/order-agent-sim-spy.js';

/**
 * Compute regime score from LTF (1m) bars — mirrors strategies/spy.ts exactly.
 * Uses candle direction (close vs open) instead of DMI direction votes.
 */
function computeLiveRegimeScore(
  ltfBars: Array<{ open: number; high: number; low: number; close: number }>,
  ltfVwapPriceVs: number,
): number {
  if (ltfBars.length < 20) return 50;

  // A. Choppiness — direction flips in last 30 bars (candle direction, not DMI)
  const recent30 = ltfBars.slice(-30);
  let flips = 0;
  let prevDir: 'up' | 'down' | null = null;
  for (const bar of recent30) {
    const dir = bar.close >= bar.open ? 'up' : 'down';
    if (prevDir && dir !== prevDir) flips++;
    prevDir = dir;
  }
  const expectedFlips = Math.max(1, recent30.length / 4);
  const choppiness = Math.max(0, Math.min(4, flips / expectedFlips));

  // B. Displacement velocity — recent vs prior displacement from open
  const dayOpen = ltfBars[0]!.open;
  if (dayOpen === 0) return 50;
  const recentBars = ltfBars.slice(-5);
  const priorBars = ltfBars.length >= 10 ? ltfBars.slice(-10, -5) : ltfBars.slice(0, Math.min(5, ltfBars.length));
  const avgRecentDisp = recentBars.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / recentBars.length;
  const avgPriorDisp = priorBars.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / priorBars.length;
  const displacementVelocity = avgRecentDisp - avgPriorDisp;

  // C. VWAP consistency
  const vwapConsistency = Math.min(1, Math.max(0, Math.abs(ltfVwapPriceVs) / 0.30 * 0.5 + 0.5));

  // D. Trend strength — consecutive directional closes (last 10 bars)
  const last10 = ltfBars.slice(-10);
  let consecUp = 0, consecDown = 0, maxConsecUp = 0, maxConsecDown = 0;
  for (let i = 1; i < last10.length; i++) {
    if (last10[i]!.close > last10[i - 1]!.close) {
      consecUp++; consecDown = 0;
      if (consecUp > maxConsecUp) maxConsecUp = consecUp;
    } else {
      consecDown++; consecUp = 0;
      if (consecDown > maxConsecDown) maxConsecDown = consecDown;
    }
  }
  const trendStrength = Math.max(maxConsecUp, maxConsecDown);

  // Composite
  const trendingComponent = (1 - choppiness) * 20;
  const velocityComponent = displacementVelocity * 15;
  const vwapComponent = (vwapConsistency - 0.5) * 20;
  const trendStrComponent = Math.min(10, trendStrength * 2.5);

  return Math.round(Math.max(0, Math.min(100,
    50 + trendingComponent + velocityComponent + vwapComponent + trendStrComponent
  )));
}

/**
 * SPY entry filter — blocks breakout entries in mature trending regimes.
 *
 * Uses the same regime computation as the live SPY strategy (candle direction)
 * to match live behavior. The backtest engine's DMI-based regime score can
 * diverge from live, causing false blocks.
 *
 * Q4 2025 + Q1 2026 data:
 *   regime >= 69 breakouts: 2W/6L (25%), winners were +4.3%, +1.9%
 *   regime <  69 breakouts: 12W/8L (60%), includes +60.0%, +59.6% TP hits
 */
function spyShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, atr, currentPrice, displacementVelocity } = ctx;

  // 1. Block stale-data breakouts: ATR% < 0.08 means 5m ATR collapsed during
  //    consolidation but breakout detection still fires. These are unreliable.
  //    Q4+Q1 data: ATR% < 0.08 was 1W/5L (17%).
  //    Sole winner Oct 06 (+4.3%) had ATR=0.363/$672=0.054%.
  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return false;

  // 2. Block entries with negative displacement velocity < -0.05: price is
  //    reverting toward open, momentum is fading. Entering a breakout while
  //    displacement is declining = chasing a fading move.
  //    Q4+Q1 data: dvel < -0.05 was 1W/3L (25%), the 3 losses were EARLY_EXIT.
  if (signalMode === 'breakout' && displacementVelocity < -0.05) return false;

  // 3. Block breakout entries in mature trending regimes.
  //    Use live-style regime score (candle direction) instead of backtest's DMI-based score.
  if (signalMode === 'breakout' && ctx.ltfBars) {
    const liveRegime = computeLiveRegimeScore(ctx.ltfBars, ctx.ltfVwapPriceVs ?? 0);
    if (liveRegime >= 68) return false;
  }

  return true;
}

export const SPY_CONFIG: Partial<TickerBacktestConfig> = {
  // Trend: lower exhaustion cap from 12.0 → 10.0.
  // Trend entries at >10x ATR consumed were 0W/2L across Q4+Q1:
  //   Nov 4 entry 2 (Exh=10.5, -33.3%), Nov 24 (Exh=10.4, -9.3%).
  // No trend winners had Exh >= 10.0.
  trendMaxExhaustion: 10.0,

  // SPY: max 1 entry per day — 2nd entries on losing days compound losses.
  // Q4 2025: Oct 7 (2L -28.6%), Oct 9 (2L -11.3%) — 2nd entries added -9.8%.
  // Trade-off: also skips some 2nd winners (Oct 1 +6.0%, Dec 8 +4.8%).
  maxDailyEntries: 1,

  // Strict trend phase for breakouts: require trendPhase >= 0, NO high-conf bypass.
  // Mar 23: bullish breakout at day high with trendPhase=-0.040 bypassed via
  // strongSignalBypass (86% + all_aligned) → grade F, MFE=0.00%, MAE=1.28%.
  // Breakout into fading momentum is a reversal trap regardless of confidence.
  breakoutStrictTrendPhase: true,

  // SPY breakout entry filter
  shouldAllowEntry: spyShouldAllowEntry,

  // SPY-specific order simulation (higher premium floor, trailing stop floor)
  simulate: simulateOrderAgentSpy,
};
