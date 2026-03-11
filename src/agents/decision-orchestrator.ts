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
        trend_phase_bonus: analysis.confidenceBreakdown.trendPhaseBonus,
        momentum_accel_bonus: analysis.confidenceBreakdown.momentumAccelBonus,
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
      } else if (analysis.confidence < config.MIN_CONFIDENCE) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[GATE OVERRIDE] Confidence ${analysis.confidence.toFixed(2)} < ${config.MIN_CONFIDENCE}. ${rawOutput.reasoning}`;
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
    // Two override paths exist:
    //   (A) High-conviction override: confidence >= 0.85 AND alignment = "all_aligned"
    //   (B) Post-WIN relaxation: most recent evaluation was a WIN — allow count-1 re-entry at
    //       confidence >= 0.72 AND alignment != "mixed". This prevents a forced 2-cycle (~6 min)
    //       delay when the market gives a fresh setup immediately after banking profit.
    //       Not granted after a LOSS exit (stop-out) — patience required to rebuild conviction.
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
      const overrideOk = analysis.confidence >= 0.92 && signal.alignment === 'all_aligned';
      const lastEvalWasWin = context.recentEvaluations.length > 0 &&
        context.recentEvaluations[0].outcome === 'WIN' &&
        (context.recentEvaluations[0].pnlTotal ?? 0) > 0;
      const postWinRelaxOk = lastEvalWasWin &&
        analysis.confidence >= 0.72 &&
        signal.alignment !== 'mixed';

      // (C) Phase-change override: HTF DI crossed in signal direction within last 2 bars
      //     (still holding) with rising ADX (growth phase). This is a definitive trend-change
      //     signal — enter immediately without waiting for the 2-stage confirmation gate.
      //     Requires confidence >= 0.60 and non-mixed alignment to filter noise.
      //     Threshold is lower than other overrides because the structural signal (growth cross
      //     + rising ADX + non-mixed alignment) already provides strong filtering.
      const htfTf = signal.timeframes[2] ?? signal.timeframes[0];
      const phaseChangeOk = !!htfTf &&
        analysis.confidence >= 0.60 &&
        signal.alignment !== 'mixed' &&
        (signal.direction === 'bullish' ? htfTf.dmi.growthCrossUp : htfTf.dmi.growthCrossDown);

      if (!overrideOk && !postWinRelaxOk && !phaseChangeOk && priorCount < 1) {
        rawOutput.decision_type = 'WAIT';
        rawOutput.should_execute = false;
        rawOutput.reasoning = `[STAGE-1 OBSERVE] [TRIGGER: AI recommended NEW_ENTRY but server gate blocked — priorCount=${priorCount}, needs ≥1 confirm] Building conviction (count will advance to 1). Override requires confidence>=0.92 + all_aligned, or post-WIN relaxation (confidence>=0.72 + non-mixed alignment), or phase-change (confidence>=0.60 + HTF DI cross within 2 bars + rising ADX). ${rawOutput.reasoning}`;
        isStage1ObserveWait = true; // count advances to 1 so next cycle can enter at Stage-2
        console.log(`[DecisionOrchestrator] NEW_ENTRY blocked by confirmation gate (Stage-1 OBSERVE, priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}, lastEvalWasWin=${lastEvalWasWin})`);
      } else if (phaseChangeOk && priorCount < 1 && !overrideOk && !postWinRelaxOk) {
        isPhaseChangeOverride = true;
        const side = signal.direction === 'bullish' ? 'CALL' : 'PUT';
        rawOutput.reasoning = `[PHASE-CHANGE OVERRIDE] HTF DI cross ${signal.direction} + rising ADX → immediate ${side} entry (no 2-stage wait). ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] NEW_ENTRY phase-change override applied — ${side} (priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}, htfADXSlope=${htfTf!.dmi.adxSlope.toFixed(1)})`);
      } else if (postWinRelaxOk && priorCount < 1 && !overrideOk) {
        console.log(`[DecisionOrchestrator] NEW_ENTRY post-WIN relaxation applied (priorCount=${priorCount}, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment})`);
      }
    }

    // (D) Phase-change rescue: AI output WAIT but phase change conditions are met.
    //     This closes the gap where confidence is 0.60–0.64 (below AI's 0.65 threshold
    //     so AI outputs WAIT) but the structural phase-change signal is strong enough
    //     to warrant immediate entry. Without this, phase changes in that confidence
    //     range are lost entirely — the server override above only checks NEW_ENTRY.
    if (!isPhaseChangeOverride && !isHardTimeGateBlock &&
        rawOutput.decision_type === 'WAIT' && !rawOutput.reasoning.includes('[GATE OVERRIDE]')) {
      const htfTf = signal.timeframes[2] ?? signal.timeframes[0];
      const phaseChangeRescue = !!htfTf &&
        analysis.confidence >= 0.60 &&
        signal.alignment !== 'mixed' &&
        signal.direction &&
        (signal.direction === 'bullish' ? htfTf.dmi.growthCrossUp : htfTf.dmi.growthCrossDown);
      if (phaseChangeRescue) {
        const side = signal.direction === 'bullish' ? 'CALL' : 'PUT';
        rawOutput.decision_type = 'NEW_ENTRY';
        rawOutput.should_execute = true;
        rawOutput.reasoning = `[PHASE-CHANGE RESCUE] AI output WAIT (confidence ${analysis.confidence.toFixed(2)} below 0.65 threshold) but HTF DI cross ${signal.direction} + rising ADX detected → overriding to ${side} entry. ${rawOutput.reasoning}`;
        isPhaseChangeOverride = true;
        isStage1ObserveWait = false;
        console.log(`[DecisionOrchestrator] Phase-change rescue: WAIT → NEW_ENTRY (confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}, htfADXSlope=${htfTf!.dmi.adxSlope.toFixed(1)})`);
      }
    }

    // Direct AI WAITs: WAIT decisions from the AI never advance the confirmation count.
    // Only gate-blocked NEW_ENTRY decisions (isStage1ObserveWait) advance the count.
    // The AI must output NEW_ENTRY to signal conviction — WAIT means "not ready".
    if (!isStage1ObserveWait && !isHardTimeGateBlock && rawOutput.decision_type === 'WAIT' &&
        analysis.meetsEntryThreshold && !rawOutput.reasoning.includes('[GATE OVERRIDE]')) {
      if (priorCount === 0) {
        rawOutput.reasoning = `[STAGE-1 OBSERVE] [TRIGGER: AI returned WAIT despite confidence ${analysis.confidence.toFixed(2)} above threshold — AI chose caution, count stays at 0 (requires NEW_ENTRY to advance)] ${rawOutput.reasoning}`;
        console.log(`[DecisionOrchestrator] Direct AI WAIT at Stage-1 (priorCount=0, confidence=${analysis.confidence.toFixed(2)}, alignment=${signal.alignment}) — NOT advancing count (requires NEW_ENTRY)`);
      } else {
        // At priorCount>=1, AI still chose WAIT — count does NOT advance.
        // AI must output NEW_ENTRY to advance the count; WAIT always means "not ready".
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
