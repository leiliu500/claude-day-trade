import { SignalAgent } from '../agents/signal-agent.js';
import { OptionAgent } from '../agents/option-agent.js';
import { AnalysisAgent } from '../agents/analysis-agent.js';
import { DecisionOrchestrator } from '../agents/decision-orchestrator.js';
import { ExecutionAgent } from '../agents/execution-agent.js';
import { EvaluationAgent } from '../agents/evaluation-agent.js';
import { buildContext } from './context-builder.js';
import { checkMarketOpen } from './safety-gates.js';
import { getOrCreateSession } from '../db/repositories/sessions.js';
import { insertSignalSnapshot } from '../db/repositories/signals.js';
import { insertDecision } from '../db/repositories/decisions.js';
import { insertPosition, closePosition, getActivePositions } from '../db/repositories/positions.js';
import { insertOrder } from '../db/repositories/orders.js';
import { insertEvaluation } from '../db/repositories/evaluations.js';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import type { TradingProfile } from '../types/market.js';
import type { DecisionType, DecisionResult, PositionContext } from '../types/decision.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { SizeResult } from '../types/trade.js';

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
  const hasOpenPositions  = context.openPositions.length > 0;
  const hasActiveStreak   = context.confirmationStreaks.length > 0;
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
  // Full context for rich notifications
  signal?: SignalPayload;
  option?: OptionEvaluation;
  analysis?: AnalysisResult;
  decisionResult?: DecisionResult;
  sizing?: SizeResult;
  error?: string;
}

const signalAgent = new SignalAgent();
const optionAgent = new OptionAgent();
const analysisAgent = new AnalysisAgent();
const decisionOrchestrator = new DecisionOrchestrator();
const executionAgent = new ExecutionAgent();
const evaluationAgent = new EvaluationAgent();

/**
 * The main trading pipeline — runs end-to-end for one ticker + profile.
 * Returns a structured result suitable for Telegram notification.
 */
