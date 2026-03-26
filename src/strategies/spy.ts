/**
 * SPY-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Q4 2025 + Q1 2026 signal quality: 4A/2B/2C/1D/6F → tuned to 4A/1B/2C/1D/0F (0% bad)
 *
 * SPY-specific filters:
 *   - shouldAllowEntry: blocks bullish trend entries at very high regime (>= 80),
 *     bullish entries with high exhaustion (>= 6.0), bullish entries with low
 *     displacement velocity (< 0.08), and bearish breakouts with high exhaustion
 *     + high choppiness.
 *   - adjustConfidence: suppresses PA bonus for bullish trend entries at
 *     regime >= 75 (confirming bars at high regime = last push, not momentum).
 *
 * NOTE: trendMaxExhaustion = 10.0 is only in the backtest config (spy.ts in
 * backtest-configs/). The production decision-orchestrator already uses 10.0
 * for breakout exhaustion. For trend entries, the shared analysis-agent caps
 * confidence at rangeExhaustion > 12.0 and > 7.0 + neg DispVel.
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
// Safe because SPY pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

// ── SPY Mode Detection ──────────────────────────────────────────────────────
// Same as default but also computes and caches the regime score.

import { defaultStrategy } from './default.js';

/**
 * Compute intraday regime score — hybrid of real-time candle data + DMI anchor.
 *
 * Candle-based components (real-time, no lag):
 *   A. Choppiness — direction flip frequency in recent bars
 *   B. Displacement velocity — rate of price movement from day open
 *   C. Trend strength — consecutive directional closes
 *
 * DMI-anchored component (smoothed, confirms trend is established):
 *   D. ADX level — only contributes when ADX >= 20 (confirmed trend)
 *
 * VWAP component (minimal lag — recalculated every bar):
 *   E. VWAP distance — how far price is from session VWAP
 *
 * Bars are filtered to today's regular session to avoid warmup-data corruption.
 */
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
  // Filter to today's regular-session bars (13:30–20:00 UTC).
  // Stream cache / REST bars can span 2+ days; prior-day bars corrupt dayOpen.
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayBars = bars.filter(b => {
    if (!b.timestamp.startsWith(todayStr)) return false;
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const mins = h * 60 + m;
    return mins >= 810 && mins < 1200; // 13:30–20:00 UTC
  });
  if (todayBars.length < 20) return 50;

  // A. Choppiness — direction flips in last 30 bars (real-time)
  const recent30 = todayBars.slice(-30);
  let flips = 0;
  let prevDir: 'up' | 'down' | null = null;
  for (const bar of recent30) {
    const dir = bar.close >= bar.open ? 'up' : 'down';
    if (prevDir && dir !== prevDir) flips++;
    prevDir = dir;
  }
  const expectedFlips = Math.max(1, recent30.length / 4);
  const choppiness = Math.max(0, Math.min(4, flips / expectedFlips));
  const choppinessComponent = (1 - choppiness) * 15; // -45..+15

  // B. Displacement velocity — recent 5 bars vs prior 5 bars (real-time)
  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

  // C. Trend strength — consecutive directional closes (real-time)
  const last10 = todayBars.slice(-10);
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
  const trendStrComponent = Math.min(10, Math.max(maxConsecUp, maxConsecDown) * 2.5);

  // D. ADX anchor — confirms trend is established (lagged but stabilizing)
  //    Only adds score when ADX >= 20 (genuine trend, not noise).
  //    ADX 20→0, ADX 25→+5, ADX 30→+10, ADX 35→+15 (capped)
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;

  // E. VWAP distance — how extended from mean (minimal lag)
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

function spyDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ReturnType<typeof defaultStrategy.detectMode> {
  const ltf = tfIndicators[0];
  if (ltf) {
    _lastRegimeScore = computeRegimeScore(
      ltf.bars,
      ltf.vwap?.priceVsVwap ?? 0,
      ltf.dmi.adx,
    );
  }

  // Delegate to default mode detection (no changes to mode logic)
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── SPY Confidence Adjustment ────────────────────────────────────────────────

function spyAdjustConfidence(breakdown: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  // Suppress positive PA bonus for bullish trend entries at high regime.
  // At high regime (>= 75), consecutive confirming bars on the bullish side
  // are the final push into a day-high stall, not fresh momentum.
  //
  // Q1 2026 SPY data — bullish trend entries at regime >= 75:
  //   Jan 5:  regime 80, PA=+0.080, conf=83% → +3.1%  (small win)
  //   Jan 26: regime 76, PA=+0.080, conf=82% → -14.9% (big loss)
  //   Feb 20: regime 82, PA=+0.080, conf=77% → -5.8%  (loss)
  //   1W/2L, net -17.6%, sole winner only +3.1%
  //
  // Removing PA at regime >= 75 drops Jan 26 from 82% → 73% (below 75%
  // strong-signal bypass), preventing the fast-track entry.
  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && _lastRegimeScore >= 75 && breakdown.recentPriceActionBonus > 0) {
    const adjusted = { ...breakdown };
    adjusted.total -= adjusted.recentPriceActionBonus;
    adjusted.recentPriceActionBonus = 0;
    adjusted.total = Math.max(0, Math.min(1, adjusted.total));
    return adjusted;
  }
  return breakdown;
}

// ── SPY Entry Filter ────────────────────────────────────────────────────────

function spyShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, direction, atr, currentPrice } = ctx;

  // Block stale-data breakouts: ATR% < 0.08 means 5m ATR collapsed during
  // consolidation but breakout detection still fires. These are unreliable.
  // Q4+Q1 data: ATR% < 0.08 breakouts were 1W/5L (17%).
  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return false;

  // Block breakout entries with negative displacement velocity: price is
  // reverting toward open, momentum is fading. Entering a breakout while
  // displacement is declining = chasing a fading move.
  // Q4+Q1 data: dvel < -0.05 was 1W/3L (25%), the 3 losses were EARLY_EXIT.
  if (signalMode === 'breakout' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.05) return false;

  // Block trend entries in exhausted + choppy conditions.
  // When intraday range > 7x ATR AND price action is choppy (flips >= 0.55),
  // the trend move is done and price is oscillating — entries reverse.
  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion > 7.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 0.55) return false;

  // Block bullish trend entries at very high regime (>= 80).
  // SPY bullish momentum at this level = price already ran to the day high,
  // high probability of stalling or reversing. Bearish entries at high regime
  // are fine — panic selling accelerates, doesn't stall.
  //
  // Q1 2026 data — bullish trend entries at regime >= 80:
  //   Jan 5:  regime 80 → +3.1%  (small win, only $0.37 MFE)
  //   Feb 20: regime 82 → -5.8%  (loss, price reversed immediately)
  //   1W/1L, net -2.7%, not worth the risk
  if (signalMode === 'trend' && direction === 'bullish' && _lastRegimeScore >= 80) return false;

  // Block bullish entries with high range exhaustion (>= 6.0).
  // Bullish entries into an already-extended intraday move fail consistently.
  // Q1 2026: bullish + RangeExh >= 6.0 was 0W/4L (all F-grade).
  // Bullish + RangeExh < 6.0 was 2W/0L (both A-grade: Feb 18 Exh=3.2, Mar 10 Exh=5.3).
  // Bearish entries are unaffected — they ride exhaustion in their favor.
  if (direction === 'bullish'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 6.0) return false;

  // Block bullish entries with low displacement velocity (< 0.08).
  // Low dvel = momentum is decelerating or flat, move is stalling.
  // Q1 2026: bullish + dvel < 0.08 was 0W/3L (all F-grade).
  // Good bullish entries had dvel 0.106 and 0.195.
  if (direction === 'bullish'
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.08) return false;

  // Block breakout entries with early-morning zero data (no meaningful intraday range).
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return false;

  // Block breakout entries with high chop + low dvel (noise, not real breakout).
  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 0.90
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.10) return false;

  // Block breakout entries with low confidence (< 74%).
  if (signalMode === 'breakout' && ctx.confidence < 0.74) return false;

  // Block breakout entries with high exhaustion + high chop.
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 7.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 1.0) return false;

  // Block breakout entries with extreme chop (>= 2.0).
  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return false;

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const spyStrategy: PartialTickerStrategy = {
  detectMode: spyDetectMode,
  adjustConfidence: spyAdjustConfidence,
  shouldAllowEntry: spyShouldAllowEntry,
};
