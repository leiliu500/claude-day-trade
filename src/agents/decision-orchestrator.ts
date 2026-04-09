import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { loadSkill } from '../utils/skill-loader.js';
import { checkFomcWindow } from '../lib/fomc-calendar.js';
import { evaluateEntryGate, type GateInput } from '../lib/entry-gate.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { PositionContext, DecisionResult, DecisionType } from '../types/decision.js';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const ORCHESTRATOR_SYSTEM = loadSkill('decision-orchestrator');

interface OrchestratorInput {
  signal: SignalPayload;
  option: OptionEvaluation;
  analysis: AnalysisResult;
  context: PositionContext;
  timeGateOk: boolean;
}

interface EntryStrategyRaw {
  stage: string;
  confirmation_count: number;
  signal_direction: string | null;
  confirmations_needed: number;
  override_triggered: boolean;
  notes: string;
}

interface OrchestratorRawOutput {
  decision_type: DecisionType;
  confirmation_count: number;
  reasoning: string;
  urgency: 'immediate' | 'standard' | 'low';
  should_execute: boolean;
  entry_strategy?: EntryStrategyRaw;
  risk_notes?: string;
  streak_context?: string;
}

/** Minutes since 9:30 AM ET market open (DST-aware). Returns negative before open. */
function minutesSinceMarketOpen(now = new Date()): number {
  const year = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 1));
  dstStart.setUTCDate(1 + ((7 - dstStart.getUTCDay()) % 7) + 7); // 2nd Sunday March
  const dstEnd = new Date(Date.UTC(year, 10, 1));
  dstEnd.setUTCDate(1 + ((7 - dstEnd.getUTCDay()) % 7)); // 1st Sunday November
  const isDst = now >= dstStart && now < dstEnd;
  const etOffsetMin = isDst ? -4 * 60 : -5 * 60;
  const etMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + etOffsetMin + 24 * 60) % (24 * 60);
  return etMinutes - (9 * 60 + 30); // minutes since 9:30 AM ET
}

/** Compute whether the current time is in the EOD liquidation window (last 5 min before 4pm ET) */
function computeEodWindow(): { isEodWindow: boolean; minutesToClose: number } {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return { isEodWindow: false, minutesToClose: 999 };

  // Approximate DST: 2nd Sunday March → 1st Sunday November (US Eastern)
  const year = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 1));
  dstStart.setUTCDate(1 + ((7 - dstStart.getUTCDay()) % 7) + 7); // 2nd Sunday March
  const dstEnd = new Date(Date.UTC(year, 10, 1));
  dstEnd.setUTCDate(1 + ((7 - dstEnd.getUTCDay()) % 7)); // 1st Sunday November
  const isDst = now >= dstStart && now < dstEnd;

  const etOffsetMin = isDst ? -4 * 60 : -5 * 60;
  const etMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + etOffsetMin + 24 * 60) % (24 * 60);
  const marketCloseMin = 16 * 60; // 4:00 PM ET
  const minutesToClose = marketCloseMin - etMinutes;

  return {
    isEodWindow: minutesToClose >= 0 && minutesToClose <= 5,
    minutesToClose: Math.max(0, minutesToClose),
  };
}

/**
 * Server-side confirmation counter — returns the prior count of consecutive same-direction
 * observations from recentDecisions (newest-first).
 * The current cycle is NOT included (caller adds +1 if appropriate).
 *
 * Design: any decision (including WAIT) with a stored confirmationCount > 0 and matching
 * direction carries the accumulated streak forward.  Only a direction flip, a hard reset
 * (WAIT with count=0), or running out of history returns 0.
 *
 * Historical data that pre-dates this fix has count=0 for WAITs and degrades gracefully:
 * those WAITs will break the loop as if they were fresh OBSERVE cycles.
 */
