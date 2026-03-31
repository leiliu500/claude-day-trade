import OpenAI from 'openai';
import { config } from '../config.js';
import { loadSkillTemplate } from '../utils/skill-loader.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult, ConfidenceBreakdown } from '../types/analysis.js';
import { getRecentSignals } from '../db/repositories/signals.js';
import {
  evaluateTrendTriggers,
  evaluateRangeTriggers,
  evaluateBreakoutTriggers,
  mapToBreakdown,
} from './structural-triggers.js';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ── Exported for per-symbol strategy overrides ────────────────────────────────

/** Trend confidence — structural trigger system (5 binary conditions). */
export const computeTrendConfidenceFn = (signal: SignalPayload, _option: OptionEvaluation): ConfidenceBreakdown => {
  return mapToBreakdown(evaluateTrendTriggers(signal));
};
/** Range confidence — structural trigger system (5 binary conditions). */
export const computeRangeConfidenceFn = (signal: SignalPayload): ConfidenceBreakdown => {
  return mapToBreakdown(evaluateRangeTriggers(signal));
};
/** Breakout confidence — structural trigger system (5 binary conditions). */
export const computeBreakoutConfidenceFn = (signal: SignalPayload): ConfidenceBreakdown => {
  return mapToBreakdown(evaluateBreakoutTriggers(signal));
};

/**
 * Internal confidence router — dispatches to mode-specific structural triggers.
 */
function computeConfidence(signal: SignalPayload, _option: OptionEvaluation): ConfidenceBreakdown {
  if (signal.signalMode === 'range' || signal.signalMode === 'vwap_reversion') {
    return mapToBreakdown(evaluateRangeTriggers(signal));
  }
  if (signal.signalMode === 'breakout') {
    return mapToBreakdown(evaluateBreakoutTriggers(signal));
  }
  return mapToBreakdown(evaluateTrendTriggers(signal));
}



/**
 * Determine desired option right from signal direction
 */
function deriveDesiredRight(signal: SignalPayload): 'call' | 'put' | null {
  if (signal.direction === 'bullish') return 'call';
  if (signal.direction === 'bearish') return 'put';
  return null;
}

/**
 * AI entry decision — asks GPT-4o whether to ENTER or WAIT.
 * Called only when structural triggers pass. The AI sees recent price bars,
 * indicators, and trigger conditions, then reasons about whether this specific
 * moment is a genuine continuation or a trap.
 */
export async function aiEntryDecision(
  signal: SignalPayload,
  triggerConditions: Array<{ name: string; passed: boolean; detail: string }>,
): Promise<{ enter: boolean; reasoning: string }> {
  const tfs = signal.timeframes;
  const [ltf, _mtf, htf] = tfs;

  // Build recent price bars for AI to see the pattern
  const recentBars = ltf.bars.slice(-15).map(b => ({
    t: b.timestamp.slice(11, 16),
    o: +b.open.toFixed(2),
    h: +b.high.toFixed(2),
    l: +b.low.toFixed(2),
    c: +b.close.toFixed(2),
    v: b.volume,
  }));

  const payload = {
    ticker: signal.ticker,
    direction: signal.direction,
    signalMode: signal.signalMode,
    currentPrice: signal.currentPrice,
    atr: +signal.atr.toFixed(3),
    vwap: +htf.vwap.vwap.toFixed(2),
    vwapDistPct: +htf.vwap.priceVsVwap.toFixed(3),
    priorDayLevels: {
      pdh: signal.priorDayLevels.pdh,
      pdl: signal.priorDayLevels.pdl,
      pdc: signal.priorDayLevels.pdc,
    },
    orb: signal.orb.orbFormed ? {
      high: signal.orb.orbHigh,
      low: signal.orb.orbLow,
      breakout: signal.orb.breakoutDirection,
    } : null,
    recentBars,
    ltfVelocity: +ltf.priceVelocity.directionalVelocity.toFixed(4),
    ltfAcceleration: +ltf.priceVelocity.acceleration.toFixed(4),
    ltfVolumeRatio: +ltf.volumeSurge.recentVolumeRatio.toFixed(2),
    triggerConditions,
  };

  const system = loadSkillTemplate('entry-decision', {});

  try {
    const msg = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 150,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    const text = msg.choices[0]?.message?.content ?? '{}';
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean) as { decision?: string; reasoning?: string };
    const enter = parsed.decision?.toUpperCase() === 'ENTER';
    return { enter, reasoning: parsed.reasoning ?? 'No reasoning provided' };
  } catch (err) {
    // On AI failure, default to ENTER (triggers already passed)
    console.log(`[AnalysisAgent] AI entry decision failed, defaulting to ENTER: ${err}`);
    return { enter: true, reasoning: 'AI unavailable — defaulting to enter (triggers passed)' };
  }
}

