/**
 * Structural Trigger System — replaces the 30-factor weighted confidence model.
 *
 * Each mode has 5 binary conditions that must ALL pass for entry.
 * No weights, no thresholds to tune. Each condition is independently meaningful.
 */

import type { SignalPayload } from '../types/signal.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TriggerCondition {
  name: string;
  passed: boolean;
  detail: string;
}

export interface TriggerResult {
  conditions: TriggerCondition[];
  allPassed: boolean;
  passCount: number;
  totalCount: number;
  confidence: number;
}

// ── Confidence mapping ─────────────────────────────────────────────────────────

function mapConfidence(passCount: number, totalCount: number): number {
  if (passCount === totalCount) return 0.70;
  if (passCount === totalCount - 1) return 0.55;
  if (passCount === totalCount - 2) return 0.40;
  return 0.25;
}

function buildResult(conditions: TriggerCondition[]): TriggerResult {
  const passCount = conditions.filter(c => c.passed).length;
  const totalCount = conditions.length;
  return {
    conditions,
    allPassed: passCount === totalCount,
    passCount,
    totalCount,
    confidence: mapConfidence(passCount, totalCount),
  };
}

// ── TREND triggers ─────────────────────────────────────────────────────────────

export function evaluateTrendTriggers(signal: SignalPayload): TriggerResult {
  const [ltf, mtf, htf] = signal.timeframes;
  const dir = signal.direction;

  // 1. DIRECTION_CONFIRMED: ≥2 of 3 TF DMI trends agree
  const dmiMatch = [ltf, mtf, htf].filter(tf => tf.dmi.trend === dir).length;
  const directionConfirmed: TriggerCondition = {
    name: 'DIRECTION_CONFIRMED',
    passed: dmiMatch >= 2,
    detail: `${dmiMatch}/3 TFs agree on ${dir}`,
  };

  // 2. VWAP_ALIGNED: price on correct side of VWAP
  const htfVwapVs = htf.vwap.priceVsVwap;
  const vwapAligned: TriggerCondition = {
    name: 'VWAP_ALIGNED',
    passed: dir === 'bullish' ? htfVwapVs > 0 : htfVwapVs < 0,
    detail: `price ${htfVwapVs > 0 ? 'above' : 'below'} VWAP (${htfVwapVs.toFixed(3)}%)`,
  };

  // 3. NOT_CHASING: price within 1.5 ATR of VWAP (volatility-adaptive)
  const maxDistPct = (1.5 * htf.atr.atr / signal.currentPrice) * 100;
  const absVwapDist = Math.abs(htfVwapVs);
  const notChasing: TriggerCondition = {
    name: 'NOT_CHASING',
    passed: absVwapDist <= maxDistPct,
    detail: `VWAP dist ${absVwapDist.toFixed(3)}% vs max ${maxDistPct.toFixed(3)}%`,
  };

  // 4. STRUCTURE_SUPPORT: ORB direction matches OR price on correct side of PDC
  //    On gap days (price far from PDC), VWAP becomes the intraday structure reference.
  const orbMatches = signal.orb.orbFormed && signal.orb.breakoutDirection === dir;
  const pdcAligned = dir === 'bullish'
    ? signal.currentPrice > signal.priorDayLevels.pdc
    : signal.currentPrice < signal.priorDayLevels.pdc;
  const pdcDistPct = Math.abs(signal.currentPrice - signal.priorDayLevels.pdc) / signal.currentPrice * 100;
  const isGapDay = pdcDistPct > 1.0;
  const vwapAlignedForGap = isGapDay && (dir === 'bullish' ? htfVwapVs > 0 : htfVwapVs < 0);
  const structureSupport: TriggerCondition = {
    name: 'STRUCTURE_SUPPORT',
    passed: orbMatches || pdcAligned || vwapAlignedForGap,
    detail: orbMatches
      ? `ORB breakout ${signal.orb.breakoutDirection}`
      : pdcAligned ? `price aligned with PDC ($${signal.priorDayLevels.pdc.toFixed(2)})`
      : vwapAlignedForGap ? `gap day (${pdcDistPct.toFixed(1)}% from PDC) — price ${dir === 'bullish' ? 'above' : 'below'} VWAP`
      : `price against PDC ($${signal.priorDayLevels.pdc.toFixed(2)})`,
  };

  // 5. VOLUME_CONFIRMS: OBV trend matches direction on HTF or MTF
  const obvMatch = htf.obv.trend === dir || mtf.obv.trend === dir;
  const volumeConfirms: TriggerCondition = {
    name: 'VOLUME_CONFIRMS',
    passed: obvMatch,
    detail: `OBV HTF=${htf.obv.trend} MTF=${mtf.obv.trend}`,
  };

  // 6. MOMENTUM_CONFIRMS: LTF price velocity not actively opposing signal direction
  //    Blocks entries where context is right but price is currently moving against you.
  //    Permissive: only blocks when velocity is clearly opposing (> 0.03 against direction).
  //    Aligned or near-zero velocity passes.
  const vel = ltf.priceVelocity.directionalVelocity;
  const velOpposing = dir === 'bullish' ? vel < -0.03 : vel > 0.03;
  const momentumConfirms: TriggerCondition = {
    name: 'MOMENTUM_CONFIRMS',
    passed: !velOpposing,
    detail: `LTF velocity ${vel.toFixed(4)} (${velOpposing ? 'opposing' : 'ok'})`,
  };

  return buildResult([directionConfirmed, vwapAligned, notChasing, structureSupport, volumeConfirms, momentumConfirms]);
}