function computeServerConfirmationCount(
  recentDecisions: PositionContext['recentDecisions'],
  direction: string,
): number {
  for (const d of recentDecisions) {
    if (d.direction !== direction) break; // direction flip — streak resets
    // Exit/reduce/reverse break the streak: position was closed or cut due to risk.
    // After these, re-entry must rebuild conviction from scratch (priorCount=0).
    // REVERSE already resets via direction flip on the next cycle; EXIT/REDUCE do not.
    if (d.decisionType === 'EXIT' || d.decisionType === 'REDUCE_EXPOSURE') break;
    // NEW_ENTRY / ADD_POSITION means an order was placed — the confirmation cycle is
    // complete and the next cycle must start fresh at 0.
    if (d.decisionType === 'NEW_ENTRY' || d.decisionType === 'ADD_POSITION') break;
    // Any remaining decision with a positive count is authoritative: return it as the prior count.
    // This covers CONFIRM_HOLD and correctly-stored intermediate WAITs.
    if (d.confirmationCount > 0) return d.confirmationCount;
    // confirmationCount === 0: pure OBSERVE stage or legacy pre-fix data — prior count is 0.
    break;
  }
  return 0;
}

export class DecisionOrchestrator {
  async run(input: OrchestratorInput, tickerCfg?: import('../ticker-configs.js').TickerConfig): Promise<DecisionResult> {
    const { signal, option, analysis, context, timeGateOk } = input;
    const minConfidence = tickerCfg?.minConfidence ?? config.MIN_CONFIDENCE;
    const { isEodWindow, minutesToClose } = computeEodWindow();
    const { isFomcWindow, minutesToEvent: fomcMinutesToEvent, eventDescription: fomcEventDescription } = checkFomcWindow(30);

    // Build the user message with full context
    const userMessage = JSON.stringify({
      // Signal summary
      ticker: signal.ticker,
      profile: signal.profile,
      direction: signal.direction,
      alignment: signal.alignment,
      signal_mode: signal.signalMode ?? 'trend',
      ...(signal.signalMode === 'range' ? {
        range_support: signal.rangeSupport,
        range_resistance: signal.rangeResistance,
      } : {}),
      ...(signal.signalMode === 'breakout' ? {
        breakout_level: signal.breakoutLevel,
        breakout_beyond: signal.breakoutBeyond,
      } : {}),
      triggered_by: signal.triggeredBy,

      // Analysis
      confidence: analysis.confidence,
      confidence_breakdown: {
        di_cross_bonus: analysis.confidenceBreakdown.diCrossBonus,
        vwap_bonus: analysis.confidenceBreakdown.vwapBonus,
        trend_phase_bonus: analysis.confidenceBreakdown.trendPhaseBonus,
        momentum_accel_bonus: analysis.confidenceBreakdown.momentumAccelBonus,
        price_position_adjustment: analysis.confidenceBreakdown.pricePositionAdjustment,
        recent_price_action_bonus: analysis.confidenceBreakdown.recentPriceActionBonus,
        tr_contraction_penalty: analysis.confidenceBreakdown.trContractionPenalty,
        low_vol_penalty: analysis.confidenceBreakdown.lowVolPenalty,
        move_exhaustion_penalty: analysis.confidenceBreakdown.moveExhaustionPenalty,
        consolidation_penalty: analysis.confidenceBreakdown.consolidationPenalty,
        near_level_penalty: analysis.confidenceBreakdown.nearLevelPenalty,
        theta_decay_penalty: analysis.confidenceBreakdown.thetaDecayPenalty,
        narrow_range_penalty: analysis.confidenceBreakdown.narrowRangePenalty,
        candle_pattern_bonus: analysis.confidenceBreakdown.candlePatternBonus,
        price_velocity_bonus: analysis.confidenceBreakdown.priceVelocityBonus,
        volume_surge_bonus: analysis.confidenceBreakdown.volumeSurgeBonus,
        price_half: signal.timeframes[2]?.priceStructure.priceHalf ?? signal.timeframes[0]?.priceStructure.priceHalf ?? 'lower',
        range_position: parseFloat((signal.timeframes[2]?.priceStructure.rangePosition ?? signal.timeframes[0]?.priceStructure.rangePosition ?? 0.5).toFixed(2)),
        note: (signal.timeframes[2]?.priceStructure.priceHalf ?? signal.timeframes[0]?.priceStructure.priceHalf) === 'lower'
          ? 'Lower half: puts preferred, calls are higher risk'
          : 'Upper half: calls preferred, puts are higher risk',
      },
      meets_entry_threshold: analysis.meetsEntryThreshold,
      desired_right: analysis.desiredRight,
      key_factors: analysis.keyFactors,
      risks: analysis.risks,

      // Option evaluation
      time_gate_ok: timeGateOk,
      is_eod_window: isEodWindow,
      minutes_to_close: minutesToClose,
      is_fomc_window: isFomcWindow,
      fomc_minutes_to_event: isFomcWindow ? fomcMinutesToEvent : null,
      fomc_event_description: isFomcWindow ? fomcEventDescription : null,
      liquidity_ok: option.liquidityOk,
      candidate_pass: option.candidatePass,
      winner_side: option.winner,
      winner_symbol: option.winnerCandidate?.contract.symbol,
      winner_rr: option.winnerCandidate?.rrRatio,
      winner_spread_pct: option.winnerCandidate?.contract.spreadPct,
      winner_entry: option.winnerCandidate?.entryPremium,
      winner_stop: option.winnerCandidate?.stopPremium,
      winner_tp: option.winnerCandidate?.tpPremium,
      winner_volume: option.winnerCandidate?.contract.volume,
      winner_open_interest: option.winnerCandidate?.contract.openInterest,
      winner_vol_to_oi: (option.winnerCandidate && option.winnerCandidate.contract.openInterest > 0)
        ? parseFloat((option.winnerCandidate.contract.volume / option.winnerCandidate.contract.openInterest).toFixed(2))
        : null,

      // TF indicators summary
      timeframes: signal.timeframes.map(tf => {
        const { vwap: tfVwap, upperBand: tfUpper, lowerBand: tfLower, deviation: tfDev } = tf.vwap;
        const tfPrice = tf.currentPrice;
        const vwapBandPosition =
          tfPrice > tfUpper          ? 'above_2sigma' :
          tfPrice > tfVwap + tfDev   ? 'above_1sigma' :
          tfPrice < tfLower          ? 'below_2sigma' :
          tfPrice < tfVwap - tfDev   ? 'below_1sigma' : 'near_vwap';
        const diCross =
          tf.dmi.crossedUp   ? 'bullish' :
          tf.dmi.crossedDown ? 'bearish' : 'none';
        return {
          tf: tf.timeframe,
          trend: tf.dmi.trend,
          adx: tf.dmi.adx.toFixed(1),
          adx_strength: tf.dmi.adxStrength,
          di_plus: tf.dmi.plusDI.toFixed(1),
          di_minus: tf.dmi.minusDI.toFixed(1),
          di_cross: diCross,
          td_setup: tf.td.setup,
          td_countdown: tf.td.countdown,
          obv_trend: tf.obv.trend,
          obv_divergence: tf.obv.divergence,
          candle: tf.candlePattern,
          atr_pct: tf.atr.atrPct.toFixed(2),
          price_vs_vwap: parseFloat(tf.vwap.priceVsVwap.toFixed(2)),
          vwap_band_position: vwapBandPosition,
        };
      }),

      // Position context
      open_positions: context.openPositions,
      confirmation_streaks: context.confirmationStreaks,
      recent_decisions: context.recentDecisions.slice(0, 5),
      recent_evaluations: context.recentEvaluations.slice(0, 5).map(e => ({
        option_right:            e.optionRight,
        outcome:                 e.outcome,
        grade:                   e.grade,
        score:                   e.score,
        pnl_total:               e.pnlTotal,
        hold_duration_min:       e.holdDurationMin,
        signal_quality:          e.signalQuality,
        timing_quality:          e.timingQuality,
        risk_management_quality: e.riskManagementQuality,
        lessons_learned:         e.lessonsLearned,
        evaluated_at:            e.evaluatedAt,
      })),
      broker_positions: context.brokerPositions,
      broker_open_orders: context.brokerOpenOrders,
      broker_open_orders_count: context.brokerOpenOrders.length,
      account_equity: context.accountEquity,
      account_buying_power: context.accountBuyingPower,
    }, null, 2);

    let rawOutput: OrchestratorRawOutput = {
      decision_type: 'WAIT',
      confirmation_count: 0,
      reasoning: 'Failed to get AI decision — defaulting to WAIT',
      urgency: 'low',
      should_execute: false,
    };

    try {
      // Stream the response to reduce time-to-decision: first tokens arrive sooner
      // than waiting for the full response, and we parse JSON as soon as stream ends.
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: 'system', content: ORCHESTRATOR_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      });