/**
 * Call GPT-4o-mini for a plain-language explanation of the indicators.
 * This is purely explanatory — does NOT change confidence or direction.
 */
async function generateExplanation(
  signal: SignalPayload,
  option: OptionEvaluation,
  cb: ConfidenceBreakdown
): Promise<{ aiExplanation: string; keyFactors: string[]; risks: string[] }> {
  const tfs = signal.timeframes;
  const [ltf, mtf, htf] = tfs;

  const htfPs = htf?.priceStructure;
  const payload = {
    ticker: signal.ticker,
    profile: signal.profile,
    direction: signal.direction,
    alignment: signal.alignment,
    confidence: cb.total.toFixed(2),
    price_position: {
      range_position: htfPs ? parseFloat(htfPs.rangePosition.toFixed(2)) : 0.5,
      price_half: htfPs?.priceHalf ?? 'lower',
      swing_high: htfPs?.swingHigh ?? 0,
      swing_low: htfPs?.swingLow ?? 0,
      price_position_adjustment: cb.pricePositionAdjustment.toFixed(3),
      recent_price_action_bonus: cb.recentPriceActionBonus.toFixed(3),
      tr_contraction_penalty: cb.trContractionPenalty.toFixed(3),
      low_vol_penalty: cb.lowVolPenalty.toFixed(3),
      move_exhaustion_penalty: cb.moveExhaustionPenalty.toFixed(3),
      consolidation_penalty: cb.consolidationPenalty.toFixed(3),
      near_level_penalty: cb.nearLevelPenalty.toFixed(3),
      theta_decay_penalty: cb.thetaDecayPenalty.toFixed(3),
      narrow_range_penalty: cb.narrowRangePenalty.toFixed(3),
      candle_pattern_bonus: cb.candlePatternBonus.toFixed(3),
      price_velocity_bonus: cb.priceVelocityBonus.toFixed(3),
      volume_surge_bonus: cb.volumeSurgeBonus.toFixed(3),
      note: htfPs?.priceHalf === 'lower'
        ? 'Price in lower half of range — puts preferred, calls are higher risk'
        : 'Price in upper half of range — calls preferred, puts are higher risk',
    },
    timeframes: tfs.map(tf => {
      const { vwap: tfVwap, upperBand: tfUpper, lowerBand: tfLower, deviation: tfDev } = tf.vwap;
      const tfPrice = tf.currentPrice;
      const vwapBandPosition =
        tfPrice > tfUpper             ? 'above_2sigma' :
        tfPrice > tfVwap + tfDev      ? 'above_1sigma' :
        tfPrice < tfLower             ? 'below_2sigma' :
        tfPrice < tfVwap - tfDev      ? 'below_1sigma' : 'near_vwap';
      const diCross =
        tf.dmi.growthCrossUp  ? 'bullish_growth' :
        tf.dmi.growthCrossDown ? 'bearish_growth' :
        tf.dmi.crossedUp   ? 'bullish' :
        tf.dmi.crossedDown ? 'bearish' : 'none';
      return {
      tf: tf.timeframe,
      diPlus: tf.dmi.plusDI.toFixed(1),
      diMinus: tf.dmi.minusDI.toFixed(1),
      adx: tf.dmi.adx.toFixed(1),
      adxStrength: tf.dmi.adxStrength,
      trend: tf.dmi.trend,
      adx_slope: parseFloat(tf.dmi.adxSlope.toFixed(1)),
      di_spread_slope: parseFloat(tf.dmi.diSpreadSlope.toFixed(1)),
      di_cross: diCross,
      obv_trend: tf.obv.trend,
      obv_divergence: tf.obv.divergence,
      td_setup: tf.td.setup,
      td_countdown: tf.td.countdown,
      vwap_band_position: vwapBandPosition,
      // Individual pattern flags for explicit formatting rules
      hammer: {
        present: tf.allCandlePatterns.hammer.present,
        type: tf.allCandlePatterns.hammer.present ? 'bullish_hammer' : null,
      },
      shooting_star: {
        present: tf.allCandlePatterns.shootingStar.present,
        type: tf.allCandlePatterns.shootingStar.present ? 'shooting_star' : null,
      },
      bullish_engulfing: {
        present: tf.allCandlePatterns.bullishEngulfing.present,
        type: tf.allCandlePatterns.bullishEngulfing.present ? 'bullish_engulfing' : null,
      },
      bearish_engulfing: {
        present: tf.allCandlePatterns.bearishEngulfing.present,
        type: tf.allCandlePatterns.bearishEngulfing.present ? 'bearish_engulfing' : null,
      },
      price_velocity: {
        roc: parseFloat(tf.priceVelocity.roc.toFixed(3)),
        roc_short: parseFloat(tf.priceVelocity.rocShort.toFixed(3)),
        directional_velocity: parseFloat(tf.priceVelocity.directionalVelocity.toFixed(4)),
        acceleration: parseFloat(tf.priceVelocity.acceleration.toFixed(4)),
      },
      volume_surge: {
        volume_ratio: parseFloat(tf.volumeSurge.volumeRatio.toFixed(2)),
        recent_volume_ratio: parseFloat(tf.volumeSurge.recentVolumeRatio.toFixed(2)),
        volume_trend: tf.volumeSurge.volumeTrend,
      },
      };
    }),
    market_structure: {
      prior_day: signal.priorDayLevels.pdh > 0
        ? {
            pdh: signal.priorDayLevels.pdh,
            pdl: signal.priorDayLevels.pdl,
            pdc: signal.priorDayLevels.pdc,
            above_pdh: signal.priorDayLevels.abovePDH,
            below_pdl: signal.priorDayLevels.belowPDL,
            structure_bias: signal.priorDayLevels.structureBias,
            structure_bonus: cb.structureBonus.toFixed(3),
          }
        : null,
      orb: signal.orb.orbFormed
        ? {
            orb_high: signal.orb.orbHigh,
            orb_low: signal.orb.orbLow,
            range_size_pct: signal.orb.rangeSizePct.toFixed(3),
            breakout_direction: signal.orb.breakoutDirection,
            breakout_strength: signal.orb.breakoutStrength.toFixed(2),
            orb_bonus: cb.orbBonus.toFixed(3),
          }
        : { orb_formed: false },
    },
    option: option.winnerCandidate
      ? {
          side: option.winnerCandidate.contract.side,
          symbol: option.winnerCandidate.contract.symbol,
          strike: option.winnerCandidate.contract.strike,
          delta: option.winnerCandidate.contract.delta,
          spread_pct: option.winnerCandidate.contract.spreadPct?.toFixed(2),
          entry: option.winnerCandidate.entryPremium,
          stop: option.winnerCandidate.stopPremium,
          tp: option.winnerCandidate.tpPremium,
          rr: option.winnerCandidate.rrRatio?.toFixed(2),
          volume: option.winnerCandidate.contract.volume,
          open_interest: option.winnerCandidate.contract.openInterest,
          vol_to_oi: option.winnerCandidate.contract.openInterest > 0
            ? (option.winnerCandidate.contract.volume / option.winnerCandidate.contract.openInterest).toFixed(2)
            : null,
          oi_volume_bonus: cb.oiVolumeBonus,
        }
      : null,
  };

  // Label timeframes for the prompt (LTF=first, MTF=second, HTF=third)
  const ltfLabel = ltf?.timeframe ?? 'LTF';
  const mtfLabel = mtf?.timeframe ?? 'MTF';
  const htfLabel = htf?.timeframe ?? 'HTF';

  const system = loadSkillTemplate('analysis-agent', {
    HTF_LABEL: htfLabel,
    MTF_LABEL: mtfLabel,
    LTF_LABEL: ltfLabel,
  });

  try {
    const msg = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 512,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    const text = msg.choices[0]?.message?.content ?? '{}';
    // Strip markdown code fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean) as { explanation?: string; keyFactors?: string[]; risks?: string[] };
    return {
      aiExplanation: parsed.explanation ?? 'No explanation available.',
      keyFactors: parsed.keyFactors ?? [],
      risks: parsed.risks ?? [],
    };
  } catch {
    return {
      aiExplanation: 'Explanation unavailable (AI error).',
      keyFactors: [`Direction: ${signal.direction}`, `Alignment: ${signal.alignment}`, `Confidence: ${cb.total.toFixed(2)}`],
      risks: ['Unable to generate risk assessment'],
    };
  }
}