// ── RANGE triggers ─────────────────────────────────────────────────────────────

export function evaluateRangeTriggers(signal: SignalPayload): TriggerResult {
  const [ltf, _mtf, htf] = signal.timeframes;
  const dir = signal.direction;

  // 1. AT_EXTREME: price beyond VWAP 1-sigma band
  const vwap = htf.vwap;
  const atLowerExtreme = signal.currentPrice <= vwap.vwap - vwap.deviation;
  const atUpperExtreme = signal.currentPrice >= vwap.vwap + vwap.deviation;
  const atExtreme: TriggerCondition = {
    name: 'AT_EXTREME',
    passed: dir === 'bullish' ? atLowerExtreme : atUpperExtreme,
    detail: `price $${signal.currentPrice.toFixed(2)} vs VWAP $${vwap.vwap.toFixed(2)} ±${vwap.deviation.toFixed(2)}`,
  };

  // 2. REJECTION_SHOWING: velocity reversing OR reversal candle pattern
  const vel = ltf.priceVelocity.directionalVelocity;
  const velocityReversing = dir === 'bullish' ? vel > 0 : vel < 0;
  const patterns = ltf.allCandlePatterns;
  const hasReversalCandle = dir === 'bullish'
    ? (patterns.hammer.present || patterns.bullishEngulfing.present)
    : (patterns.shootingStar.present || patterns.bearishEngulfing.present);
  const rejectionShowing: TriggerCondition = {
    name: 'REJECTION_SHOWING',
    passed: velocityReversing || hasReversalCandle,
    detail: velocityReversing
      ? `velocity ${vel.toFixed(4)} reversing toward ${dir}`
      : hasReversalCandle ? 'reversal candle present' : `no rejection (vel=${vel.toFixed(4)})`,
  };

  // 3. LOW_TREND: HTF ADX < 25
  const htfAdx = htf.dmi.adx;
  const lowTrend: TriggerCondition = {
    name: 'LOW_TREND',
    passed: htfAdx < 25,
    detail: `HTF ADX=${htfAdx.toFixed(1)}`,
  };

  // 4. NEAR_LEVEL: within 0.3% of swing support/resistance
  const swingTarget = dir === 'bullish' ? htf.priceStructure.swingLow : htf.priceStructure.swingHigh;
  const distToLevel = Math.abs(signal.currentPrice - swingTarget) / signal.currentPrice * 100;
  const nearLevel: TriggerCondition = {
    name: 'NEAR_LEVEL',
    passed: distToLevel <= 0.30,
    detail: `${distToLevel.toFixed(3)}% from swing ${dir === 'bullish' ? 'low' : 'high'} $${swingTarget.toFixed(2)}`,
  };

  // 5. RANGE_INTACT: not setting new session extremes in last 2 LTF bars
  const ltfStruct = ltf.priceStructure;
  const rangeIntact: TriggerCondition = {
    name: 'RANGE_INTACT',
    passed: dir === 'bullish'
      ? ltfStruct.swingLowBarsAgo > 2
      : ltfStruct.swingHighBarsAgo > 2,
    detail: dir === 'bullish'
      ? `swing low ${ltfStruct.swingLowBarsAgo} bars ago`
      : `swing high ${ltfStruct.swingHighBarsAgo} bars ago`,
  };

  return buildResult([atExtreme, rejectionShowing, lowTrend, nearLevel, rangeIntact]);
}

// ── BREAKOUT triggers ──────────────────────────────────────────────────────────

