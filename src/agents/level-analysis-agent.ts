/**
 * Level Analysis Agent — replaces the 27-factor DMI confidence model
 * with a 10-factor level-based scoring system.
 *
 * Core question changes from "how confident in direction?" to
 * "is this a high-quality level interaction with structure + context support?"
 *
 * Outputs AnalysisResult for pipeline compatibility.
 */

import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult, ConfidenceBreakdown } from '../types/analysis.js';
import type { LevelSignalData, LevelConfidenceBreakdown, LevelSetup } from '../types/levels.js';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Level Confidence Computation ─────────────────────────────────────────────

/**
 * Compute level-based confidence from a setup.
 *
 * Returns 0 if there is no setup (no trade signal).
 */
export function computeLevelConfidence(
  signal: SignalPayload & { levelData: LevelSignalData },
): LevelConfidenceBreakdown {
  const { levelData } = signal;
  const { setup, structure, context, activeInteraction } = levelData;

  const empty: LevelConfidenceBreakdown = {
    base: 0.40, levelStrength: 0, interactionQuality: 0,
    structureAlignment: 0, contextAlignment: 0, volumeConfirmation: 0,
    vwapAlignment: 0, riskRewardScore: 0, failedBreakoutBonus: 0,
    thetaDecayPenalty: 0, total: 0,
  };

  if (!setup) return empty;

  const base = 0.40;

  // 1. Level Strength (0..+0.15): higher confluence = stronger level
  let levelStrength = clamp(setup.level.strength * 0.04, 0, 0.15);

  // GEX levels carry extra institutional weight
  if (setup.level.type === 'gex_call_wall' || setup.level.type === 'gex_put_wall') {
    levelStrength = clamp(levelStrength + 0.04, 0, 0.15);
  }

  // Fresh (untested) levels get extra weight — first touch is strongest
  const freshnessBonus = setup.level.freshness === 'fresh' ? 0.03 :
                         setup.level.touchCount <= 1 ? 0.01 : 0;

  // 2. Interaction Quality (-0.10..+0.15): how clean is the rejection/acceptance
  let interactionQuality = 0;
  if (activeInteraction) {
    // Candle signal at level
    switch (activeInteraction.candleSignal) {
      case 'rejection_wick': interactionQuality += 0.08; break;
      case 'engulfing': interactionQuality += 0.06; break;
      case 'doji': interactionQuality += 0.02; break;
      case 'strong_body': interactionQuality += 0.04; break;
    }

    // Volume at level
    if (activeInteraction.volumeAtLevel === 'expanding') interactionQuality += 0.05;
    else if (activeInteraction.volumeAtLevel === 'contracting') interactionQuality -= 0.05;

    // Too many bars at level = indecision, not clean
    if (activeInteraction.barsAtLevel > 5) interactionQuality -= 0.05;
  }
  interactionQuality = clamp(interactionQuality, -0.10, 0.15);

  // 3. Structure Alignment (-0.10..+0.12): does HH/HL or LH/LL support the trade?
  let structureAlignment = 0;
  if (setup.direction === 'bullish') {
    if (structure.state === 'uptrend') structureAlignment = 0.12;
    else if (structure.state === 'range') structureAlignment = 0.04;
    else if (structure.state === 'downtrend') structureAlignment = -0.08;
    // Failed breakout below + reclaim = very bullish structure
    if (structure.failedBreakout?.direction === 'bearish_fail') structureAlignment = 0.12;
  } else {
    if (structure.state === 'downtrend') structureAlignment = 0.12;
    else if (structure.state === 'range') structureAlignment = 0.04;
    else if (structure.state === 'uptrend') structureAlignment = -0.08;
    if (structure.failedBreakout?.direction === 'bullish_fail') structureAlignment = 0.12;
  }

  // Volume confirming structure
  if (structure.volumeProfile === 'expanding_with_trend') structureAlignment += 0.02;
  else if (structure.volumeProfile === 'expanding_against') structureAlignment -= 0.04;
  structureAlignment = clamp(structureAlignment, -0.10, 0.12);

  // 4. Context Alignment (-0.08..+0.10): does the day type support this setup?
  let contextAlignment = 0;
  switch (context.dayType) {
    case 'trend_up':
      contextAlignment = setup.direction === 'bullish' ? 0.10 : -0.08;
      break;
    case 'trend_down':
      contextAlignment = setup.direction === 'bearish' ? 0.10 : -0.08;
      break;
    case 'rotational':
      // Range trades are great on rotational days
      if (setup.type === 'level_rejection' || setup.type === 'vwap_mean_reversion') {
        contextAlignment = 0.06;
      }
      break;
    case 'reversal':
      // Be cautious on reversal days — counter-gap trades work, trend continuation doesn't
      if (setup.type === 'failed_breakout') contextAlignment = 0.06;
      break;
    case 'undetermined':
      // First 30 min — no bonus/penalty, rely on level + structure alone
      break;
  }

  // Breadth alignment: broad participation strengthens signal
  if (context.breadth) {
    if (context.breadth.sectorAlignment > 0.5) contextAlignment += 0.03;
    else if (context.breadth.sectorAlignment < -0.2) contextAlignment -= 0.03;
    // Delta trend: increasing buying pressure confirms bullish, selling confirms bearish
    if (setup.direction === 'bullish' && context.breadth.deltaTrend === 'increasing') contextAlignment += 0.02;
    else if (setup.direction === 'bearish' && context.breadth.deltaTrend === 'decreasing') contextAlignment += 0.02;
  }

  // GEX regime: pinning favors range trades, accelerating favors breakouts
  if (context.gex) {
    if (context.gex.regime === 'pinning' && (setup.type === 'level_rejection' || setup.type === 'vwap_mean_reversion')) {
      contextAlignment += 0.03;
    } else if (context.gex.regime === 'accelerating' && setup.type === 'breakout_acceptance') {
      contextAlignment += 0.03;
    } else if (context.gex.regime === 'pinning' && setup.type === 'breakout_acceptance') {
      contextAlignment -= 0.03; // breakouts fail in pinning regimes
    }
  }

  contextAlignment = clamp(contextAlignment, -0.08, 0.10);

  // 5. Volume Confirmation (-0.06..+0.08): is volume supporting at the level?
  let volumeConfirmation = 0;
  if (activeInteraction?.volumeAtLevel === 'expanding') volumeConfirmation = 0.08;
  else if (activeInteraction?.volumeAtLevel === 'contracting') volumeConfirmation = -0.06;
  volumeConfirmation = clamp(volumeConfirmation, -0.06, 0.08);

  // 6. VWAP Alignment (-0.06..+0.06): is price on the right side of VWAP?
  let vwapAlignment = 0;
  const vwapDist = signal.timeframes[0]?.vwap.priceVsVwap ?? 0;
  if (setup.direction === 'bullish' && vwapDist > 0) vwapAlignment = 0.04;
  else if (setup.direction === 'bullish' && vwapDist < -0.3) vwapAlignment = -0.04;
  else if (setup.direction === 'bearish' && vwapDist < 0) vwapAlignment = 0.04;
  else if (setup.direction === 'bearish' && vwapDist > 0.3) vwapAlignment = -0.04;
  // VWAP mean reversion: being extended IS the setup
  if (setup.type === 'vwap_mean_reversion') {
    vwapAlignment = Math.abs(vwapDist) > 0.3 ? 0.06 : 0.02;
  }
  vwapAlignment = clamp(vwapAlignment, -0.06, 0.06);

  // 7. Risk:Reward (-0.08..+0.08): is the next level far enough?
  let riskRewardScore = 0;
  if (setup.riskReward >= 3.0) riskRewardScore = 0.08;
  else if (setup.riskReward >= 2.0) riskRewardScore = 0.05;
  else if (setup.riskReward >= 1.5) riskRewardScore = 0.02;
  else if (setup.riskReward >= 1.0) riskRewardScore = 0;
  else riskRewardScore = -0.08; // R:R < 1 is not worth the trade
  riskRewardScore = clamp(riskRewardScore, -0.08, 0.08);

  // 8. Failed Breakout Bonus (0..+0.10): highest probability setup
  let failedBreakoutBonus = 0;
  if (setup.type === 'failed_breakout') {
    failedBreakoutBonus = 0.10;
  }

  // 9. Theta Decay Penalty (-0.10..0): late in the day, theta burns
  let thetaDecayPenalty = 0;
  if (context.minutesSinceOpen > 300) {
    // After 2:30 PM ET — theta penalty escalates
    thetaDecayPenalty = -0.03 * ((context.minutesSinceOpen - 300) / 60);
    thetaDecayPenalty = clamp(thetaDecayPenalty, -0.10, 0);
  }

  const total = clamp(
    base + levelStrength + freshnessBonus + interactionQuality +
    structureAlignment + contextAlignment + volumeConfirmation +
    vwapAlignment + riskRewardScore + failedBreakoutBonus + thetaDecayPenalty,
    0, 1,
  );

  return {
    base,
    levelStrength: levelStrength + freshnessBonus,
    interactionQuality,
    structureAlignment,
    contextAlignment,
    volumeConfirmation,
    vwapAlignment,
    riskRewardScore,
    failedBreakoutBonus,
    thetaDecayPenalty,
    total,
  };
}

