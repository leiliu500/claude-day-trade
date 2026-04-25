/**
 * DIA backtest configuration.
 *
 * Baseline cloned from backtest-configs/spy.ts on 2026-04-25 — SPY filters,
 * confidence adjustments, and parameters are the starting point for tuning
 * DIA. Replace / extend below as DIA-specific backtest evidence emerges.
 *
 * Order-simulation lives in src/lib/order-agent-sim-dia.ts (4x premium floor
 * for DIA scale).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentDia } from '../../lib/order-agent-sim-dia.js';

/**
 * DIA entry filter — mirrors strategies/dia.ts diaShouldAllowEntry.
 * DIA uses atrPct (not absolute atr) for thresholds because DIA trades around
 * $425 vs SPY ~$560 — absolute ATR scale differs by ~0.65x. Same pattern as IWM clone.
 */
function diaShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, direction, atr, currentPrice, displacementVelocity } = ctx;
  const regime = ctx.regimeScore;

  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  if (signalMode === 'breakout' && atrPct < 0.08) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'breakout' && displacementVelocity < -0.05) return `breakout dvel ${displacementVelocity.toFixed(4)} < -0.05`;
  if (signalMode === 'trend' && atrPct < 0.08) return `trend atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'trend' && displacementVelocity > 0.10) return `trend high dvel ${displacementVelocity.toFixed(4)} > 0.10 (chasing)`;
  if (signalMode === 'trend'
      && ctx.rangeExhaustion > 6.0
      && ctx.choppiness >= 2.0) return `trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  if (signalMode === 'trend'
      && ctx.rangeExhaustion >= 8.0
      && displacementVelocity < 0.04
      && ctx.alignment !== 'all_aligned') return `trend exhausted+fading rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${displacementVelocity.toFixed(4)} (stalled)`;

  if (signalMode === 'trend' && direction === 'bullish' && ctx.rangeExhaustion >= 7.5) {
    return `bullish rangeExh ${ctx.rangeExhaustion.toFixed(1)} >= 7.5`;
  }

  if (direction === 'bullish' && displacementVelocity < -0.04 && displacementVelocity >= -0.05) {
    return `bullish dvel ${displacementVelocity.toFixed(4)} in [-0.05, -0.04)`;
  }
  if (signalMode === 'breakout' && ctx.rangeExhaustion < 1.0) return `breakout rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;
  if (signalMode === 'breakout'
      && ctx.choppiness >= 0.90 && displacementVelocity < 0.10) return `breakout chop+lowDvel chop=${ctx.choppiness.toFixed(2)} dvel=${displacementVelocity.toFixed(4)}`;
  if (signalMode === 'breakout' && ctx.confidence < 0.74) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 74%`;
  if (signalMode === 'breakout'
      && ctx.rangeExhaustion >= 9.0 && ctx.choppiness >= 1.0) return `breakout highExh+highChop rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;

  if (signalMode === 'breakout' && ctx.confidence < 0.95 && ctx.choppiness >= 2.0) {
    return `breakout extremeChop ${ctx.choppiness.toFixed(2)} >= 2.0`;
  }

  if (signalMode === 'breakout' && ctx.rangeExhaustion >= 9.0) return `breakout extremeExhaustion ${ctx.rangeExhaustion.toFixed(1)} >= 9.0`;
  if (signalMode === 'breakout' && regime >= 80) return `breakout regime ${regime} >= 80`;
  if (signalMode === 'breakout' && direction === 'bullish'
      && ctx.rangeExhaustion >= 4.5 && regime >= 65) return `bullish breakout highExh+regime rExh=${ctx.rangeExhaustion.toFixed(1)} regime=${regime}`;

  if (direction === 'bullish' && regime <= 50) return `bullish lowRegime ${regime} <= 50`;

  if (ctx.strengthScore >= 70 && ctx.strengthScore < 80) {
    return `mid-strength kill zone ${ctx.strengthScore}`;
  }

  if (direction === 'bullish' && signalMode === 'trend' && ctx.breakdown.orbBonus >= 0.04) {
    return `bullish trend+orb ${ctx.breakdown.orbBonus.toFixed(2)}`;
  }

  if (signalMode !== 'breakout'
      && ctx.minutesSinceOpen >= 210 && ctx.minutesSinceOpen < 225) {
    return `midday chop window ${ctx.minutesSinceOpen}m (13:00-13:15 ET)`;
  }

  if (direction === 'bearish' && ctx.breakdown.pricePositionAdjustment <= -0.028) {
    return `bearish deep pricePos ${ctx.breakdown.pricePositionAdjustment.toFixed(3)} (exhausted)`;
  }

  if (direction === 'bullish'
      && ctx.breakdown.pricePositionAdjustment <= -0.07
      && ctx.breakdown.moveExhaustionPenalty <= -0.05) {
    return `bullish top-extreme exhausted ppa=${ctx.breakdown.pricePositionAdjustment.toFixed(3)} mex=${ctx.breakdown.moveExhaustionPenalty.toFixed(3)}`;
  }

  if (signalMode !== 'breakout' && atrPct >= 0.24) {
    return `extreme atrPct ${atrPct.toFixed(3)}% >= 0.24%`;
  }

  if (direction === 'bearish' && ctx.breakdown.macdBonus > 0.03 && ctx.strengthScore === 100) {
    return `bearish saturated macd+strength (macd=${ctx.breakdown.macdBonus.toFixed(3)})`;
  }

  if (direction === 'bullish' && ctx.breakdown.macdBonus > 0.03 && ctx.strengthScore >= 80) {
    return `bullish high macdBonus+strength (macd=${ctx.breakdown.macdBonus.toFixed(3)} s=${ctx.strengthScore})`;
  }

  if (direction === 'bearish'
      && ctx.breakdown.trContractionPenalty < 0
      && ctx.breakdown.macdBonus > 0) {
    return `bearish triangle-contract+macd trC=${ctx.breakdown.trContractionPenalty.toFixed(2)} macd=${ctx.breakdown.macdBonus.toFixed(2)}`;
  }

  if (direction === 'bearish' && atrPct < 0.10 && ctx.strengthScore >= 70) {
    return `bearish low atrPct+strength ${atrPct.toFixed(3)}% < 0.10 s=${ctx.strengthScore}`;
  }

  return true;
}

/**
 * DIA confidence adjustment — mirrors strategies/dia.ts diaAdjustConfidence.
 */
function diaAdjustConfidence(breakdown: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  let bd = breakdown;
  const regime = ctx.regimeScore;

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

  if (ctx.signalMode === 'trend'
      && bd.trendPhaseBonus <= 0
      && bd.recentPriceActionBonus >= 0.06) {
    bd = bd === breakdown ? { ...bd } : bd;
    const penalty = 0.06;
    bd.recentPriceActionBonus -= Math.min(bd.recentPriceActionBonus, penalty);
    bd.total -= penalty;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

  if (ctx.signalMode === 'trend' && ctx.direction === 'bullish'
      && regime >= 75 && bd.recentPriceActionBonus > 0) {
    bd = bd === breakdown ? { ...bd } : bd;
    bd.total -= bd.recentPriceActionBonus;
    bd.recentPriceActionBonus = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
  }

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

export const DIA_CONFIG: Partial<TickerBacktestConfig> = {
  trendMaxExhaustion: 999,

  dailyRiskBudgetPct: 0.05,

  breakoutStrictTrendPhase: true,

  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  shouldAllowEntry: diaShouldAllowEntry,
  adjustConfidence: diaAdjustConfidence,
  simulate: simulateOrderAgentDia,
};