export class AnalysisAgent {
  async run(signal: SignalPayload, option: OptionEvaluation, timeGateOk = true, tickerCfg?: import('../ticker-configs.js').TickerConfig): Promise<AnalysisResult> {
    // ── Compute structural trigger result for selected mode ──
    const triggerResult = signal.signalMode === 'range' || signal.signalMode === 'vwap_reversion'
      ? evaluateRangeTriggers(signal)
      : signal.signalMode === 'breakout'
        ? evaluateBreakoutTriggers(signal)
        : evaluateTrendTriggers(signal);

    let cb = mapToBreakdown(triggerResult);

    // ── Compute all 4 mode confidences for dashboard transparency ──
    const allModeConfidences = {
      trend: signal.signalMode === 'trend' ? cb.total : mapToBreakdown(evaluateTrendTriggers(signal)).total,
      range: (signal.signalMode === 'range' || signal.signalMode === 'vwap_reversion') ? cb.total : mapToBreakdown(evaluateRangeTriggers(signal)).total,
      breakout: signal.signalMode === 'breakout' ? cb.total : mapToBreakdown(evaluateBreakoutTriggers(signal)).total,
      vwap_reversion: signal.signalMode === 'vwap_reversion' ? cb.total : mapToBreakdown(evaluateRangeTriggers(signal)).total,
    };

    // ── Build per-symbol entry context ──
    let displacementVelocity: number | undefined;
    let rangeExhaustion: number | undefined;
    let choppiness: number | undefined;
    {
      const ltfBars = signal.timeframes[0]?.bars;
      const htfAtr = (signal.timeframes[2] ?? signal.timeframes[0])?.atr.atr ?? 0;
      if (ltfBars && ltfBars.length >= 10) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayBars = ltfBars.filter(b => b.timestamp.startsWith(todayStr));

        if (todayBars.length >= 10) {
          const dayOpen = todayBars[0]!.open;
          if (dayOpen > 0) {
            const recent5 = todayBars.slice(-5);
            const prior5 = todayBars.slice(-10, -5);
            const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
            const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
            displacementVelocity = avgRecent - avgPrior;
          }
        }

        if (htfAtr > 0 && todayBars.length >= 20) {
          let dayHigh = -Infinity, dayLow = Infinity;
          for (const b of todayBars) { if (b.high > dayHigh) dayHigh = b.high; if (b.low < dayLow) dayLow = b.low; }
          rangeExhaustion = (dayHigh - dayLow) / htfAtr;
        }

        if (todayBars.length >= 15) {
          const recent = todayBars.slice(-30);
          let flips = 0;
          let prevDir: string | null = null;
          for (const bar of recent) {
            const dir = bar.close >= bar.open ? 'up' : 'down';
            if (prevDir && dir !== prevDir) flips++;
            prevDir = dir;
          }
          choppiness = flips / Math.max(1, recent.length / 4);
        }
      }
    }

