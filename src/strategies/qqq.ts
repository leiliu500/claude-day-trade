/**
 * QQQ-specific trading strategy.
 *
 * Baseline cloned from strategies/spy.ts on 2026-04-22 — SPY filters and
 * confidence adjustments are the starting point for tuning QQQ. Replace /
 * extend below as QQQ-specific backtest evidence emerges.
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
// Safe because QQQ pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

// ── QQQ Mode Detection ──────────────────────────────────────────────────────
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
  // Derive "today" from the last bar's timestamp so this works identically in
  // live and backtest mode (see SPY parity note in strategies/spy.ts).
  const lastBar = bars[bars.length - 1];
  if (!lastBar) return 50;
  const todayStr = lastBar.timestamp.slice(0, 10);
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
  const choppinessComponent = (1 - choppiness) * 15;

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
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;

  // E. VWAP distance — how extended from mean (minimal lag)
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

function qqqDetectMode(
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

// ── QQQ Confidence Adjustment (cloned from SPY) ─────────────────────────────

function qqqAdjustConfidence(breakdown: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  let bd = breakdown;

  // Regime-gated suppression of perverse-signed momentum factors when ADX is
  // flat/declining (trendPhaseBonus <= 0) — see strategies/spy.ts for the
  // factor-orthogonality evidence that motivated this gate.
  if (bd.trendPhaseBonus <= 0) {
    if (bd.priceVelocityBonus !== 0) {
      bd = bd === breakdown ? { ...bd } : bd;
      bd.total -= bd.priceVelocityBonus;
      bd.priceVelocityBonus = 0;
      bd.total = Math.max(0, Math.min(1, bd.total));
    }
    if (bd.pricePositionAdjustment !== 0) {
      bd = bd === breakdown ? { ...bd } : bd;
      bd.total -= bd.pricePositionAdjustment;
      bd.pricePositionAdjustment = 0;
      bd.total = Math.max(0, Math.min(1, bd.total));
    }
    if (bd.macdBonus !== 0) {
      bd = bd === breakdown ? { ...bd } : bd;
      bd.total -= bd.macdBonus;
      bd.macdBonus = 0;
      bd.total = Math.max(0, Math.min(1, bd.total));
    }
  }

  // Bullish entries with non-positive trendPhaseBonus: zero vwapBonus.
  // vwap lift is noise when trend-phase isn't confirming; bearish side kept intact.
  if (ctx.direction === 'bullish' && bd.trendPhaseBonus <= 0) {
    if (bd.vwapBonus !== 0) {
      bd = bd === breakdown ? { ...bd } : bd;
      bd.total -= bd.vwapBonus;
      bd.vwapBonus = 0;
      bd.total = Math.max(0, Math.min(1, bd.total));
    }
  }

  // Suppress positive PA bonus for bullish trend entries at high regime (>= 75):
  // confirming bars in a high-regime tape are the final push, not fresh momentum.
  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && _lastRegimeScore >= 75 && bd.recentPriceActionBonus > 0) {
    bd = { ...bd };
    bd.total -= bd.recentPriceActionBonus;
    bd.recentPriceActionBonus = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  // Reversal trap penalty: trendPhaseBonus <= 0 + strong PA (>= 0.06) = lagging
  // indicators chasing a move that's already over.
  if (ctx.signalMode === 'trend'
      && bd.trendPhaseBonus <= 0
      && bd.recentPriceActionBonus >= 0.06) {
    bd = bd === breakdown ? { ...bd } : bd;
    const penalty = 0.06;
    bd.recentPriceActionBonus -= Math.min(bd.recentPriceActionBonus, penalty);
    bd.total -= penalty;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  // Strong trend continuation relief: all_aligned + ADX strong & rising
  // over-penalizes genuine continuation. Halve the severe portions of
  // moveExhaustion and (if severe) adxMaturity, and unlock trendPersistenceBonus.
  if (ctx.signalMode === 'trend'
      && ctx.alignment === 'all_aligned'
      && bd.trendPhaseBonus > 0          // ADX still rising
      && bd.adxBonus >= 0.05             // ADX > 25
      && bd.moveExhaustionPenalty <= -0.10) {
    bd = bd === breakdown ? { ...bd } : bd;
    const exhRelief = -bd.moveExhaustionPenalty * 0.5;
    bd.moveExhaustionPenalty *= 0.5;
    bd.total += exhRelief;
    if (bd.adxMaturityPenalty <= -0.08) {
      const matRelief = -bd.adxMaturityPenalty * 0.5;
      bd.adxMaturityPenalty *= 0.5;
      bd.total += matRelief;
    }
    if (bd.structureBonus <= 0) {
      bd.structureBonus = 0.01;
    }
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  return bd;
}

// ── QQQ Entry Filter (cloned from SPY) ──────────────────────────────────────

function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice } = ctx;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  if (signalMode === 'breakout' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.05) return `breakout dvel ${ctx.displacementVelocity.toFixed(4)} < -0.05`;

  if (signalMode === 'trend' && atr < 0.45) return `trend atr ${atr.toFixed(3)} < 0.45`;

  if (signalMode === 'trend' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity > 0.10) return `trend high dvel ${ctx.displacementVelocity.toFixed(4)} > 0.10 (chasing)`;

  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion > 6.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 8.0
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.04
      && ctx.alignment !== 'all_aligned') return `trend exhausted+fading rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)} (stalled)`;

  if (direction === 'bullish'
      && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.04 && ctx.displacementVelocity >= -0.05) return `bullish dvel ${ctx.displacementVelocity.toFixed(4)} in [-0.05, -0.04)`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;

  if (signalMode === 'breakout'
      && ctx.choppiness !== undefined && ctx.choppiness >= 0.90
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)}`;

  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 9.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  // Conf>=0.95 carve-out (2026-04-24): see strategies/spy.ts rationale.
  if (signalMode === 'breakout'
      && ctx.confidence < 0.95
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;

  if (signalMode === 'breakout' && _lastRegimeScore >= 80) return `breakout regime ${_lastRegimeScore} >= 80`;

  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 4.5
      && _lastRegimeScore >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${_lastRegimeScore}`;

  if (direction === 'bullish' && _lastRegimeScore <= 50) return `bullish lowRegime ${_lastRegimeScore} <= 50`;

  // Mid-strength kill zone, with carve-outs for strength==71/77 which rejected-goods
  // mining showed are AB-biased: strength=71 blocks 10A/3B/9C/0D/3F, strength=77
  // blocks 9A/0B/2C/0D/5F. Other strengths 70-79 are net F-biased.
  if (ctx.strengthScore >= 70 && ctx.strengthScore < 80
      && ctx.strengthScore !== 71 && ctx.strengthScore !== 77) {
    return `mid-strength kill zone ${ctx.strengthScore}`;
  }

  if (direction === 'bullish' && signalMode === 'trend'
      && ctx.breakdown.orbBonus >= 0.04) {
    return `bullish trend+orb ${ctx.breakdown.orbBonus.toFixed(2)}`;
  }

  // Mode=breakout carve-out (2026-04-24): midday chop filter catches trend-mode chop,
  // not genuine breakouts. See strategies/spy.ts for evidence.
  if (signalMode !== 'breakout'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 210 && ctx.minutesSinceOpen < 225) {
    return `midday chop window ${ctx.minutesSinceOpen}m (13:00-13:15 ET)`;
  }

  if (direction === 'bearish' && ctx.breakdown.pricePositionAdjustment <= -0.028) {
    return `bearish deep pricePos ${ctx.breakdown.pricePositionAdjustment.toFixed(3)} (exhausted)`;
  }

  // Bullish symmetric PA filter — mine-breakdown post-528a58d (low-cascade 24%).
  // Bullish side: 14 hits split 1A/1B/1C/3D/8F at pricePositionAdjustment <-0.028.
  // Same threshold as bearish rule above for consistency.
  if (direction === 'bullish' && ctx.breakdown.pricePositionAdjustment <= -0.028) {
    return `bullish deep pricePos ${ctx.breakdown.pricePositionAdjustment.toFixed(3)} (against-trend)`;
  }

  // Mode=breakout carve-out (2026-04-24): across 6 QQQ historical extreme-atr
  // rejections in mode=breakout, 4 were Grade A (67% AB, rawCost +6). The filter
  // correctly catches high-ATR trend-mode entries but blocks genuine breakouts.
  if (signalMode !== 'breakout' && ctx.atr >= 1.33) {
    return `extreme atr ${ctx.atr.toFixed(2)} >= 1.33`;
  }

  // Low-volatility bearish filter — at atr < 0.6 bearish entries cluster 17F /
  // 4B / 3A (F-rate 50%). Complements the existing trend+atr<0.45 rule by
  // catching the 0.45-0.60 band and cross-mode bearish low-vol traps.
  if (direction === 'bearish' && ctx.atr < 0.6) {
    return `bearish low atr ${ctx.atr.toFixed(2)} < 0.6 (F-biased)`;
  }

  // High macdBonus bullish filter — mined post-73dc19f. Full cut (macd>0.03
  // both directions) gave +0.204 gross but breached -0.15 floor in 4 months
  // (2025-05/07/08, 2026-02) — bearish side loses 10 A-grades. Bullish side
  // clean: 0A/3B/4C/1D/10F (F=56%, no A losses) → raw +0.046, low risk.
  if (direction === 'bullish' && ctx.breakdown.macdBonus > 0.03) {
    return `bullish high macdBonus ${ctx.breakdown.macdBonus.toFixed(3)} > 0.03 (trend-chase)`;
  }

  // Bearish saturated-strength macd filter — mined post-c10fe8f. Bearish side
  // of macd>0.03 had 10A losses flat, but the strength==100 subcluster is
  // 18F / 1A / 1B (20 hits) — late-stage short into maxed-out momentum.
  if (direction === 'bearish' && ctx.breakdown.macdBonus > 0.03 && ctx.strengthScore === 100) {
    return `bearish saturated macd+strength (macd=${ctx.breakdown.macdBonus.toFixed(3)})`;
  }

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const qqqStrategy: PartialTickerStrategy = {
  detectMode: qqqDetectMode,
  adjustConfidence: qqqAdjustConfidence,
  shouldAllowEntry: qqqShouldAllowEntry,
};
