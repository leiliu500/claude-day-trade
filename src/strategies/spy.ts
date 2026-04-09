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
  let bd = breakdown;

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
      && _lastRegimeScore >= 75 && bd.recentPriceActionBonus > 0) {
    bd = { ...bd };
    bd.total -= bd.recentPriceActionBonus;
    bd.recentPriceActionBonus = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  // Strong trend continuation relief: when all timeframes align + ADX strong & rising,
  // the adxMaturity and moveExhaustion penalties over-penalize genuine continuation.
  //
  // Apr 2: all_aligned bullish from 09:45, conf stuck at 34% (adxMat=-0.12, moveExh=-0.15)
  // while 1.83% MFE move ran clean (R=∞). The penalties doubled at 09:52 when
  // momentumAccelBonus/diSpreadSlope temporarily dipped negative (losing halving benefit),
  // even though ADX was 40+ and still rising.
  //
  // Relief: halve the severe portions of both penalties when continuation is confirmed.
  // Also set structureBonus > 0 to unlock trendPersistenceBonus (blocked by struct<=0
  // on gap-up days where price moves away from prior-day levels).
  if (ctx.signalMode === 'trend'
      && ctx.alignment === 'all_aligned'
      && bd.trendPhaseBonus > 0          // ADX still rising
      && bd.adxBonus >= 0.05             // ADX > 25 (confirmed trend)
      && bd.moveExhaustionPenalty <= -0.10) {
    bd = bd === breakdown ? { ...bd } : bd;
    // Halve move exhaustion penalty
    const exhRelief = -bd.moveExhaustionPenalty * 0.5;
    bd.moveExhaustionPenalty *= 0.5;
    bd.total += exhRelief;
    // Halve ADX maturity penalty if severe
    if (bd.adxMaturityPenalty <= -0.08) {
      const matRelief = -bd.adxMaturityPenalty * 0.5;
      bd.adxMaturityPenalty *= 0.5;
      bd.total += matRelief;
    }
    // Unlock trendPersistenceBonus — on gap days, structureBonus is 0 because
    // price moved away from prior-day levels, but the trend is still valid.
    if (bd.structureBonus <= 0) {
      bd.structureBonus = 0.01;
    }
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  return bd;
}

// ── SPY Entry Filter ────────────────────────────────────────────────────────

function spyShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice } = ctx;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  if (signalMode === 'breakout' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.05) return `breakout dvel ${ctx.displacementVelocity.toFixed(4)} < -0.05`;

  // ATR lowered 0.65 → 0.45: at SPY ~$560, 0.65 = 0.116% which blocked normal-vol days.
  // 0.45 = ~0.08% catches genuinely dead markets while allowing normal activity.
  if (signalMode === 'trend' && atr < 0.45) return `trend atr ${atr.toFixed(3)} < 0.45`;

  // Block trend entries chasing accelerating displacement.
  // Mar data: A-grade dvel <= 0.024, F-grade dvel >= 0.023. Threshold 0.05.
  // Apr 2: grade-A entries had dvel 0.078-0.175 during strong morning rally.
  // Raised 0.05 → 0.10 to allow genuine momentum while still blocking extreme chase.
  // Mar 24: 3F blocked. Mar 26: 2F blocked, 4A kept. Mar 31: 1F blocked. Apr 1: 2F blocked.
  if (signalMode === 'trend' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity > 0.10) return `trend high dvel ${ctx.displacementVelocity.toFixed(4)} > 0.10 (chasing)`;

  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion > 6.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  // Exhausted + fading velocity: at rExh >= 8.0 with dvel < 0.05, the daily move
  // is spent AND no longer accelerating. Apr 9: rExh 8.3-8.5 + dvel 0.004-0.038
  // → 4F+1D, all DECLINING_SINCE_FILL. rExh >= 8.0 alone is too broad (blocks
  // strong trending days where dvel is still high). Adding dvel < 0.05 ensures we
  // only block entries where the move has genuinely stalled.
  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 8.0
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.04) return `trend exhausted+fading rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)} (stalled)`;

  // bullish rangeExhaustion >= 6.0 removed for trends: Q1 counterfactual net costly —
  // exhausted+choppy (chop >= 2.0) now handles the high-risk cases

  if (direction === 'bullish'
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < -0.04) return `bullish dvel ${ctx.displacementVelocity.toFixed(4)} < -0.04`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;

  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 0.90
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)}`;

  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 9.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;

  if (signalMode === 'breakout' && _lastRegimeScore >= 80) return `breakout regime ${_lastRegimeScore} >= 80`;

  // breakout_atr < 0.80 removed: Q4+Q1 counterfactual net +9 costly (13 good vs 4 bad).
  // breakout_atrPct < 0.08% and trend_atr < 0.70 already catch genuinely low-volatility cases.

  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 4.5
      && _lastRegimeScore >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${_lastRegimeScore}`;

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const spyStrategy: PartialTickerStrategy = {
  detectMode: spyDetectMode,
  adjustConfidence: spyAdjustConfidence,
  shouldAllowEntry: spyShouldAllowEntry,
};
