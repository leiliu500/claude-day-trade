import { SignalAgent } from '../agents/signal-agent.js';
import { OptionAgent } from '../agents/option-agent.js';
import { AnalysisAgent } from '../agents/analysis-agent.js';
import { DecisionOrchestrator } from '../agents/decision-orchestrator.js';
import { ExecutionAgent } from '../agents/execution-agent.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';
import { ApprovalService } from '../telegram/approval-service.js';
import { buildContext } from './context-builder.js';
import { checkMarketOpen } from './safety-gates.js';
import { getOrCreateSession } from '../db/repositories/sessions.js';
import { insertSignalSnapshot } from '../db/repositories/signals.js';
import { insertDecision } from '../db/repositories/decisions.js';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import type { TradingProfile } from '../types/market.js';
import type { DecisionType, DecisionResult, PositionContext } from '../types/decision.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { SizeResult } from '../types/trade.js';
import type { ApprovalOutcome } from '../telegram/approval-service.js';

/**
 * Returns a fully-formed WAIT without calling any AI.
 * Used when confidence is below threshold and there are no open positions to manage.
 */
function deterministicWait(
  signal: SignalPayload,
  analysis: AnalysisResult,
  ticker: string,
  profile: TradingProfile,
): DecisionResult {
  return {
    id: uuidv4(),
    signalId: signal.id,
    decisionType: 'WAIT',
    ticker,
    profile,
    confirmationCount: 0,
    orchestrationConfidence: analysis.confidence,
    reasoning: `Confidence ${(analysis.confidence * 100).toFixed(0)}% < threshold ${(config.MIN_CONFIDENCE * 100).toFixed(0)}% — no open positions to manage. AI orchestration skipped.`,
    urgency: 'low',
    shouldExecute: false,
    entryStrategy: {
      stage: 'NOT_APPLICABLE',
      confirmationCount: 0,
      signalDirection: null,
      confirmationsNeeded: 3,
      overrideTriggered: false,
      notes: 'Below threshold with no active positions.',
    },
    createdAt: new Date().toISOString(),
  };
}

/** True when AI orchestration is required */
function needsAIOrchestration(analysis: AnalysisResult, context: PositionContext): boolean {
  const hasOpenPositions = context.openPositions.length > 0;
  const hasActiveStreak  = context.confirmationStreaks.length > 0;
  return analysis.meetsEntryThreshold || hasOpenPositions || hasActiveStreak;
}

export interface PipelineResult {
  ticker: string;
  profile: TradingProfile;
  direction: string;
  alignment: string;
  confidence: number;
  decision: DecisionType;
  reasoning: string;
  orderSubmitted: boolean;
  orderSymbol?: string;
  orderQty?: number;
  orderPrice?: number;
  failedGates?: string[];
  // Human approval (only set when decision was NEW_ENTRY and human gate triggered)
  humanApprovalOutcome?: ApprovalOutcome;
  // Full context for rich notifications
  signal?: SignalPayload;
  option?: OptionEvaluation;
  analysis?: AnalysisResult;
  decisionResult?: DecisionResult;
  sizing?: SizeResult;
  error?: string;
}

const signalAgent          = new SignalAgent();
const optionAgent          = new OptionAgent();
const analysisAgent        = new AnalysisAgent();
const decisionOrchestrator = new DecisionOrchestrator();
const executionAgent       = new ExecutionAgent();

/**
 * The main trading pipeline — runs end-to-end for one ticker + profile.
 * Returns a structured result suitable for Telegram notification.
 *
 * NEW_ENTRY / ADD_POSITION:
 *   ExecutionAgent.prepareEntry() checks safety gates using the orchestrator's
 *   DecisionResult as primary input.  On pass, the pipeline creates a dedicated
 *   OrderAgent via OrderAgentRegistry.  The agent owns the full lifecycle from
 *   that point (fill monitoring, stop/TP, expiry, evaluation).
 *
 * EXIT / REDUCE_EXPOSURE / REVERSE:
 *   Pipeline delegates to OrderAgentRegistry which dispatches to the correct
 *   per-position agents.  No direct Alpaca calls from the pipeline.
 */