      let text = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) text += delta;
      }
      if (!text) text = '{}';
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(clean) as Partial<OrchestratorRawOutput>;

      rawOutput = {
        decision_type: parsed.decision_type ?? 'WAIT',
        confirmation_count: parsed.confirmation_count ?? 0,
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        urgency: parsed.urgency ?? 'standard',
        should_execute: parsed.should_execute ?? false,
        entry_strategy: parsed.entry_strategy,
        risk_notes: parsed.risk_notes,
        streak_context: parsed.streak_context,
      };
    } catch (err) {
      console.error('[DecisionOrchestrator] OpenAI error:', err);
    }

    // Hard gate: EXIT/REDUCE/REVERSE are meaningless without an open position — override to WAIT
    const isPositionDecision = rawOutput.decision_type === 'EXIT' || rawOutput.decision_type === 'REDUCE_EXPOSURE' || rawOutput.decision_type === 'REVERSE';
    if (isPositionDecision && context.openPositions.length === 0) {
      const originalDecision = rawOutput.decision_type;
      rawOutput.decision_type = 'WAIT';
      rawOutput.should_execute = false;
      rawOutput.reasoning = `[GATE OVERRIDE] No open position — ${originalDecision} is not applicable. ${rawOutput.reasoning}`;
    }

    // Hard EOD gate: force EXIT for any open position in EOD window
    if (isEodWindow && context.openPositions.length > 0 && rawOutput.decision_type !== 'EXIT') {
      const eodOriginal = rawOutput.decision_type;
      rawOutput.decision_type = 'EXIT';
      rawOutput.should_execute = true;
      rawOutput.reasoning = `[EOD GATE] End-of-day liquidation — closing all positions (${minutesToClose} min to close). Original: ${eodOriginal}. ${rawOutput.reasoning}`;
    }

    // Track whether a hard time-based gate blocked a new entry (EOD or FOMC).
    // Used below to prevent isConvictionAdvanceWait from firing on these blocks.
    let isHardTimeGateBlock = false;

    // EOD window also blocks new entries
    if (isEodWindow && (rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION')) {
      rawOutput.decision_type = 'WAIT';
      rawOutput.should_execute = false;
      rawOutput.reasoning = `[EOD GATE] New entries forbidden in EOD window. ${rawOutput.reasoning}`;
      isHardTimeGateBlock = true;
    }

    // Late-day gate: block ALL new entries in the last 30 minutes before close.
    // This prevents chasing setups that have no time to develop and avoids forced
    // EOD liquidations at a loss (e.g. 2026-03-12 SPY entry at 19:57 UTC, 3 min before close).
    // Runs before phase-change overrides so they cannot bypass it.
    if (!isHardTimeGateBlock && minutesToClose <= 30 && minutesToClose > 0 &&
        (rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION')) {
      rawOutput.decision_type = 'WAIT';
      rawOutput.should_execute = false;
      rawOutput.reasoning = `[LATE-DAY GATE] New entries forbidden within 30 min of close (${minutesToClose} min remaining). ${rawOutput.reasoning}`;
      isHardTimeGateBlock = true;
      console.log(`[DecisionOrchestrator] Late-day gate blocked entry — ${minutesToClose} min to close`);
    }

    // FOMC gate: block new entries when an FOMC event is within 30 minutes
    if (isFomcWindow && (rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION')) {
      rawOutput.decision_type = 'WAIT';
      rawOutput.should_execute = false;
      rawOutput.reasoning = `[FOMC GATE] ${fomcEventDescription} in ${fomcMinutesToEvent} min — new entries forbidden. ${rawOutput.reasoning}`;
      isHardTimeGateBlock = true;
    }

    // Final safety: override to WAIT if safety gates fail for entry decisions
    const isEntryDecision = rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION';
    if (isEntryDecision) {
      if (!timeGateOk) {
        const originalDecisionType = rawOutput.decision_type;
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Market closed. Original: ${originalDecisionType}. ${rawOutput.reasoning}`;
      } else if (!option.liquidityOk || !option.candidatePass) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Liquidity/candidate gate failed. ${rawOutput.reasoning}`;
      } else if (analysis.confidence < minConfidence) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Confidence ${analysis.confidence.toFixed(2)} < ${minConfidence}. ${rawOutput.reasoning}`;
      }
      // NOTE: should_execute=false returned by the AI for a valid NEW_ENTRY/ADD_POSITION is
      // intentionally respected — it means the AI expressed doubt.  The confirmation count gate
      // below provides server-side protection against premature entries regardless.
    }

    // Server-side confirmation count — computed here (before the confirmation gate) so the gate
    // can use priorCount, and the final serverCount reflects the post-gate decision type.
    // Always use server count as the source of truth — never let AI count drift unchecked.
    const priorCount = computeServerConfirmationCount(context.recentDecisions, signal.direction ?? '');

    // Confirmation count gate for NEW_ENTRY: require at least 1 prior same-direction confirmation
    // (meaning serverCount will be >= 2) before allowing execution.
    // Override path:
    //   (A) High-conviction override: confidence >= 0.92 AND alignment = "all_aligned"
    // ADD_POSITION already requires an open position + confidence >= 0.80 + all_aligned, so it
    // is excluded from this gate — the existing conditions are sufficient.
    //
    // IMPORTANT: When the gate fires at Stage-1 (priorCount=0), we mark this as a Stage-1 OBSERVE
    // WAIT and still advance the server count to 1.  This ensures the next cycle sees priorCount=1
    // and can enter at Stage-2, preventing an infinite Stage-1 loop where entries are permanently
    // blocked because WAIT decisions never advance the count.
    let isStage1ObserveWait = false;
    let isPhaseChangeOverride = false;
    if (rawOutput.decision_type === 'NEW_ENTRY' && rawOutput.should_execute) {
      const htfTf = signal.timeframes[2] ?? signal.timeframes[0];

      // Build GateInput from live state
      const now = new Date();
      const minsSinceOpen = minutesSinceMarketOpen(now);
      const todayStr = now.toISOString().slice(0, 10);
      const nowMs = now.getTime();

      const rangeEntries = context.recentDecisions.filter(d =>
        d.decisionType === 'NEW_ENTRY' && d.reasoning?.includes('[RANGE') && d.createdAt.startsWith(todayStr));
      const breakoutEntries = context.recentDecisions.filter(d =>
        d.decisionType === 'NEW_ENTRY' && d.reasoning?.includes('[BREAKOUT') && d.createdAt.startsWith(todayStr));
      const vwapRevEntries = context.recentDecisions.filter(d =>
        d.decisionType === 'NEW_ENTRY' && d.reasoning?.includes('[VWAP_REV') && d.createdAt.startsWith(todayStr));
      const allEntries = context.recentDecisions.filter(d =>
        d.decisionType === 'NEW_ENTRY' && d.createdAt.startsWith(todayStr));

      const gateInput: GateInput = {
        confidence: analysis.confidence,
        alignment: signal.alignment,
        direction: signal.direction ?? 'neutral',
        signalMode: signal.signalMode ?? 'trend',
        strengthScore: signal.strengthScore,
        trendPhaseBonus: analysis.confidenceBreakdown.trendPhaseBonus,
        adxBonus: analysis.confidenceBreakdown.adxBonus,
        recentPriceActionBonus: analysis.confidenceBreakdown.recentPriceActionBonus,
        nearLevelPenalty: analysis.confidenceBreakdown.nearLevelPenalty,
        htf: htfTf ? {
          adx: htfTf.dmi.adx,
          growthCrossUp: htfTf.dmi.growthCrossUp,
          growthCrossDown: htfTf.dmi.growthCrossDown,
          rangePosition: htfTf.priceStructure.rangePosition,
        } : null,
        ltfVwapPriceVsVwap: signal.timeframes[0]?.vwap.priceVsVwap ?? null,
        orbFormed: signal.orb.orbFormed,
        orbBreakoutDirection: signal.orb.breakoutDirection,
        rangeExhaustion: analysis.rangeExhaustion ?? null,
        priorCount,
        minutesSinceOpen: minsSinceOpen,
        rangeEntryCount: rangeEntries.length,
        lastRangeEntryAgeMin: rangeEntries[0] ? (nowMs - new Date(rangeEntries[0].createdAt).getTime()) / 60_000 : null,
        breakoutEntryCount: breakoutEntries.length,
        lastBreakoutEntryAgeMin: breakoutEntries[0] ? (nowMs - new Date(breakoutEntries[0].createdAt).getTime()) / 60_000 : null,
        vwapRevEntryCount: vwapRevEntries.length,
        lastVwapRevEntryAgeMin: vwapRevEntries[0] ? (nowMs - new Date(vwapRevEntries[0].createdAt).getTime()) / 60_000 : null,
        totalDailyEntries: allEntries.length,
        hasRecentPhaseChangeEntry: context.recentDecisions.some(d =>
          d.decisionType === 'NEW_ENTRY' && d.direction === signal.direction && d.reasoning?.includes('[PHASE-CHANGE')),
        maxDailyEntries: tickerCfg?.maxDailyEntries ?? 4,
      };

      const gate = evaluateEntryGate(gateInput);
      const side = signal.direction === 'bullish' ? 'CALL' : 'PUT';

      if (gate.result === 'STAGE1_OBSERVE' || gate.result === 'DAILY_CAP_BLOCKED') {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        const timingNote = gate.phaseChangeTimingRejected
          ? ` [Phase-change structural signal present but timing rejected: ${gate.phaseChangeTimingRejectReason}]`
          : '';
        if (gate.result === 'DAILY_CAP_BLOCKED') {
          rawOutput.reasoning = `[DAILY CAP] Entry blocked — ${allEntries.length}/${gateInput.maxDailyEntries} entries today. ${rawOutput.reasoning}`;
          console.log(`[DecisionOrchestrator] Daily entry cap reached (${allEntries.length}/${gateInput.maxDailyEntries}) — blocking all new entries`);
        } else {
          rawOutput.reasoning = `[STAGE-1 OBSERVE] [TRIGGER: AI recommended NEW_ENTRY but server gate blocked — priorCount=${priorCount}, needs ≥1 confirm]${timingNote} Building conviction (count will advance to 1). Override requires confidence>=0.92 + all_aligned, or confidence>=0.75 + all_aligned, or phase-change. ${rawOutput.reasoning}`;
          if (gate.phaseChangeTimingRejected) {
            console.log(`[DecisionOrchestrator] Phase-change override blocked by timing filter: ${gate.phaseChangeTimingRejectReason} (priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)})`);
          }
          console.log(`[DecisionOrchestrator] NEW_ENTRY blocked by confirmation gate (Stage-1 OBSERVE, priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment})`);
        }
        isStage1ObserveWait = true;
      } else if (gate.bypass === 'range') {
        rawOutput.reasoning = `[RANGE BYPASS] Mean-reversion ${side} at range ${signal.direction === 'bullish' ? 'support' : 'resistance'} (conf=${(analysis.confidence * 100).toFixed(1)}%, ADX=${htfTf?.dmi.adx.toFixed(1)}). ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] NEW_ENTRY range bypass — ${side} (confidence=${analysis.confidence.toFixed(2)}, support=${signal.rangeSupport?.toFixed(2)}, resistance=${signal.rangeResistance?.toFixed(2)})`);
      } else if (gate.bypass === 'breakout') {
        rawOutput.reasoning = `[BREAKOUT BYPASS] Squeeze breakout ${side} beyond ${signal.breakoutLevel?.toFixed(2)} (conf=${(analysis.confidence * 100).toFixed(1)}%, ADX=${htfTf?.dmi.adx.toFixed(1)}, slope=${htfTf?.dmi.adxSlope.toFixed(1)}). ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] NEW_ENTRY breakout bypass — ${side} (confidence=${analysis.confidence.toFixed(2)}, breakoutLevel=${signal.breakoutLevel?.toFixed(2)}, beyond=${signal.breakoutBeyond?.toFixed(3)}%)`);
      } else if (gate.bypass === 'vwap_reversion') {
        rawOutput.reasoning = `[VWAP_REV BYPASS] VWAP reversion ${side} toward ${signal.vwapReversionTarget?.toFixed(2)} (conf=${(analysis.confidence * 100).toFixed(1)}%, dist=${signal.vwapDistance?.toFixed(2)}%). ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] NEW_ENTRY VWAP reversion bypass — ${side} (confidence=${analysis.confidence.toFixed(2)}, vwapTarget=${signal.vwapReversionTarget?.toFixed(2)}, distance=${signal.vwapDistance?.toFixed(2)}%)`);
      } else if (gate.bypass === 'strong_signal') {
        rawOutput.reasoning = `[STRONG-SIGNAL BYPASS] Confidence ${(analysis.confidence * 100).toFixed(1)}% + all_aligned → immediate ${side} entry (no 2-stage wait). ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] NEW_ENTRY strong-signal bypass — ${side} (priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment})`);
      } else if (gate.result === 'PHASE_CHANGE_OVERRIDE') {
        isPhaseChangeOverride = true;
        rawOutput.reasoning = `[PHASE-CHANGE OVERRIDE] HTF DI cross ${signal.direction} + rising ADX → immediate ${side} entry (no 2-stage wait). ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] NEW_ENTRY phase-change override applied — ${side} (priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}, htfADXSlope=${htfTf!.dmi.adxSlope.toFixed(1)})`);
      } else if (gate.result === 'HIGH_CONV_OVERRIDE') {
        // HIGH_CONV_OVERRIDE — no additional reasoning tag needed, AI already decided
      }
      // else: PASSED via stage2_confirm — no additional reasoning tag needed
    }

    // (D) Phase-change rescue: REMOVED (2026-03-13).
    // Data showed RESCUE overriding AI's WAIT on stale/lagging HTF DI cross signals,
    // causing repeated losing entries after the initial move was done (e.g. 2026-03-12
    // SPY: 6 RESCUE entries, 5 lost). The AI's WAIT judgment should be respected.
    // Phase-change OVERRIDE (section C) is retained — it only fires when the AI already
    // recommends NEW_ENTRY, so the AI's conviction is confirmed by the structural signal.

    // Direct AI WAITs at Stage-1: advance the count so Stage-2 can happen next cycle.
    // Previously these did NOT advance, creating a permanent deadlock where the AI
    // kept choosing WAIT and the count stayed at 0 forever — resulting in zero entries.
    // The AI's caution is still respected (no immediate entry), but the count advances
    // so the system can attempt entry at Stage-2 on the next confirming signal.
    if (!isStage1ObserveWait && !isHardTimeGateBlock && rawOutput.decision_type === 'WAIT' &&
        analysis.meetsEntryThreshold && !rawOutput.reasoning.includes('[GATE OVERRIDE]')) {
      if (priorCount === 0) {
        rawOutput.reasoning = `[STAGE-1 OBSERVE] [TRIGGER: AI returned WAIT despite confidence ${analysis.confidence.toFixed(2)} above threshold — advancing count to 1 for Stage-2 opportunity] ${rawOutput.reasoning}`;
        isStage1ObserveWait = true; // advance count so Stage-2 can fire next cycle
        console.log(`[DecisionOrchestrator] Direct AI WAIT at Stage-1 (priorCount=0, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}) — advancing count to 1 (deadlock prevention)`);
      } else {
        // At priorCount>=1, AI still chose WAIT — count does NOT advance further.
        rawOutput.reasoning = `[STAGE-${priorCount} WAIT] [AI chose WAIT — count stays at ${priorCount} (requires NEW_ENTRY to advance)] ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] Direct AI WAIT at Stage-${priorCount} (priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}) — NOT advancing count (requires NEW_ENTRY)`);
      }
    }

    // Server-side confirmation count — computed after all gate overrides.
    // Only add +1 when the final decision is a pre-entry conviction advance (WAIT stages) or
    // Stage-1 OBSERVE.  CONFIRM_HOLD means position is already open — the confirmation counter
    // is irrelevant post-entry, so it stays at 0 to keep the dashboard clean.
    // Hard-gate WAITs (market closed, liquidity fail, confidence below threshold,
    // EOD, FOMC) do NOT advance count — those represent genuine blocking conditions, not observations.
    // NEW_ENTRY / ADD_POSITION mean an order is placed — the confirmation cycle is complete.
    // Reset count to 0 so the dashboard shows a clean slate (next cycle starts fresh).
    // IMPORTANT: recompute isEntryDecision using the FINAL decision_type (after all gate overrides).
    // The original isEntryDecision was computed before confirmation/EOD/FOMC gates could convert
    // NEW_ENTRY → WAIT, which would incorrectly force serverCount=0 on Stage-1 OBSERVE WAITs.
    const isFinalEntryDecision = rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION';
    const isConvictionDecision = isStage1ObserveWait; // only gate-blocked NEW_ENTRY→WAIT advances count
    const serverCount = isFinalEntryDecision ? 0
      : rawOutput.decision_type === 'CONFIRM_HOLD' ? 0
      : priorCount + (isConvictionDecision ? 1 : 0);
    if (serverCount !== rawOutput.confirmation_count) {
      console.log(`[DecisionOrchestrator] Overriding AI count (${rawOutput.confirmation_count}) with server count (${serverCount})`);
      rawOutput.confirmation_count = serverCount;
    }

    // Sanitize: WAIT decisions must never have should_execute=true (AI sometimes outputs this
    // inconsistently — it causes misleading ✅ in the dashboard with no functional effect).
    if (rawOutput.decision_type === 'WAIT' && rawOutput.should_execute) {
      rawOutput.should_execute = false;
    }

    return {
      id: uuidv4(),
      signalId: signal.id,
      sessionId: signal.sessionId,
      decisionType: rawOutput.decision_type,
      ticker: signal.ticker,
      profile: signal.profile,
      direction: signal.direction,
      confirmationCount: rawOutput.confirmation_count,
      orchestrationConfidence: analysis.confidence,
      reasoning: rawOutput.reasoning,
      urgency: rawOutput.urgency,
      shouldExecute: rawOutput.should_execute,
      entryStrategy: isPhaseChangeOverride ? {
        stage: 'OVERRIDE_ENTRY' as const,
        confirmationCount: 0,
        signalDirection: (signal.direction === 'bullish' ? 'call' : 'put') as 'call' | 'put',
        confirmationsNeeded: 2,
        overrideTriggered: true,
        notes: `Phase-change override: HTF DI cross ${signal.direction} + rising ADX (slope ${(signal.timeframes[2] ?? signal.timeframes[0])!.dmi.adxSlope.toFixed(1)}) → immediate entry`,
      } : rawOutput.entry_strategy ? {
        stage: rawOutput.entry_strategy.stage as 'OBSERVE' | 'BUILDING_CONVICTION' | 'CONFIRMED_ENTRY' | 'OVERRIDE_ENTRY' | 'NOT_APPLICABLE',
        confirmationCount: rawOutput.entry_strategy.confirmation_count,
        signalDirection: rawOutput.entry_strategy.signal_direction as 'call' | 'put' | null,
        confirmationsNeeded: rawOutput.entry_strategy.confirmations_needed,
        overrideTriggered: rawOutput.entry_strategy.override_triggered,
        notes: rawOutput.entry_strategy.notes,
      } : undefined,
      riskNotes: rawOutput.risk_notes,
      streakContext: rawOutput.streak_context,
      createdAt: new Date().toISOString(),
    };
  }
}
