import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { loadSkill } from '../utils/skill-loader.js';
import { checkFomcWindow } from '../lib/fomc-calendar.js';
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
 * Server-side confirmation counter — counts consecutive same-direction decisions
 * from recentDecisions (newest-first) where confidence >= MIN_CONFIDENCE.
 * Returns 0 if no prior same-direction decisions found.
 * The current cycle is NOT included (caller adds +1).
 */
function computeServerConfirmationCount(
  recentDecisions: PositionContext['recentDecisions'],
  direction: string,
): number {
  let count = 0;
  for (const d of recentDecisions) {
    // Only count decisions that are part of the same directional conviction run.
    // Break on any non-actionable type (EXIT, REDUCE_EXPOSURE, REVERSE) or direction change.
    const isActionable = d.decisionType === 'WAIT' || d.decisionType === 'NEW_ENTRY' ||
                         d.decisionType === 'CONFIRM_HOLD' || d.decisionType === 'ADD_POSITION';
    if (!isActionable) break;
    if (d.direction !== direction) break;
    count++;
  }
  return count;
}

export class DecisionOrchestrator {
  async run(input: OrchestratorInput): Promise<DecisionResult> {
    const { signal, option, analysis, context, timeGateOk } = input;
    const { isEodWindow, minutesToClose } = computeEodWindow();
    const { isFomcWindow, minutesToEvent: fomcMinutesToEvent, eventDescription: fomcEventDescription } = checkFomcWindow(30);

    // Build the user message with full context
    const userMessage = JSON.stringify({
      // Signal summary
      ticker: signal.ticker,
      profile: signal.profile,
      direction: signal.direction,
      alignment: signal.alignment,
      triggered_by: signal.triggeredBy,

      // Analysis
      confidence: analysis.confidence,
      confidence_breakdown: {
        di_cross_bonus: analysis.confidenceBreakdown.diCrossBonus,
        vwap_bonus: analysis.confidenceBreakdown.vwapBonus,
        price_position_adjustment: analysis.confidenceBreakdown.pricePositionAdjustment,
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
      const msg = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: ORCHESTRATOR_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      });

      const text = msg.choices[0]?.message?.content ?? '{}';
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

    // Server-side confirmation count — count consecutive same-direction decisions from DB.
    // Use the max of AI-reported count and server count to guard against AI count drift/reset.
    const serverCount = computeServerConfirmationCount(context.recentDecisions, signal.direction ?? '') + 1;
    if (serverCount > rawOutput.confirmation_count) {
      console.log(`[DecisionOrchestrator] Server count (${serverCount}) > AI count (${rawOutput.confirmation_count}) — using server count`);
      rawOutput.confirmation_count = serverCount;
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
      rawOutput.decision_type = 'EXIT';
      rawOutput.should_execute = true;
      rawOutput.reasoning = `[EOD GATE] End-of-day liquidation — closing all positions (${minutesToClose} min to close). Original: ${rawOutput.decision_type}. ${rawOutput.reasoning}`;
    }

    // EOD window also blocks new entries
    if (isEodWindow && (rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION')) {
      rawOutput.decision_type = 'WAIT';
      rawOutput.should_execute = false;
      rawOutput.reasoning = `[EOD GATE] New entries forbidden in EOD window. ${rawOutput.reasoning}`;
    }

    // FOMC gate: block new entries when an FOMC event is within 30 minutes
    if (isFomcWindow && (rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION')) {
      rawOutput.decision_type = 'WAIT';
      rawOutput.should_execute = false;
      rawOutput.reasoning = `[FOMC GATE] ${fomcEventDescription} in ${fomcMinutesToEvent} min — new entries forbidden. ${rawOutput.reasoning}`;
    }

    // Final safety: override to WAIT if safety gates fail for entry decisions
    const isEntryDecision = rawOutput.decision_type === 'NEW_ENTRY' || rawOutput.decision_type === 'ADD_POSITION';
    if (isEntryDecision) {
      if (!timeGateOk) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Market closed. Original: ${rawOutput.decision_type}. ${rawOutput.reasoning}`;
      } else if (!option.liquidityOk || !option.candidatePass) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Liquidity/candidate gate failed. ${rawOutput.reasoning}`;
      } else if (analysis.confidence < config.MIN_CONFIDENCE) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Confidence ${analysis.confidence.toFixed(2)} < ${config.MIN_CONFIDENCE}. ${rawOutput.reasoning}`;
      } else {
        // All gates passed — ensure shouldExecute is true regardless of what the AI returned.
        // Guards against AI returning should_execute: false for a valid NEW_ENTRY/ADD_POSITION.
        if (!rawOutput.should_execute) {
          console.warn(`[DecisionOrchestrator] ${rawOutput.decision_type}: AI returned should_execute=false but all gates passed — correcting to true`);
          rawOutput.should_execute = true;
        }
      }
    }

    // Stage 3 hard gate: AI is forbidden from blocking past confirmation_count >= 3,
    // UNLESS momentum indicators contradict the signal direction.
    // Blocking conditions (any one suppresses the override):
    //   1. OBV divergence on 2+ TFs — multi-TF volume failure (1-TF divergence only raises AI threshold by +1)
    //   2. TD exhaustion on ANY TF — setup or countdown completion signals trend exhaustion
    //   3. Alignment is 'mixed' — no clear consensus across timeframes
    //   4. HTF ADX < 20 — trend is too weak to justify a forced entry
    //   5. HTF DI crossed adverse on last bar — momentum just flipped against the signal
    const STAGE3_MIN_CONFIDENCE = config.MIN_CONFIDENCE; // Same as entry threshold — 3 confirmations IS the conviction
    const STAGE3_MIN_HTF_ADX = 20;      // Minimum HTF trend strength for a forced entry

    const adverseOBVCount = signal.timeframes.filter(tf => {
      if (signal.direction === 'bullish') return tf.obv.divergence === 'bearish';
      if (signal.direction === 'bearish') return tf.obv.divergence === 'bullish';
      return false;
    }).length;

    // TD exhaustion: a completed setup or countdown in the opposing direction signals trend exhaustion
    const adverseTDCount = signal.timeframes.filter(tf => {
      if (signal.direction === 'bullish') {
        return (tf.td.setup.completed && tf.td.setup.completedDirection === 'sell') ||
               (tf.td.countdown.completed && tf.td.countdown.direction === 'sell');
      }
      if (signal.direction === 'bearish') {
        return (tf.td.setup.completed && tf.td.setup.completedDirection === 'buy') ||
               (tf.td.countdown.completed && tf.td.countdown.direction === 'buy');
      }
      return false;
    }).length;

    // HTF is last element (timeframes ordered [LTF, MTF, HTF])
    const htfTF = signal.timeframes[signal.timeframes.length - 1];

    // Adverse HTF DI cross: DI just crossed opposite to signal direction on the last bar
    const htfAdverseCross = htfTF !== undefined && (
      (signal.direction === 'bullish' && htfTF.dmi.crossedDown) ||
      (signal.direction === 'bearish' && htfTF.dmi.crossedUp)
    );

    const stage3BlockedByOBV = adverseOBVCount >= 2;          // 2+ TF OBV divergence blocks override (matches AI prompt: 1 TF only raises threshold)
    const stage3BlockedByTD = adverseTDCount >= 1;
    const stage3BlockedByConfidence = analysis.confidence < STAGE3_MIN_CONFIDENCE;
    const stage3BlockedByMixedAlignment = signal.alignment === 'mixed'; // No TF consensus
    const stage3BlockedByWeakHTF = htfTF !== undefined && htfTF.dmi.adx < STAGE3_MIN_HTF_ADX;
    const stage3BlockedByAdverseDICross = htfAdverseCross;     // Fresh cross against signal direction

    if (
      rawOutput.decision_type === 'WAIT' &&
      rawOutput.confirmation_count >= 3 &&
      !stage3BlockedByConfidence &&
      !stage3BlockedByMixedAlignment &&
      !stage3BlockedByWeakHTF &&
      !stage3BlockedByAdverseDICross &&
      timeGateOk &&
      option.liquidityOk &&
      option.candidatePass &&
      context.openPositions.length === 0 &&
      !isEodWindow &&
      !isFomcWindow &&
      !stage3BlockedByOBV &&
      !stage3BlockedByTD
    ) {
      rawOutput.decision_type = 'NEW_ENTRY';
      rawOutput.should_execute = true;
      if (rawOutput.urgency === 'low') rawOutput.urgency = 'standard';
      rawOutput.reasoning = `[STAGE 3 OVERRIDE] confirmation_count=${rawOutput.confirmation_count} >= 3, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}, HTF ADX=${htfTF?.dmi.adx.toFixed(1)} — Stage 3 CONFIRMED_ENTRY enforced; OBV adverse TFs=${adverseOBVCount}/3, TD exhaustion TFs=${adverseTDCount}/3. ${rawOutput.reasoning}`;
    } else if (rawOutput.decision_type === 'WAIT' && rawOutput.confirmation_count >= 3) {
      const blockReasons: string[] = [];
      if (stage3BlockedByConfidence) blockReasons.push(`confidence ${analysis.confidence.toFixed(2)} < ${STAGE3_MIN_CONFIDENCE} (Stage 3 threshold)`);
      if (stage3BlockedByMixedAlignment) blockReasons.push(`alignment=${signal.alignment} (need all_aligned or htf_mtf_aligned)`);
      if (stage3BlockedByWeakHTF) blockReasons.push(`HTF ADX=${htfTF?.dmi.adx.toFixed(1)} < ${STAGE3_MIN_HTF_ADX} (trend too weak)`);
      if (stage3BlockedByAdverseDICross) blockReasons.push(`HTF DI crossed ${signal.direction === 'bullish' ? 'bearish' : 'bullish'} on last bar (momentum flipped)`);
      if (stage3BlockedByOBV) blockReasons.push(`multi-TF OBV divergence on ${adverseOBVCount}/3 TFs (need < 2)`);
      if (stage3BlockedByTD) blockReasons.push(`TD exhaustion on ${adverseTDCount}/3 TFs`);
      if (blockReasons.length > 0) {
        rawOutput.reasoning = `[STAGE 3 BLOCKED] confirmation_count=${rawOutput.confirmation_count} >= 3 but blocked by: ${blockReasons.join('; ')}. ${rawOutput.reasoning}`;
      }
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
      entryStrategy: rawOutput.entry_strategy ? {
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
