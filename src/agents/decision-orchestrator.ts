import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { loadSkill } from '../utils/skill-loader.js';
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

export class DecisionOrchestrator {
  async run(input: OrchestratorInput): Promise<DecisionResult> {
    const { signal, option, analysis, context, timeGateOk } = input;
    const { isEodWindow, minutesToClose } = computeEodWindow();

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
      meets_entry_threshold: analysis.meetsEntryThreshold,
      desired_right: analysis.desiredRight,
      key_factors: analysis.keyFactors,
      risks: analysis.risks,

      // Option evaluation
      time_gate_ok: timeGateOk,
      is_eod_window: isEodWindow,
      minutes_to_close: minutesToClose,
      liquidity_ok: option.liquidityOk,
      candidate_pass: option.candidatePass,
      winner_side: option.winner,
      winner_symbol: option.winnerCandidate?.contract.symbol,
      winner_rr: option.winnerCandidate?.rrRatio,
      winner_spread_pct: option.winnerCandidate?.contract.spreadPct,
      winner_entry: option.winnerCandidate?.entryPremium,
      winner_stop: option.winnerCandidate?.stopPremium,
      winner_tp: option.winnerCandidate?.tpPremium,

      // TF indicators summary
      timeframes: signal.timeframes.map(tf => ({
        tf: tf.timeframe,
        trend: tf.dmi.trend,
        adx: tf.dmi.adx.toFixed(1),
        td_setup: tf.td.setup,
        candle: tf.candlePattern,
      })),

      // Position context
      open_positions: context.openPositions,
      confirmation_streaks: context.confirmationStreaks,
      recent_decisions: context.recentDecisions.slice(0, 5),
      recent_evaluations: context.recentEvaluations.slice(0, 3),
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
      }
    }

    return {
      id: uuidv4(),
      signalId: signal.id,
      sessionId: signal.sessionId,
      decisionType: rawOutput.decision_type,
      ticker: signal.ticker,
      profile: signal.profile,
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
