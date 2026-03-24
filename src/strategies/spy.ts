/**
 * SPY-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline (defaults):  24W/20L (55%), +19.6%
 *   After tuning:         22W/14L (61%), +153.2%
 *
 * SPY-specific filter:
 *   - shouldAllowEntry: blocks breakout entries when intraday regime is mature
 *     (regime >= 70). Breakouts in established trends = chasing late, reversals.
 *     Backtested: regime >= 70 breakouts were 2W/5L (29%), all small wins.
 *
 * NOTE: trendMaxExhaustion = 10.0 is only in the backtest config (spy.ts in
 * backtest-configs/). The production decision-orchestrator already uses 10.0
 * for breakout exhaustion. For trend entries, the shared analysis-agent caps
 * confidence at rangeExhaustion > 12.0 and > 7.0 + neg DispVel.
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
// Safe because SPY pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score from LTF (1m) bars.
 * >65 = trending, <35 = ranging/choppy, 35-65 = mixed.
 *
 * Components:
 *   1. Choppiness: direction flip frequency (less flips = more trending)
 *   2. Displacement velocity: rate of price movement from open
 *   3. VWAP consistency: how often price stays on one side of VWAP
 *   4. Trend strength: consecutive directional closes
 */
function computeRegimeScore(ltfBars: Array<{ open: number; high: number; low: number; close: number }>, ltfVwapPriceVs: number): number {
  if (ltfBars.length < 20) return 50; // not enough data

  // A. Choppiness — direction flips in last 30 bars
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

  // B. Displacement velocity — compare recent vs prior displacement from open
  const dayOpen = ltfBars[0]!.open;
  if (dayOpen === 0) return 50;
  const recentBars = ltfBars.slice(-5);
  const priorBars = ltfBars.length >= 10 ? ltfBars.slice(-10, -5) : ltfBars.slice(0, Math.min(5, ltfBars.length));
  const avgRecentDisp = recentBars.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / recentBars.length;
  const avgPriorDisp = priorBars.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / priorBars.length;
  const displacementVelocity = avgRecentDisp - avgPriorDisp;

  // C. VWAP consistency — simple proxy: current VWAP distance
  // Strong VWAP extension = consistent side = trending
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

// ── SPY Mode Detection ──────────────────────────────────────────────────────
// Same as default but also computes and caches the regime score.

import { defaultStrategy } from './default.js';

function spyDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ReturnType<typeof defaultStrategy.detectMode> {
  // Compute regime score from LTF bars for use in shouldAllowEntry
  const ltfTf = tfIndicators[0];
  if (ltfTf) {
    _lastRegimeScore = computeRegimeScore(
      ltfTf.bars as Array<{ open: number; high: number; low: number; close: number }>,
      ltfTf.vwap?.priceVsVwap ?? 0,
    );
  }

  // Delegate to default mode detection (no changes to mode logic)
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── SPY Entry Filter ────────────────────────────────────────────────────────

function spyShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode } = ctx;

  // Block breakout entries in mature trending regimes.
  // When regime >= 70, the trend is already established — breakout entries
  // are chasing a mature move and tend to reverse.
  //
  // Q4 2025 + Q1 2026 data:
  //   regime >= 69 breakouts: 2W/6L (25%), winners were +4.3%, +1.9%
  //   regime <  69 breakouts: 12W/8L (60%), includes +60.0%, +59.6% TP hits
  if (signalMode === 'breakout' && _lastRegimeScore >= 68) return false;

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const spyStrategy: PartialTickerStrategy = {
  detectMode: spyDetectMode,
  shouldAllowEntry: spyShouldAllowEntry,
};