// ── Map to AnalysisResult ────────────────────────────────────────────────────

/**
 * Map LevelConfidenceBreakdown to the existing ConfidenceBreakdown format.
 * Zero out DMI-specific fields; populate level-relevant ones.
 */
function mapToConfidenceBreakdown(lcb: LevelConfidenceBreakdown): ConfidenceBreakdown {
  return {
    base: lcb.base,
    diSpreadBonus: 0,           // not used in level system
    adxBonus: 0,
    diCrossBonus: 0,
    alignmentBonus: lcb.structureAlignment,      // repurposed
    tdAdjustment: 0,
    obvBonus: lcb.volumeConfirmation,            // repurposed
    vwapBonus: lcb.vwapAlignment,
    oiVolumeBonus: 0,
    pricePositionAdjustment: 0,
    adxMaturityPenalty: 0,
    trendPhaseBonus: lcb.contextAlignment,       // repurposed
    momentumAccelBonus: 0,
    structureBonus: lcb.levelStrength,           // repurposed
    orbBonus: lcb.failedBreakoutBonus,           // repurposed
    recentPriceActionBonus: lcb.interactionQuality, // repurposed
    trContractionPenalty: 0,
    lowVolPenalty: 0,
    moveExhaustionPenalty: 0,
    consolidationPenalty: 0,
    nearLevelPenalty: 0,
    thetaDecayPenalty: lcb.thetaDecayPenalty,
    narrowRangePenalty: 0,
    candlePatternBonus: 0,
    priceVelocityBonus: lcb.riskRewardScore,     // repurposed
    volumeSurgeBonus: 0,
    trendPersistenceBonus: 0,
    total: lcb.total,
  };
}

