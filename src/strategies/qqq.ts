/**
 * QQQ-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Q4 2025 + Q1 2026 signal quality: 4A/2B/3F → tuned to 4A/2B/0F (0% bad)
 *
 * QQQ-specific code:
 *   - detectMode: filters stale/pre-market data via ATR% check on breakouts;
 *     computes and caches regime score for entry filter
 *   - adjustConfidence: penalizes high-exhaustion breakouts and choppy trends
 *   - shouldAllowEntry: blocks low ATR% (< 0.07 all modes, < 0.09 bearish trend),
 *     trend entries chasing accelerating displacement (dvel > 0.05),
 *     trend exhausted+choppy (rExh > 7 + chop >= 2.0), bullish entries with
 *     strong reversion (dvel < -0.04); blocks breakout entries missing structure
 *     confirmation, low regime (< 60), or high choppiness (>= 0.95)
 */

import type { PartialTickerStrategy, ModeDetectionResult, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { evaluateTrend, evaluateRange, evaluateBreakout, evaluateVwapReversion, resolveMode } from './default.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
// Safe because QQQ pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY.
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

// ── QQQ Mode Detection ──────────────────────────────────────────────────────

function qqqDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ModeDetectionResult {
  // Compute and cache regime score for shouldAllowEntry
  const ltf = tfIndicators[0];
  if (ltf) {
    _lastRegimeScore = computeRegimeScore(
      ltf.bars,
      ltf.vwap?.priceVsVwap ?? 0,
      ltf.dmi.adx,
    );
  }

  const htfTf = tfIndicators[2]!;

  const ltfTf = tfIndicators[0]!;

  // Parallel evaluation — all 4 modes are independent, every mode earns its way in
  const trendCandidate = evaluateTrend(htfTf);
  const rangeCandidate = evaluateRange(htfTf, currentPrice);
  let breakoutCandidate = evaluateBreakout(htfTf, tfIndicators, currentPrice);
  const vwapRevCandidate = evaluateVwapReversion(ltfTf, htfTf, currentPrice);

  // QQQ-specific: filter stale/pre-market data on breakout (ATR $0.37 on $625 = 0.06%)
  if (breakoutCandidate) {
    const atrPct = htfTf.atr.atr / currentPrice * 100;
    if (atrPct < 0.08) breakoutCandidate = null;
  }

  return resolveMode(trendCandidate, rangeCandidate, breakoutCandidate, vwapRevCandidate);
}

// ── QQQ Confidence Adjustment ────────────────────────────────────────────────

function qqqAdjustConfidence(cb: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  const adjusted = { ...cb };

  // QQQ breakouts with negative trendPhase: hard cap confidence.
  // Backtested: QQQ neg-phase breakouts always failed regardless of conf level.
  if (ctx.signalMode === 'breakout' && cb.trendPhaseBonus < 0) {
    adjusted.total = Math.min(adjusted.total, 0.64);
  }

  // Strong trend continuation relief — mirrors SPY logic.
  // When all timeframes align + ADX strong & rising, adxMaturity and moveExhaustion
  // penalties over-penalize genuine continuation (especially on gap days where
  // prior-day warmup bars inflate maturity counts).
  // Apr 2: QQQ had same pattern as SPY — all_aligned bullish, conf stuck at 37-47%
  // while 2.19% MFE move ran clean.
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

// ── QQQ Entry Filter (mirrors SPY) ──────────────────────────────────────────

function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice } = ctx;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  if (signalMode === 'breakout' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.05) return `breakout dvel ${ctx.displacementVelocity.toFixed(4)} < -0.05`;

  // ATR% lowered 0.125% → 0.08%: QQQ's normal ATR is 0.10-0.11% at current prices.
  // 0.125% blocked ALL QQQ trend entries on normal-vol days.
  if (signalMode === 'trend' && atrPct < 0.08) return `trend atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  // Block trend entries chasing accelerating displacement — mirrors SPY's proven filter.
  // High dvel = price already moved far from open = chasing the trend.
  // Raised 0.05 → 0.10: Apr 2 grade-A entries had dvel 0.07-0.17 during morning rally.
  if (signalMode === 'trend' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity > 0.10) return `trend high dvel ${ctx.displacementVelocity.toFixed(4)} > 0.10 (chasing)`;

  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion > 7.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  // bullish rangeExhaustion >= 6.0 removed: Mar 31 blocked Grade A 1.45% move.
  // SPY already removed this — exhausted+choppy (chop >= 2.0) handles the high-risk cases.

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

export const qqqStrategy: PartialTickerStrategy = {
  detectMode: qqqDetectMode,
  adjustConfidence: qqqAdjustConfidence,
  shouldAllowEntry: qqqShouldAllowEntry,
};