export async function runPipeline(
  ticker: string,
  profile: TradingProfile,
  trigger: 'AUTO' | 'MANUAL'
): Promise<PipelineResult> {
  console.log(`[Pipeline] Starting: ${ticker} ${profile} (${trigger})`);

  try {
    // ── Phase 1: Session ───────────────────────────────────────────────────
    const intervals = ['S', 'M', 'L'].indexOf(profile) === 0
      ? '2m,3m,5m' : profile === 'M' ? '1m,5m,15m' : '5m,1h,1d';
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
    signal.id = snapshotId; // Use DB ID as signal ID for downstream references

    // ── Phase 6: Check Market Hours ────────────────────────────────────────
    const timeGateOk = await checkMarketOpen();

    // ── Phase 7: Build Orchestrator Context ────────────────────────────────
    const context = await buildContext(ticker);

    // ── Phase 8: Decision Orchestrator (or deterministic bypass) ──────────
    // Skip gpt-4o when: confidence below threshold + no open positions + no active streak.
    // This covers the vast majority of 5-min AUTO ticks on calm markets.
    const useAI = needsAIOrchestration(analysis, context);
    const decision = useAI
      ? await decisionOrchestrator.run({ signal, option: optionEval, analysis, context, timeGateOk })
      : deterministicWait(signal, analysis, ticker, profile);
    console.log(`[Pipeline] Decision: ${decision.decisionType} (execute=${decision.shouldExecute}${useAI ? '' : ', deterministic'})`);

    // Persist decision
    await insertDecision(decision);

    // ── Phase 9: Execute ────────────────────────────────────────────────────
    const result: PipelineResult = {
      ticker,
      profile,
      direction: signal.direction,
      alignment: signal.alignment,
      confidence: analysis.confidence,
      decision: decision.decisionType,
      reasoning: decision.reasoning,
      orderSubmitted: false,
      // Full context for rich notifications
      signal,
      option: optionEval,
      analysis,
      decisionResult: decision,
    };

    switch (decision.decisionType) {
      case 'NEW_ENTRY':
      case 'ADD_POSITION': {
        if (!decision.shouldExecute) break;

        const { order, sizing, failedGates } = await executionAgent.executeEntry({
          decision,
          signal,
          option: optionEval,
          analysis,
          accountEquity: context.accountEquity,
          accountBuyingPower: context.accountBuyingPower,
          timeGateOk,
        });

        if (order) {
          // Persist position and order
          const positionId = await insertPosition({
            sessionId,
            decisionId: decision.id,
            ticker,
            candidate: optionEval.winnerCandidate!,
            sizing: sizing!,
          });
          order.positionId = positionId;
          await insertOrder(order);

          result.orderSubmitted = true;
          result.orderSymbol = optionEval.winnerCandidate?.contract.symbol;
          result.orderQty = sizing?.qty;
          result.orderPrice = sizing?.limitPrice;
          result.sizing = sizing ?? undefined;
        } else {
          result.failedGates = failedGates;
        }
        break;
      }

      case 'CONFIRM_HOLD': {
        // Record a confirmation for existing open decision
        const latestOpenDecision = context.recentDecisions.find(d =>
          d.decisionType === 'NEW_ENTRY' || d.decisionType === 'ADD_POSITION'
        );
        if (latestOpenDecision) {
          // We can't easily get the decision ID from summary — skip for now
          // In a full impl we'd store the decision ID in context
        }
        break;
      }

      case 'EXIT': {
        // Close all open positions for this ticker
        const openPositions = await getActivePositions(ticker);
        for (const pos of openPositions) {
          const order = await executionAgent.executeExit({
            decision,
            optionSymbol: pos.option_symbol,
          });

          order.positionId = pos.id;
          await insertOrder(order);

          // Only mark DB position as closed if Alpaca accepted the order
          if (order.alpacaStatus !== 'error') {
            const exitPrice  = order.fillPrice ?? optionEval.winnerCandidate?.contract.mid ?? 0;
            const closeReason = `EXIT: ${decision.reasoning.slice(0, 100)}`;
            await closePosition({ positionId: pos.id, exitPrice, closeReason });
            await triggerEvaluation(pos, decision.id, analysis.confidence, signal, exitPrice, closeReason);
          } else {
            console.warn(`[Pipeline] EXIT order failed for ${pos.option_symbol} — position left OPEN in DB`);
          }
        }
        result.orderSubmitted = openPositions.length > 0;
        break;
      }

      case 'REDUCE_EXPOSURE': {
        const openPositions = await getActivePositions(ticker);
        for (const pos of openPositions) {
          const reduceQty = Math.max(1, Math.floor(pos.qty / 2));
          const order = await executionAgent.executeReduce({
            decision,
            optionSymbol: pos.option_symbol,
            qty: reduceQty,
          });
          await insertOrder(order);
        }
        result.orderSubmitted = openPositions.length > 0;
        break;
      }

      case 'REVERSE': {
        // Close existing + re-enter opposite side
        const openPositions = await getActivePositions(ticker);
        for (const pos of openPositions) {
          const exitOrder = await executionAgent.executeExit({
            decision,
            optionSymbol: pos.option_symbol,
          });
          exitOrder.positionId = pos.id;
          await insertOrder(exitOrder);
          if (exitOrder.alpacaStatus !== 'error') {
            const reverseExitPrice = exitOrder.fillPrice ?? 0;
            await closePosition({ positionId: pos.id, exitPrice: reverseExitPrice, closeReason: 'REVERSE' });
            await triggerEvaluation(pos, decision.id, analysis.confidence, signal, reverseExitPrice, 'REVERSE');
          } else {
            console.warn(`[Pipeline] REVERSE exit failed for ${pos.option_symbol} — skipping re-entry`);
            break;
          }
        }
        // Re-enter in opposite direction (opposite is handled by optionEval.winner already flipped)
        if (optionEval.winnerCandidate) {
          const { order, sizing } = await executionAgent.executeEntry({
            decision,
            signal,
            option: optionEval,
            analysis,
            accountEquity: context.accountEquity,
            accountBuyingPower: context.accountBuyingPower,
            timeGateOk,
          });
          if (order && sizing) {
            const positionId = await insertPosition({
              sessionId,
              decisionId: decision.id,
              ticker,
              candidate: optionEval.winnerCandidate,
              sizing,
            });
            order.positionId = positionId;
            await insertOrder(order);
            result.orderSubmitted = true;
          }
        }
        break;
      }

      case 'WAIT':
      default:
        // Nothing to execute
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

/** Trigger post-trade evaluation after a position is closed */
async function triggerEvaluation(
  pos: Record<string, unknown>,
  decisionId: string,
  entryConfidence: number,
  signal: { direction: string; alignment: string },
  exitPrice: number,       // passed directly — pos.exit_price is null at call time
  closeReason: string,
): Promise<void> {
  try {
    const entryPrice = parseFloat(String(pos['entry_price'] ?? 0));
    const closedAt   = new Date().toISOString();

    if (exitPrice === 0) return;

    const evaluation = await evaluationAgent.evaluate({
      ticker: String(pos['ticker']),
      optionSymbol: String(pos['option_symbol']),
      side: pos['option_right'] as 'call' | 'put',
      strike: parseFloat(String(pos['strike'] ?? 0)),
      expiration: String(pos['expiration'] ?? ''),
      entryPrice,
      exitPrice,
      qty: parseInt(String(pos['qty'] ?? 1)),
      openedAt: String(pos['opened_at'] ?? new Date().toISOString()),
      closedAt,
      closeReason,
      entryConfidence,
      entryAlignment: signal.alignment,
      entryDirection: signal.direction,
      entryReasoning: String(pos['entry_reasoning'] ?? ''),
      positionId: String(pos['id']),
      decisionId,
    });

    await insertEvaluation(evaluation);
    console.log(`[Pipeline] Evaluation: ${evaluation.grade} (${evaluation.score}) — ${evaluation.lessonsLearned}`);
  } catch (err) {
    console.error('[Pipeline] Evaluation error:', err);
  }
}