// ── Level Analysis Agent ─────────────────────────────────────────────────────

export class LevelAnalysisAgent {
  async run(
    signal: SignalPayload & { levelData: LevelSignalData },
    option: OptionEvaluation,
    timeGateOk = true,
    tickerCfg?: import('../ticker-configs.js').TickerConfig,
  ): Promise<AnalysisResult> {
    const lcb = computeLevelConfidence(signal);
    const cb = mapToConfidenceBreakdown(lcb);
    const setup = signal.levelData.setup;

    const confidence = lcb.total;
    const threshold = tickerCfg?.minConfidence ?? 0.65;
    const meetsThreshold = confidence >= threshold && setup !== null;

    // Build explanation from the level data
    const keyFactors: string[] = [];
    const risks: string[] = [];

    if (setup) {
      keyFactors.push(`${setup.type} at ${setup.level.label} ($${setup.level.price.toFixed(2)})`);
      keyFactors.push(`Structure: ${signal.levelData.structure.state}`);
      keyFactors.push(`Day type: ${signal.levelData.context.dayType}`);
      keyFactors.push(`R:R = ${setup.riskReward.toFixed(1)} (target: $${setup.targetPrice.toFixed(2)}, stop: $${setup.stopPrice.toFixed(2)})`);

      if (signal.levelData.context.gex) {
        keyFactors.push(`GEX regime: ${signal.levelData.context.gex.regime} (call wall $${signal.levelData.context.gex.callWallStrike}, put wall $${signal.levelData.context.gex.putWallStrike})`);
      }
      if (signal.levelData.context.breadth) {
        keyFactors.push(`Breadth: ${(signal.levelData.context.breadth.sectorAlignment * 100).toFixed(0)}% aligned, delta ${signal.levelData.context.breadth.deltaTrend}`);
      }

      if (lcb.structureAlignment < 0) risks.push('Structure opposes trade direction');
      if (lcb.contextAlignment < 0) risks.push('Day type opposes this setup');
      if (lcb.riskRewardScore < 0) risks.push('Poor risk:reward ratio');
      if (lcb.thetaDecayPenalty < -0.03) risks.push('Late-day theta decay');
      if (signal.levelData.context.volatilityRegime === 'extreme') risks.push('Extreme volatility regime');
      if (signal.levelData.context.gex?.regime === 'accelerating') risks.push('Negative GEX — price may accelerate through levels');
      if (signal.levelData.context.breadth?.sectorAlignment !== undefined && signal.levelData.context.breadth.sectorAlignment < -0.2) risks.push('Sectors diverging — narrow participation');
    } else {
      keyFactors.push('No level interaction — no setup');
      risks.push('No defined entry, stop, or target');
    }

    const aiExplanation = setup
      ? `Level-based setup: ${setup.type} at ${setup.level.label}. ` +
        `${setup.direction} with R:R ${setup.riskReward.toFixed(1)}. ` +
        `Structure=${signal.levelData.structure.state}, ` +
        `DayType=${signal.levelData.context.dayType}. ` +
        `Conf=${(confidence * 100).toFixed(0)}%.`
      : 'No active level interaction. Waiting for price to reach a key level.';

    const desiredRight: 'call' | 'put' | null = setup
      ? (setup.direction === 'bullish' ? 'call' : 'put')
      : null;

    return {
      signalId: signal.id,
      confidence,
      confidenceBreakdown: cb,
      allModeConfidences: {
        trend: signal.levelData.structure.state === 'uptrend' || signal.levelData.structure.state === 'downtrend' ? confidence : 0,
        range: setup?.type === 'level_rejection' ? confidence : 0,
        breakout: setup?.type === 'breakout_acceptance' ? confidence : 0,
        vwap_reversion: setup?.type === 'vwap_mean_reversion' ? confidence : 0,
      },
      selectedMode: setup?.type ?? 'none',
      meetsEntryThreshold: meetsThreshold,
      entryBlockReason: !meetsThreshold
        ? (setup ? `Confidence ${(confidence * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%` : 'No setup')
        : undefined,
      aiExplanation,
      keyFactors,
      risks,
      desiredRight,
      createdAt: new Date().toISOString(),
    };
  }
}
