/**
 * DIA-specific trading strategy.
 *
 * Baseline cloned from strategies/spy.ts on 2026-04-25 — SPY filters and
 * confidence adjustments are the starting point for tuning DIA. Replace /
 * extend below as DIA-specific backtest evidence emerges.
 *
 * DIA (~$425) is a large-cap blue-chip ETF, behaviorally similar to SPY but
 * at ~0.65x absolute price. Absolute-ATR thresholds in SPY are converted to
 * atrPct for DIA — same pattern as the IWM clone.
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// Module-level state: regime score computed in detectMode, read in shouldAllowEntry.
// Safe because DIA pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

import { defaultStrategy } from './default.js';

/**
 * Compute intraday regime score — same hybrid algorithm as SPY/QQQ/IWM.
 * `todayStr` is derived from the LAST bar's timestamp so this works identically
 * in live and backtest mode.
 */
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
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

  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

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

  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

function diaDetectMode(
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
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── DIA Confidence Adjustment (cloned from SPY) ─────────────────────────────

function diaAdjustConfidence(breakdown: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  let bd = breakdown;

  // Regime-gated suppression of perverse-signed momentum factors when ADX is
  // flat/declining — see strategies/spy.ts for factor-orthogonality evidence.
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

  // Suppress positive PA bonus for bullish trend entries at high regime (>= 75).
  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && _lastRegimeScore >= 75 && bd.recentPriceActionBonus > 0) {
    bd = { ...bd };
    bd.total -= bd.recentPriceActionBonus;
    bd.recentPriceActionBonus = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  // Reversal trap penalty: trendPhaseBonus <= 0 + strong PA (>= 0.06).
  if (ctx.signalMode === 'trend'
      && bd.trendPhaseBonus <= 0
      && bd.recentPriceActionBonus >= 0.06) {
    bd = bd === breakdown ? { ...bd } : bd;
    const penalty = 0.06;
    bd.recentPriceActionBonus -= Math.min(bd.recentPriceActionBonus, penalty);
    bd.total -= penalty;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  // Strong trend continuation relief: all_aligned + ADX strong & rising.
  if (ctx.signalMode === 'trend'
      && ctx.alignment === 'all_aligned'
      && bd.trendPhaseBonus > 0
      && bd.adxBonus >= 0.05
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

// ── DIA Entry Filter (cloned from SPY) ──────────────────────────────────────

function diaShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice } = ctx;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  if (signalMode === 'breakout' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.05) return `breakout dvel ${ctx.displacementVelocity.toFixed(4)} < -0.05`;

  // SPY uses absolute atr < 0.45 at SPY ~$560 (~0.08%). Use atrPct for DIA scale.
  if (signalMode === 'trend' && atrPct < 0.08) return `trend atrPct ${atrPct.toFixed(3)}% < 0.08%`;

  if (signalMode === 'trend' && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity > 0.10) return `trend high dvel ${ctx.displacementVelocity.toFixed(4)} > 0.10 (chasing)`;

  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion > 6.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  if (signalMode === 'trend'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 8.0
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.04
      && ctx.alignment !== 'all_aligned') return `trend exhausted+fading rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)} (stalled)`;

  if (signalMode === 'trend' && direction === 'bullish'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 7.5) {
    return `bullish rangeExh ${ctx.rangeExhaustion.toFixed(1)} >= 7.5`;
  }

  if (direction === 'bullish'
      && ctx.displacementVelocity !== undefined
      && ctx.displacementVelocity < -0.04 && ctx.displacementVelocity >= -0.05) return `bullish dvel ${ctx.displacementVelocity.toFixed(4)} in [-0.05, -0.04)`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;

  // DIA tuning 2026-04-26: conf>=0.95 carve-out added (mirrors SPY 3ced689
  // pattern on the extremeChop filter). Apr 23 13:11 ET bearish breakout had
  // conf=95%, chop=2.13, dvel=0.0134, MFE=0.72% Grade A — blocked here despite
  // high conviction because this filter had no conf carve-out. SPY/QQQ caught
  // the same move; DIA missed it. The carve-out skips this filter when the
  // signal carries the confidence to override chop+lowDvel concerns.
  if (signalMode === 'breakout'
      && ctx.confidence < 0.95
      && ctx.choppiness !== undefined && ctx.choppiness >= 0.90
      && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${ctx.displacementVelocity.toFixed(4)}`;

  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;

  if (signalMode === 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 9.0
      && ctx.choppiness !== undefined && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

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

  // Mid-strength kill zone — mirrors SPY.
  if (ctx.strengthScore >= 70 && ctx.strengthScore < 80) {
    return `mid-strength kill zone ${ctx.strengthScore}`;
  }

  // Bullish trend + high ORB bonus — mirrors SPY.
  if (direction === 'bullish' && signalMode === 'trend'
      && ctx.breakdown.orbBonus >= 0.04) {
    return `bullish trend+orb ${ctx.breakdown.orbBonus.toFixed(2)}`;
  }

  // Midday chop window 13:00-13:15 ET (mode=breakout carve-out) — mirrors SPY.
  if (signalMode !== 'breakout'
      && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 210 && ctx.minutesSinceOpen < 225) {
    return `midday chop window ${ctx.minutesSinceOpen}m (13:00-13:15 ET)`;
  }

  // Bearish + deep range-position penalty — mirrors SPY.
  if (direction === 'bearish' && ctx.breakdown.pricePositionAdjustment <= -0.028) {
    return `bearish deep pricePos ${ctx.breakdown.pricePositionAdjustment.toFixed(3)} (exhausted)`;
  }

  // Bullish top-extreme + exhausted move — mirrors SPY 9ecbff7.
  if (direction === 'bullish'
      && ctx.breakdown.pricePositionAdjustment <= -0.07
      && ctx.breakdown.moveExhaustionPenalty <= -0.05) {
    return `bullish top-extreme exhausted ppa=${ctx.breakdown.pricePositionAdjustment.toFixed(3)} mex=${ctx.breakdown.moveExhaustionPenalty.toFixed(3)}`;
  }

  // Extreme atrPct — mirrors SPY 2bb1b39 (mode=breakout carve-out).
  // SPY threshold abs 1.33 at SPY~$560 = ~0.24%. Use atrPct for DIA scale.
  if (signalMode !== 'breakout' && atrPct >= 0.24) {
    return `extreme atrPct ${atrPct.toFixed(3)}% >= 0.24%`;
  }

  // Bearish saturated-strength macd filter — mirrors SPY.
  if (direction === 'bearish' && ctx.breakdown.macdBonus > 0.03 && ctx.strengthScore === 100) {
    return `bearish saturated macd+strength (macd=${ctx.breakdown.macdBonus.toFixed(3)})`;
  }

  // Bullish high-strength macd filter — mirrors SPY.
  if (direction === 'bullish' && ctx.breakdown.macdBonus > 0.03 && ctx.strengthScore >= 80) {
    return `bullish high macdBonus+strength (macd=${ctx.breakdown.macdBonus.toFixed(3)} s=${ctx.strengthScore})`;
  }

  // Bearish triangle-contraction + positive macd filter — mirrors SPY.
  if (direction === 'bearish'
      && ctx.breakdown.trContractionPenalty < 0
      && ctx.breakdown.macdBonus > 0) {
    return `bearish triangle-contract+macd trC=${ctx.breakdown.trContractionPenalty.toFixed(2)} macd=${ctx.breakdown.macdBonus.toFixed(2)}`;
  }

  // Bearish low-atr + strength filter — use atrPct for DIA scale.
  // SPY threshold abs 0.6 at SPY~$560 = ~0.107%.
  if (direction === 'bearish' && atrPct < 0.10 && ctx.strengthScore >= 70) {
    return `bearish low atrPct+strength ${atrPct.toFixed(3)}% < 0.10 s=${ctx.strengthScore}`;
  }

  return true;
}

export const diaStrategy: PartialTickerStrategy = {
  detectMode: diaDetectMode,
  adjustConfidence: diaAdjustConfidence,
  shouldAllowEntry: diaShouldAllowEntry,
};