export function evaluateBreakoutTriggers(signal: SignalPayload): TriggerResult {
  const [ltf, _mtf, htf] = signal.timeframes;
  const dir = signal.direction;

  // 1. LEVEL_BROKEN: price crossed PDH, PDL, or ORB boundary
  const pdl = signal.priorDayLevels;
  const orb = signal.orb;
  const brokePD = dir === 'bullish' ? pdl.abovePDH : pdl.belowPDL;
  const brokeORB = orb.orbFormed && orb.breakoutDirection === dir;
  const levelBroken: TriggerCondition = {
    name: 'LEVEL_BROKEN',
    passed: brokePD || brokeORB,
    detail: brokePD
      ? `broke ${dir === 'bullish' ? 'PDH' : 'PDL'}`
      : brokeORB ? `broke ORB ${dir}` : 'no level broken',
  };

  // 2. VOLUME_SURGE: recent volume ratio > 1.3x
  const volRatio = ltf.volumeSurge.recentVolumeRatio;
  const volumeSurge: TriggerCondition = {
    name: 'VOLUME_SURGE',
    passed: volRatio > 1.3,
    detail: `vol ratio ${volRatio.toFixed(2)}x`,
  };

  // 3. FRESH: within 0.25% of broken level (not chasing)
  const beyondPct = signal.breakoutBeyond ?? 999;
  const fresh: TriggerCondition = {
    name: 'FRESH',
    passed: beyondPct <= 0.25,
    detail: `${beyondPct.toFixed(3)}% beyond level`,
  };

  // 4. MOMENTUM_RISING: ADX slope > 0 or DI spread widening
  const adxSlope = htf.dmi.adxSlope;
  const diSpreadSlope = htf.dmi.diSpreadSlope;
  const momentumRising: TriggerCondition = {
    name: 'MOMENTUM_RISING',
    passed: adxSlope > 0 || diSpreadSlope > 1,
    detail: `ADX slope=${adxSlope.toFixed(1)}, DI spread slope=${diSpreadSlope.toFixed(1)}`,
  };

  // 5. DIRECTION_ALIGNED: DMI direction matches breakout direction
  const dmiDir = htf.dmi.trend;
  const directionAligned: TriggerCondition = {
    name: 'DIRECTION_ALIGNED',
    passed: dmiDir === dir,
    detail: `HTF DMI=${dmiDir} vs breakout=${dir}`,
  };

  return buildResult([levelBroken, volumeSurge, fresh, momentumRising, directionAligned]);
}

// ── Backward-compatible ConfidenceBreakdown mapping ────────────────────────────

/**
 * Maps trigger results to the existing ConfidenceBreakdown interface.
 * Passed conditions set their mapped field to a positive value.
 * Failed conditions set to 0. The `total` is set directly from trigger confidence.
 */
export function mapToBreakdown(result: TriggerResult): ConfidenceBreakdown {
  // Distribute total evenly across passed conditions for display consistency
  const perCondition = result.passCount > 0 ? result.confidence / result.passCount : 0;

  // Map each condition to a breakdown field based on its name
  const fieldMap: Record<string, keyof ConfidenceBreakdown> = {
    DIRECTION_CONFIRMED: 'diSpreadBonus',
    VWAP_ALIGNED: 'vwapBonus',
    NOT_CHASING: 'moveExhaustionPenalty',
    STRUCTURE_SUPPORT: 'structureBonus',
    VOLUME_CONFIRMS: 'obvBonus',
    AT_EXTREME: 'pricePositionAdjustment',
    REJECTION_SHOWING: 'recentPriceActionBonus',
    LOW_TREND: 'lowVolPenalty',
    NEAR_LEVEL: 'nearLevelPenalty',
    RANGE_INTACT: 'narrowRangePenalty',
    LEVEL_BROKEN: 'orbBonus',
    VOLUME_SURGE: 'volumeSurgeBonus',
    FRESH: 'consolidationPenalty',
    MOMENTUM_RISING: 'trendPhaseBonus',
    DIRECTION_ALIGNED: 'alignmentBonus',
  };

  const breakdown: ConfidenceBreakdown = {
    base: 0,
    diSpreadBonus: 0,
    adxBonus: 0,
    diCrossBonus: 0,
    alignmentBonus: 0,
    tdAdjustment: 0,
    obvBonus: 0,
    vwapBonus: 0,
    oiVolumeBonus: 0,
    pricePositionAdjustment: 0,
    adxMaturityPenalty: 0,
    trendPhaseBonus: 0,
    momentumAccelBonus: 0,
    structureBonus: 0,
    orbBonus: 0,
    recentPriceActionBonus: 0,
    trContractionPenalty: 0,
    lowVolPenalty: 0,
    moveExhaustionPenalty: 0,
    consolidationPenalty: 0,
    nearLevelPenalty: 0,
    thetaDecayPenalty: 0,
    narrowRangePenalty: 0,
    candlePatternBonus: 0,
    priceVelocityBonus: 0,
    volumeSurgeBonus: 0,
    trendPersistenceBonus: 0,
    total: result.confidence,
  };

  for (const cond of result.conditions) {
    const field = fieldMap[cond.name];
    if (field && cond.passed) {
      (breakdown as unknown as Record<string, number>)[field] = perCondition;
    }
  }

  // Make base absorb the total so fields sum correctly for display
  let fieldSum = 0;
  for (const cond of result.conditions) {
    const field = fieldMap[cond.name];
    if (field && cond.passed) {
      fieldSum += perCondition;
    }
  }
  breakdown.base = result.confidence - fieldSum;

  return breakdown;
}