    const entryCtx = {
      signalMode: signal.signalMode ?? 'none',
      direction: signal.direction,
      alignment: signal.alignment,
      confidence: cb.total,
      breakdown: cb,
      strengthScore: signal.strengthScore,
      currentPrice: signal.currentPrice,
      atr: signal.atr,
      displacementVelocity,
      rangeExhaustion,
      choppiness,
    };

    // Per-symbol confidence adjustment hook (kept for compatibility)
    if (tickerCfg?.strategy?.adjustConfidence) {
      cb = tickerCfg.strategy.adjustConfidence(cb, entryCtx);
      entryCtx.confidence = cb.total;
      entryCtx.breakdown = cb;
    }

    // ── Trend persistence: bump confidence when consecutive aligned signals confirm ──
    const persistenceMode = signal.signalMode ?? 'none';
    if (signal.direction !== 'neutral' && (persistenceMode === 'trend' || persistenceMode === 'breakout') && triggerResult.allPassed) {
      try {
        const recentSignals = await getRecentSignals(signal.ticker, 10);
        let consecutiveCount = 0;
        for (const s of recentSignals) {
          if (s.direction === signal.direction &&
              (s.alignment === 'all_aligned' || s.alignment === 'htf_mtf_aligned')) {
            consecutiveCount++;
          } else {
            break;
          }
        }
        if (consecutiveCount >= 2) {
          const persistenceBonus = Math.min(0.10, (consecutiveCount - 1) * 0.025);
          cb = { ...cb, trendPersistenceBonus: persistenceBonus, total: Math.min(1, cb.total + persistenceBonus) };
          entryCtx.confidence = cb.total;
          entryCtx.breakdown = cb;
          console.log(`[AnalysisAgent] ${signal.ticker} trend persistence: ${consecutiveCount} consecutive ${signal.direction} aligned signals → +${(persistenceBonus * 100).toFixed(0)}%`);
        }
      } catch {
        // DB query failure — proceed without persistence bonus
      }
    }

