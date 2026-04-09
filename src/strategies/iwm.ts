/**
 * IWM-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline: 5A/1B/6C/10F → tuned to 4A/1B/4C/0F (0% bad)
 *
 * IWM-specific filters:
 *   - Block trend entries chasing accelerating displacement (dvel > 0.05)
 *   - Block trend exhausted+choppy (rExh > 7 + chop >= 2.0)
 *   - Block bullish entries with strong reversion (dvel < -0.04)
 *   - Block breakout entries at high regime (>= 80)
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY/QQQ.
 * Candle-based (choppiness, displacement velocity, trend strength) + ADX anchor + VWAP distance.
 */
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayBars = bars.filter(b => {
    if (!b.timestamp.startsWith(todayStr)) return false;
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const mins = h * 60 + m;
    return mins >= 810 && mins < 1200; // 13:30–20:00 UTC
  });
  if (todayBars.length < 20) return 50;

  // A. Choppiness
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
  const choppinessComponent = (1 - choppiness) * 15;

  // B. Displacement velocity
  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

  // C. Trend strength
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

  // D. ADX anchor
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;

  // E. VWAP distance
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

// ── IWM Mode Detection ──────────────────────────────────────────────────────

import { defaultStrategy } from './default.js';

function iwmDetectMode(
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

  // Delegate to default mode detection
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── IWM Confidence Adjustment ───────────────────────────────────────────────

function iwmAdjustConfidence(cb: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  const adjusted = { ...cb };

  // Suppress PA bonus for bullish trend entries at high regime — ported from SPY/QQQ.
  // At regime >= 75, confirming candles are exhaustion signals, not fresh momentum.
  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && _lastRegimeScore >= 75 && adjusted.recentPriceActionBonus > 0) {
    adjusted.total -= adjusted.recentPriceActionBonus;
    adjusted.recentPriceActionBonus = 0;
    adjusted.total = Math.max(0, adjusted.total);
  }

  // Strong trend continuation relief — mirrors SPY/QQQ logic.
  // When all timeframes align + ADX strong & rising, adxMaturity and moveExhaustion
  // penalties over-penalize genuine continuation (especially on gap days where
  // prior-day warmup bars inflate maturity counts).
  if (ctx.signalMode === 'trend'
      && ctx.alignment === 'all_aligned'
      && adjusted.trendPhaseBonus > 0          // ADX still rising
      && adjusted.adxBonus >= 0.05             // ADX > 25
      && adjusted.moveExhaustionPenalty <= -0.10) {
    // Halve move exhaustion penalty
    const exhRelief = -adjusted.moveExhaustionPenalty * 0.5;
    adjusted.moveExhaustionPenalty *= 0.5;
    adjusted.total += exhRelief;
    // Halve ADX maturity penalty if severe
    if (adjusted.adxMaturityPenalty <= -0.08) {
      const matRelief = -adjusted.adxMaturityPenalty * 0.5;
      adjusted.adxMaturityPenalty *= 0.5;
      adjusted.total += matRelief;
    }
    // Unlock trendPersistenceBonus on gap days
    if (adjusted.structureBonus <= 0) {
      adjusted.structureBonus = 0.01;
    }
    adjusted.total = Math.max(0, Math.min(1, adjusted.total));
  }
  return adjusted;
}

// ── IWM Entry Filter (mirrors SPY) ─────────────────────────────────────────

function iwmShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice } = ctx;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  if (signalMode === 'breakout' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.05) return `breakout dvel ${ctx.displacementVelocity.toFixed(4)} < -0.05`;

  // SPY uses absolute atr < 0.70 (~0.125% of $560); equivalent atrPct for IWM
  if (signalMode === 'trend' && atrPct < 0.125) return `trend atrPct ${atrPct.toFixed(3)}% < 0.125%`;

  // Block early trend entries before range establishes — rExh=0 + chop=0 entries were all F-grade.
  // Mar 27 09:42 F (rExh=0.0), Apr 1 09:38 F (rExh=0.0). No good trend entries had rExh < 1.0.
  // Excludes breakout: ORB breakouts at the open can be valid.
  if (signalMode === 'trend' && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0
      && ctx.choppiness !== undefined && ctx.choppiness < 0.01) return `trend early morning rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)} (insufficient range)`;

  // Low-ATR trend filter relaxed: 0.22% blocked ALL IWM entries (typical ATR 0.12-0.13%).
  // The base 0.125% check above already catches genuinely dead markets.

  // Block trend entries chasing accelerating displacement.
  // Raised 0.10 → 0.20: Apr 2 grade-A entries had dvel 0.10-0.27 during morning rally.
  // IWM has higher dvel than SPY/QQQ during genuine trends; 0.10 blocked ALL A-grade entries.
  if (signalMode === 'trend' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity > 0.20) return `trend high dvel ${ctx.displacementVelocity.toFixed(4)} > 0.20 (chasing)`;

  // Exhausted+choppy: lowered rExh from 7.0 to 6.0 to match SPY/QQQ.
  // Apr 9 IWM: entries at rExh 6.0-7.0 with high chop were all F-grade.
  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion > 6.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  // Exhausted+fading: ported from SPY/QQQ. When range exhaustion is high AND displacement
  // velocity has stalled, the trend is dying — further entries are chasing.
  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 7.0
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.04) return `trend exhausted+fading rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)} (stalled)`;

  if (direction === 'bullish'
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < -0.04) return `bullish dvel ${ctx.displacementVelocity.toFixed(4)} < -0.04`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;

  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 0.90
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)}`;

  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 7.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;

  if (signalMode === 'breakout' && _lastRegimeScore >= 80) return `breakout regime ${_lastRegimeScore} >= 80`;

  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 4.5
      && _lastRegimeScore >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${_lastRegimeScore}`;

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const iwmStrategy: PartialTickerStrategy = {
  detectMode: iwmDetectMode,
  adjustConfidence: iwmAdjustConfidence,
  shouldAllowEntry: iwmShouldAllowEntry,
};