export async function runPipeline(
  ticker: string,
  profile: TradingProfile,
  trigger: 'AUTO' | 'MANUAL'
): Promise<PipelineResult> {
  console.log(`[Pipeline] Starting: ${ticker} ${profile} (${trigger})`);

  try {
    // ── Phase 1: Session ───────────────────────────────────────────────────
    const intervals = profile === 'S' ? '2m,3m,5m' : profile === 'M' ? '1m,5m,15m' : '5m,1h,1d';
    const sessionId = await getOrCreateSession(ticker, profile, intervals);

    // ── Phase 2: Signal Generation ─────────────────────────────────────────
    const signal = await signalAgent.run(ticker, profile, trigger, sessionId);
    console.log(`[Pipeline] Signal: ${signal.direction} (${signal.alignment})`);

    // ── Phase 3: Option Selection ──────────────────────────────────────────
    const optionEval = await optionAgent.run(signal);
    console.log(`[Pipeline] Option: winner=${optionEval.winner ?? 'none'}, liq=${optionEval.liquidityOk}`);

    // ── Phase 4: Analysis (deterministic confidence + AI explanation) ──────
    const analysis = await analysisAgent.run(signal, optionEval);
    console.log(`[Pipeline] Analysis: confidence=${analysis.confidence.toFixed(2)}, threshold=${analysis.meetsEntryThreshold}`);

    // ── Phase 5: Persist Signal Snapshot ──────────────────────────────────
    const snapshotId = await insertSignalSnapshot(signal, optionEval, analysis, sessionId);
    signal.id = snapshotId;

    // ── Phase 6: Check Market Hours ────────────────────────────────────────
    const timeGateOk = await checkMarketOpen();

    // ── Phase 7: Build Orchestrator Context ────────────────────────────────
    const context = await buildContext(ticker);

    // ── Phase 8: Decision Orchestrator (or deterministic bypass) ──────────
    const useAI = needsAIOrchestration(analysis, context);
    const decision = useAI
      ? await decisionOrchestrator.run({ signal, option: optionEval, analysis, context, timeGateOk })
      : deterministicWait(signal, analysis, ticker, profile);
    console.log(`[Pipeline] Decision: ${decision.decisionType} (execute=${decision.shouldExecute}${useAI ? '' : ', deterministic'})`);

    await insertDecision(decision);

    // ── Phase 9: Execute via OrderAgentRegistry ────────────────────────────
    const result: PipelineResult = {
      ticker,
      profile,
      direction:   signal.direction,
      alignment:   signal.alignment,
      confidence:  analysis.confidence,
      decision:    decision.decisionType,
      reasoning:   decision.reasoning,
      orderSubmitted: false,
      signal,
      option:      optionEval,
      analysis,
      decisionResult: decision,
    };

    const registry = OrderAgentRegistry.getInstance();

    switch (decision.decisionType) {

      // ── NEW ENTRY / ADD ────────────────────────────────────────────────
      case 'NEW_ENTRY':
      case 'ADD_POSITION': {
        if (!decision.shouldExecute) break;

        // Code-level guard: NEW_ENTRY is only valid when no positions are open
        // for this ticker. If the AI returns NEW_ENTRY with open positions it is
        // an error — use ADD_POSITION to intentionally scale, or CONFIRM_HOLD to hold.
        if (decision.decisionType === 'NEW_ENTRY' && context.openPositions.length > 0) {
          console.warn(
            `[Pipeline] NEW_ENTRY blocked — ${context.openPositions.length} open position(s) ` +
            `already exist for ${ticker}. AI should use ADD_POSITION to scale or CONFIRM_HOLD to hold.`,
          );
          break;
        }

        // ExecutionAgent receives the orchestrator's DecisionResult as its
        // primary input and computes sizing + runs 8 safety gates.
        // No Alpaca calls here — only gate validation.
        const { sizing, passed, failedGates } = executionAgent.prepareEntry({
          decision,
          signal,
          option:             optionEval,
          analysis,
          accountEquity:      context.accountEquity,
          accountBuyingPower: context.accountBuyingPower,
          dailyRealizedPnl:   context.dailyRealizedPnl,
          timeGateOk,
        });

        if (!passed || !sizing || !optionEval.winnerCandidate) {
          result.failedGates = failedGates;
          break;
        }

        // ── Human Approval Gate ────────────────────────────────────────────
        // Send a Telegram message with Approve / Deny buttons and wait for
        // human confirmation before submitting any Alpaca order.
        const approvalOutcome = await ApprovalService.getInstance().requestApproval({
          decision,
          candidate: optionEval.winnerCandidate,
          sizing,
          confidence: analysis.confidence,
        });
        result.humanApprovalOutcome = approvalOutcome;

        if (approvalOutcome !== 'approved') {
          console.log(`[Pipeline] NEW_ENTRY blocked by human (${approvalOutcome}) for ${ticker}`);
          break;
        }

        // Spawn a dedicated OrderAgent.  Primary input is `decision` (the
        // orchestrator AI output).  The agent submits the Alpaca entry order,
        // persists position + order records, and manages the full lifecycle.
        const positionId = await registry.createAndStart({
          decision,                               // orchestrator AI output
          candidate:       optionEval.winnerCandidate,
          sizing,
          sessionId,
          entryConfidence: analysis.confidence,   // AnalysisAgent deterministic score
          entryAlignment:  signal.alignment,
          entryDirection:  signal.direction,
        });

        result.orderSubmitted = !!positionId;
        result.orderSymbol    = optionEval.winnerCandidate.contract.symbol;
        result.orderQty       = sizing.qty;
        result.orderPrice     = sizing.limitPrice;
        result.sizing         = sizing;
        break;
      }

      // ── CONFIRM HOLD ──────────────────────────────────────────────────
      case 'CONFIRM_HOLD': {
        // Active agents continue monitoring; no new order needed.
        const activeAgents = registry.getByTicker(ticker);
        console.log(
          `[Pipeline] CONFIRM_HOLD — ${activeAgents.length} active agent(s) continuing for ${ticker}`,
        );
        break;
      }

      // ── EXIT ──────────────────────────────────────────────────────────
      case 'EXIT': {
        // Forward to agents as a suggestion — each agent evaluates through
        // its own position-management rules (may override if not immediate).
        await registry.notifyExit(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.urgency,
        );
        result.orderSubmitted = true;
        break;
      }

      // ── REDUCE EXPOSURE ───────────────────────────────────────────────
      case 'REDUCE_EXPOSURE': {
        await registry.notifyReduce(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.urgency,
        );
        result.orderSubmitted = true;
        break;
      }

      // ── REVERSE ───────────────────────────────────────────────────────
      case 'REVERSE': {
        // Step 1 — close existing positions via their agents (immediate — non-negotiable reversal).
        await registry.notifyExit(ticker, 'REVERSE: position direction change', 'immediate');

        // Step 2 — open new position in opposite direction.
        if (!decision.shouldExecute || !optionEval.winnerCandidate) break;

        const { sizing, passed } = executionAgent.prepareEntry({
          decision,
          signal,
          option:             optionEval,
          analysis,
          accountEquity:      context.accountEquity,
          accountBuyingPower: context.accountBuyingPower,
          dailyRealizedPnl:   context.dailyRealizedPnl,
          timeGateOk,
        });

        if (passed && sizing) {
          const positionId = await registry.createAndStart({
            decision,
            candidate:       optionEval.winnerCandidate,
            sizing,
            sessionId,
            entryConfidence: analysis.confidence,
            entryAlignment:  signal.alignment,
            entryDirection:  signal.direction,
          });
          result.orderSubmitted = !!positionId;
          result.sizing         = sizing;
        }
        break;
      }

      case 'WAIT':
      default:
        break;
    }

    console.log(`[Pipeline] Done: ${decision.decisionType}, submitted=${result.orderSubmitted}`);
    return result;

  } catch (err) {
    const message = (err as Error).message;
    console.error('[Pipeline] Error:', message);
    return {
      ticker,
      profile,
      direction: 'unknown',
      alignment: 'mixed',
      confidence: 0,
      decision: 'WAIT',
      reasoning: `Pipeline error: ${message}`,
      orderSubmitted: false,
      error: message,
    };
  }
}