    // ── Entry threshold: ALL triggers must pass ──
    // N-1 (allow 1 failure) was tried but produced net-negative entries:
    // 2026-03-31 data: 5/6-trigger entries (conf 0.55) were the worst cluster
    // (4 trades, all losses, -$221). All 3 winning trades had all triggers passing.
    // The AI entry agent provides the flexibility layer — triggers must be strict.
    const maxFailures = 0;
    const triggerFailCount = triggerResult.totalCount - triggerResult.passCount;
    let meetsEntryThreshold = triggerFailCount <= maxFailures;
    let entryBlockReason: string | undefined;
    let aiDecisionReasoning: string | undefined;

    if (!meetsEntryThreshold) {
      const failed = triggerResult.conditions.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`);
      entryBlockReason = `${triggerResult.passCount}/${triggerResult.totalCount} triggers (failed: ${failed.join('; ')})`;
    }

    // When triggers meet threshold and market is open, ask AI for ENTER/WAIT decision
    if (meetsEntryThreshold && timeGateOk) {
      const aiDecision = await aiEntryDecision(
        signal,
        triggerResult.conditions.map(c => ({ name: c.name, passed: c.passed, detail: c.detail })),
      );
      aiDecisionReasoning = aiDecision.reasoning;
      if (!aiDecision.enter) {
        meetsEntryThreshold = false;
        entryBlockReason = `AI WAIT: ${aiDecision.reasoning}`;
        console.log(`[AnalysisAgent] ${signal.ticker} AI blocked entry: ${aiDecision.reasoning}`);
      } else {
        console.log(`[AnalysisAgent] ${signal.ticker} AI confirmed entry: ${aiDecision.reasoning}`);
      }
    }

    // Per-symbol entry time window — block entries outside configured window
    if (meetsEntryThreshold && tickerCfg) {
      const now = new Date();
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour')!.value, 10);
      const etMin = parseInt(etParts.find(p => p.type === 'minute')!.value, 10);
      const minsSinceOpen = (etHour * 60 + etMin) - (9 * 60 + 30);
      if (minsSinceOpen < tickerCfg.entryWindowStartMin || minsSinceOpen > tickerCfg.entryWindowEndMin) {
        entryBlockReason = `entry window blocked: ${etHour}:${String(etMin).padStart(2, '0')} ET (${minsSinceOpen}m since open) outside [${tickerCfg.entryWindowStartMin}-${tickerCfg.entryWindowEndMin}]`;
        console.log(`[AnalysisAgent] ${signal.ticker} ${entryBlockReason}`);
        meetsEntryThreshold = false;
      }
    }

    // Per-symbol entry filter hook
    if (meetsEntryThreshold && tickerCfg?.strategy?.shouldAllowEntry) {
      const filterResult = tickerCfg.strategy.shouldAllowEntry(entryCtx);
      if (filterResult !== true) {
        entryBlockReason = filterResult;
        console.log(`[AnalysisAgent] ${signal.ticker} entry filter blocked: ${filterResult}`);
        meetsEntryThreshold = false;
      }
    }
    const desiredRight = deriveDesiredRight(signal);

    let aiExplanation = aiDecisionReasoning ?? 'Market closed or triggers not met — AI explanation skipped.';
    let keyFactors: string[] = [];
    let risks: string[] = [];

    if (meetsEntryThreshold && timeGateOk) {
      const ai = await generateExplanation(signal, option, cb);
      aiExplanation = ai.aiExplanation;
      keyFactors = ai.keyFactors;
      risks = ai.risks;
    }

    return {
      signalId: signal.id,
      confidence: cb.total,
      confidenceBreakdown: cb,
      allModeConfidences,
      selectedMode: signal.signalMode ?? 'none',
      meetsEntryThreshold,
      entryBlockReason,
      aiExplanation,
      keyFactors,
      risks,
      desiredRight,
      rangeExhaustion,
      triggerConditions: triggerResult.conditions.map(c => ({ name: c.name, passed: c.passed, detail: c.detail })),
      createdAt: new Date().toISOString(),
    };
  }
}
