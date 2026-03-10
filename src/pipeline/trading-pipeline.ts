import { SignalAgent } from '../agents/signal-agent.js';
import { OptionAgent } from '../agents/option-agent.js';
import { AnalysisAgent } from '../agents/analysis-agent.js';
import { DecisionOrchestrator } from '../agents/decision-orchestrator.js';
import { ExecutionAgent } from '../agents/execution-agent.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';
import type { OrderAgentOutcome } from '../agents/order-agent.js';
import { ApprovalService } from '../telegram/approval-service.js';
import { fetchOptionMid } from '../lib/alpaca-api.js';
import { markApprovalStaleQuote } from '../db/repositories/human-approvals.js';
import { notifyStaleQuoteAbort } from '../telegram/notifier.js';
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

/** Abort entry if the option mid deviated more than this fraction from the original limit price. */
const STALE_QUOTE_ABORT_PCT = 0.15;

/**
 * Returns a fully-formed WAIT without calling any AI.
 * Used when there are no open positions to manage and either confidence is below threshold
 * or the time gate is closed (market hours check failed).
 */
function deterministicWait(
  signal: SignalPayload,
  analysis: AnalysisResult,
  ticker: string,
  profile: TradingProfile,
  timeGateOk: boolean,
  sessionId: string,
): DecisionResult {
  const confPct = (analysis.confidence * 100).toFixed(0);
  const threshPct = (config.MIN_CONFIDENCE * 100).toFixed(0);
  const reason = !timeGateOk
    ? `Market closed (time gate) — no open positions to manage. AI orchestration skipped. (Confidence ${confPct}%, threshold ${threshPct}%)`
    : `Confidence ${confPct}% < threshold ${threshPct}% — no open positions to manage. AI orchestration skipped.`;
  return {
    id: uuidv4(),
    signalId: signal.id,
    sessionId,
    decisionType: 'WAIT',
    ticker,
    profile,
    direction: signal.direction,
    confirmationCount: 0,
    orchestrationConfidence: analysis.confidence,
    reasoning: reason,
    urgency: 'low',
    shouldExecute: false,
    entryStrategy: {
      stage: 'NOT_APPLICABLE',
      confirmationCount: 0,
      signalDirection: null,
      confirmationsNeeded: 3,
      overrideTriggered: false,
      notes: !timeGateOk ? 'Market closed with no active positions.' : 'Below threshold with no active positions.',
    },
    createdAt: new Date().toISOString(),
  };
}

/** True when AI orchestration is required */
function needsAIOrchestration(analysis: AnalysisResult, context: PositionContext, timeGateOk: boolean, hasActiveAgents: boolean): boolean {
  const hasOpenPositions = context.openPositions.length > 0;
  const hasActiveStreak  = context.confirmationStreaks.length > 0;
  // When market is closed, only run AI if there are positions to manage — not for potential new entries.
  // hasActiveAgents guards against DB lag: if the in-memory registry already has a MONITORING/AWAITING_FILL
  // agent, we must always run AI so every new signal reaches that agent regardless of confidence level.
  return (analysis.meetsEntryThreshold && timeGateOk) || hasOpenPositions || hasActiveStreak || hasActiveAgents;
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
  // Order agent outcomes (set for EXIT / REDUCE_EXPOSURE decisions)
  orderAgentOutcomes?: OrderAgentOutcome[];
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
    // ── Phase 1: Market hours (cheap — determines whether AI calls are needed) ─
    const timeGateOk = await checkMarketOpen();

    // ── Phase 2: Session ───────────────────────────────────────────────────
    const intervals = profile === 'S' ? '2m,3m,5m' : profile === 'M' ? '1m,5m,15m' : '5m,1h,1d';
    const sessionId = await getOrCreateSession(ticker, profile, intervals);

    // ── Phase 3: Signal Generation ─────────────────────────────────────────
    const signal = await signalAgent.run(ticker, profile, trigger, sessionId);
    console.log(`[Pipeline] Signal: ${signal.direction} (${signal.alignment})`);

    // ── Phase 4: Option Selection ──────────────────────────────────────────
    const optionEval = await optionAgent.run(signal);
    console.log(`[Pipeline] Option: winner=${optionEval.winner ?? 'none'}, liq=${optionEval.liquidityOk}`);

    // ── Phase 5: Analysis (deterministic confidence; AI explanation only when market open) ──
    const analysis = await analysisAgent.run(signal, optionEval, timeGateOk);
    console.log(`[Pipeline] Analysis: confidence=${analysis.confidence.toFixed(2)}, threshold=${analysis.meetsEntryThreshold}`);
    if (analysis.confidenceBreakdown) {
      const cb = analysis.confidenceBreakdown;
      console.log(`[Pipeline] ConfBreakdown[${ticker}]: base=${cb.base.toFixed(2)} di=${cb.diSpreadBonus.toFixed(3)} adx=${cb.adxBonus.toFixed(2)} cross=${cb.diCrossBonus.toFixed(3)} align=${cb.alignmentBonus.toFixed(2)} td=${cb.tdAdjustment.toFixed(3)} obv=${cb.obvBonus.toFixed(3)} vwap=${cb.vwapBonus.toFixed(3)} oiVol=${cb.oiVolumeBonus.toFixed(3)} pos=${cb.pricePositionAdjustment.toFixed(3)} maturity=${cb.adxMaturityPenalty.toFixed(3)} struct=${cb.structureBonus.toFixed(3)} orb=${cb.orbBonus.toFixed(3)}`);
    }

    // ── Phase 6: Persist Signal Snapshot ──────────────────────────────────
    const snapshotId = await insertSignalSnapshot(signal, optionEval, analysis, sessionId);
    signal.id = snapshotId;

    // ── Phase 6: Build Orchestrator Context ────────────────────────────────
    const context = await buildContext(ticker);

    // ── Phase 7: Decision Orchestrator (or deterministic bypass) ──────────
    const registry = OrderAgentRegistry.getInstance();
    const hasActiveAgents = registry.getByTicker(ticker).some(
      a => a.getPhase() === 'MONITORING' || a.getPhase() === 'AWAITING_FILL',
    );
    const useAI = needsAIOrchestration(analysis, context, timeGateOk, hasActiveAgents);
    const decision = useAI
      ? await decisionOrchestrator.run({ signal, option: optionEval, analysis, context, timeGateOk })
      : deterministicWait(signal, analysis, ticker, profile, timeGateOk, sessionId);
    console.log(`[Pipeline] Decision: ${decision.decisionType} (execute=${decision.shouldExecute}${useAI ? '' : ', deterministic'})`);

    await insertDecision(decision);

    // ── Market context forwarded to order agents ────────────────────────────
    // Structured indicator data so agents can judge whether a P&L dip is
    // temporary (trend still intact) or terminal (trend reversed / confidence collapsed).
    const marketContext = {
      direction:     signal.direction,
      alignment:     signal.alignment,
      strengthScore: signal.strengthScore,
      keyFactors:    analysis.keyFactors.slice(0, 3),
      risks:         analysis.risks.slice(0, 2),
    } as const;

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

    switch (decision.decisionType) {

      // ── NEW ENTRY ─────────────────────────────────────────────────────
      case 'NEW_ENTRY': {
        if (!decision.shouldExecute) break;

        // Guard: NEW_ENTRY is only valid when no positions are open for this ticker.
        if (context.openPositions.length > 0) {
          console.warn(
            `[Pipeline] NEW_ENTRY blocked — ${context.openPositions.length} open position(s) ` +
            `already exist for ${ticker}. AI should use ADD_POSITION to scale or CONFIRM_HOLD to hold.`,
          );
          break;
        }

        const { sizing: newSizing, passed: newPassed, failedGates: newFailed } = executionAgent.prepareEntry({
          decision, signal, option: optionEval, analysis,
          accountEquity: context.accountEquity, accountBuyingPower: context.accountBuyingPower,
          dailyRealizedPnl: context.dailyRealizedPnl, timeGateOk,
        });
        if (!newPassed || !newSizing || !optionEval.winnerCandidate) {
          result.failedGates = newFailed; break;
        }

        const { outcome: newOutcome, approvalId: newApprovalId } = await ApprovalService.getInstance().requestApproval({
          decision, candidate: optionEval.winnerCandidate, sizing: newSizing, confidence: analysis.confidence,
        });
        result.humanApprovalOutcome = newOutcome;
        if (newOutcome !== 'approved') {
          console.log(`[Pipeline] NEW_ENTRY blocked by human (${newOutcome}) for ${ticker}`); break;
        }

        // Re-quote after approval — the quote may be up to 2 minutes stale.
        // If price deviated > STALE_QUOTE_ABORT_PCT, abort to avoid a bad entry.
        const newFreshMid = await fetchOptionMid(optionEval.winnerCandidate.contract.symbol);
        if (newFreshMid !== null) {
          const newDev = (newFreshMid - newSizing.limitPrice) / newSizing.limitPrice;
          if (Math.abs(newDev) > STALE_QUOTE_ABORT_PCT) {
            const originalPrice = newSizing.limitPrice;
            console.warn(
              `[Pipeline] NEW_ENTRY aborted — quote stale after approval: ` +
              `limit=$${originalPrice} mid=$${newFreshMid.toFixed(2)} ` +
              `dev=${(newDev * 100).toFixed(1)}%`,
            );
            result.failedGates = [`STALE_QUOTE: price moved ${(newDev * 100).toFixed(1)}% since signal`];
            // Persist abort in DB and notify Telegram
            markApprovalStaleQuote(newApprovalId, originalPrice, newFreshMid, newDev).catch(() => {});
            notifyStaleQuoteAbort({
              ticker,
              decisionType: decision.decisionType,
              optionSymbol: optionEval.winnerCandidate.contract.symbol,
              originalPrice,
              freshMid: newFreshMid,
              devPct: newDev,
            }).catch(() => {});
            break;
          }
          newSizing.limitPrice = Math.round(newFreshMid * 100) / 100;
          console.log(
            `[Pipeline] NEW_ENTRY quote refreshed: $${newSizing.limitPrice} (dev=${(newDev * 100).toFixed(1)}%)`,
          );
        } else {
          console.warn(
            `[Pipeline] NEW_ENTRY: fetchOptionMid returned null for ${optionEval.winnerCandidate.contract.symbol}` +
            ` — proceeding with original price $${newSizing.limitPrice} (stale check skipped)`,
          );
        }

        const newPositionId = await registry.createAndStart({
          decision, candidate: optionEval.winnerCandidate, sizing: newSizing, sessionId,
          entryConfidence: analysis.confidence, entryAlignment: signal.alignment, entryDirection: signal.direction,
        });
        if (!newPositionId) {
          console.warn(`[Pipeline] NEW_ENTRY: registry.createAndStart returned empty — position cap reached or agent.start() failed for ${ticker}`);
          break;
        }
        result.orderSubmitted = true;
        result.orderSymbol    = optionEval.winnerCandidate.contract.symbol;
        result.orderQty       = newSizing.qty;
        result.orderPrice     = newSizing.limitPrice;
        result.sizing         = newSizing;
        break;
      }

      // ── ADD POSITION ──────────────────────────────────────────────────
      // Orchestrator suggests scaling in.  Existing agents evaluate first —
      // if any agent vetoes (EXIT/REDUCE = position struggling), the add is blocked.
      // Only if agents agree (HOLD = position healthy) does the pipeline create a new agent.
      case 'ADD_POSITION': {
        if (!decision.shouldExecute) break;

        const { sizing: addSizing, passed: addPassed, failedGates: addFailed } = executionAgent.prepareEntry({
          decision, signal, option: optionEval, analysis,
          accountEquity: context.accountEquity, accountBuyingPower: context.accountBuyingPower,
          dailyRealizedPnl: context.dailyRealizedPnl, timeGateOk,
        });
        if (!addPassed || !addSizing || !optionEval.winnerCandidate) {
          result.failedGates = addFailed; break;
        }

        // Consult existing agents — they make the final scale-in decision.
        const addOutcomes = await registry.notifyAddPosition(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.orchestrationConfidence,
          marketContext,
        );
        if (addOutcomes.length) result.orderAgentOutcomes = addOutcomes;

        const vetoed = addOutcomes.some(o => o.action === 'EXIT' || o.action === 'REDUCE');
        if (vetoed) {
          console.log(`[Pipeline] ADD_POSITION blocked — existing agent vetoed scale-in for ${ticker}`);
          break;
        }

        const { outcome: addOutcome, approvalId: addApprovalId } = await ApprovalService.getInstance().requestApproval({
          decision, candidate: optionEval.winnerCandidate, sizing: addSizing, confidence: analysis.confidence,
        });
        result.humanApprovalOutcome = addOutcome;
        if (addOutcome !== 'approved') {
          console.log(`[Pipeline] ADD_POSITION blocked by human (${addOutcome}) for ${ticker}`); break;
        }

        // Re-quote after approval — the quote may be up to 2 minutes stale.
        const addFreshMid = await fetchOptionMid(optionEval.winnerCandidate.contract.symbol);
        if (addFreshMid !== null) {
          const addDev = (addFreshMid - addSizing.limitPrice) / addSizing.limitPrice;
          if (Math.abs(addDev) > STALE_QUOTE_ABORT_PCT) {
            const addOriginalPrice = addSizing.limitPrice;
            console.warn(
              `[Pipeline] ADD_POSITION aborted — quote stale after approval: ` +
              `limit=$${addOriginalPrice} mid=$${addFreshMid.toFixed(2)} ` +
              `dev=${(addDev * 100).toFixed(1)}%`,
            );
            result.failedGates = [`STALE_QUOTE: price moved ${(addDev * 100).toFixed(1)}% since signal`];
            markApprovalStaleQuote(addApprovalId, addOriginalPrice, addFreshMid, addDev).catch(() => {});
            notifyStaleQuoteAbort({
              ticker,
              decisionType: decision.decisionType,
              optionSymbol: optionEval.winnerCandidate.contract.symbol,
              originalPrice: addOriginalPrice,
              freshMid: addFreshMid,
              devPct: addDev,
            }).catch(() => {});
            break;
          }
          addSizing.limitPrice = Math.round(addFreshMid * 100) / 100;
          console.log(
            `[Pipeline] ADD_POSITION quote refreshed: $${addSizing.limitPrice} (dev=${(addDev * 100).toFixed(1)}%)`,
          );
        } else {
          console.warn(
            `[Pipeline] ADD_POSITION: fetchOptionMid returned null for ${optionEval.winnerCandidate.contract.symbol}` +
            ` — proceeding with original price $${addSizing.limitPrice} (stale check skipped)`,
          );
        }

        const addPositionId = await registry.createAndStart({
          decision, candidate: optionEval.winnerCandidate, sizing: addSizing, sessionId,
          entryConfidence: analysis.confidence, entryAlignment: signal.alignment, entryDirection: signal.direction,
        });
        if (!addPositionId) {
          console.warn(`[Pipeline] ADD_POSITION: registry.createAndStart returned empty — position cap reached or agent.start() failed for ${ticker}`);
          break;
        }
        result.orderSubmitted = true;
        result.orderSymbol    = optionEval.winnerCandidate.contract.symbol;
        result.orderQty       = addSizing.qty;
        result.orderPrice     = addSizing.limitPrice;
        result.sizing         = addSizing;
        break;
      }

      // ── CONFIRM HOLD ──────────────────────────────────────────────────
      case 'CONFIRM_HOLD': {
        // Forward to active agents as a suggestion — each agent acknowledges
        // and sends its own Telegram notification.  No AI evaluation triggered.
        const confirmOutcomes = await registry.notifyConfirmHold(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.orchestrationConfidence,
          marketContext,
        );
        if (confirmOutcomes.length) result.orderAgentOutcomes = confirmOutcomes;
        console.log(
          `[Pipeline] CONFIRM_HOLD — forwarded to ${confirmOutcomes.length} agent(s) for ${ticker}`,
        );
        break;
      }

      // ── EXIT ──────────────────────────────────────────────────────────
      case 'EXIT': {
        // Forward to agents as a suggestion — each agent evaluates through
        // its own position-management rules (may override if not immediate).
        const exitOutcomes = await registry.notifyExit(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.urgency,
          decision.orchestrationConfidence,
          marketContext,
        );
        // Only mark submitted when at least one agent responded — empty outcomes
        // means all agents were already CLOSED (position closed by the 30 s tick
        // racing ahead of the pipeline), so nothing was actually dispatched.
        result.orderSubmitted = exitOutcomes.length > 0;
        if (exitOutcomes.length) result.orderAgentOutcomes = exitOutcomes;
        break;
      }

      // ── REDUCE EXPOSURE ───────────────────────────────────────────────
      case 'REDUCE_EXPOSURE': {
        const reduceOutcomes = await registry.notifyReduce(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.urgency,
          decision.orchestrationConfidence,
          marketContext,
        );
        result.orderSubmitted = reduceOutcomes.length > 0;
        if (reduceOutcomes.length) result.orderAgentOutcomes = reduceOutcomes;
        break;
      }

      // ── REVERSE ───────────────────────────────────────────────────────
      // Orchestrator suggests reversing direction.  Forward to existing agents as a
      // suggestion — each agent makes its own AI decision (EXIT = agree to reverse,
      // HOLD = refuse reversal because position is running well).
      // A new opposite-direction position is created only if at least one agent exited
      // (or there were no active agents).
      case 'REVERSE': {
        const reverseOutcomes = await registry.notifyReverse(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.urgency,
          decision.orchestrationConfidence,
          marketContext,
        );
        if (reverseOutcomes.length) result.orderAgentOutcomes = reverseOutcomes;

        // Check whether any agent actually exited (agreed to reverse)
        const anyExited   = reverseOutcomes.some(o => o.action === 'EXIT');
        const noAgents    = reverseOutcomes.length === 0;
        const shouldOpen  = (anyExited || noAgents) && decision.shouldExecute && !!optionEval.winnerCandidate;

        if (!shouldOpen) {
          console.log(
            `[Pipeline] REVERSE — no agents exited, skipping new position for ${ticker}`,
          );
          break;
        }

        const { sizing: revSizing, passed: revPassed, failedGates: revFailed } = executionAgent.prepareEntry({
          decision, signal, option: optionEval, analysis,
          accountEquity: context.accountEquity, accountBuyingPower: context.accountBuyingPower,
          dailyRealizedPnl: context.dailyRealizedPnl, timeGateOk,
        });
        if (!revPassed || !revSizing || !optionEval.winnerCandidate) {
          result.failedGates = revFailed; break;
        }

        // Human approval gate — REVERSE opens a new position and deserves the
        // same oversight as NEW_ENTRY / ADD_POSITION.
        const { outcome: revOutcome, approvalId: revApprovalId } = await ApprovalService.getInstance().requestApproval({
          decision, candidate: optionEval.winnerCandidate, sizing: revSizing, confidence: analysis.confidence,
        });
        result.humanApprovalOutcome = revOutcome;
        if (revOutcome !== 'approved') {
          console.log(`[Pipeline] REVERSE blocked by human (${revOutcome}) for ${ticker}`); break;
        }

        // Re-quote after approval — the quote may be up to 2 minutes stale.
        const revFreshMid = await fetchOptionMid(optionEval.winnerCandidate.contract.symbol);
        if (revFreshMid !== null) {
          const revDev = (revFreshMid - revSizing.limitPrice) / revSizing.limitPrice;
          if (Math.abs(revDev) > STALE_QUOTE_ABORT_PCT) {
            const revOriginalPrice = revSizing.limitPrice;
            console.warn(
              `[Pipeline] REVERSE aborted — quote stale after approval: ` +
              `limit=$${revOriginalPrice} mid=$${revFreshMid.toFixed(2)} ` +
              `dev=${(revDev * 100).toFixed(1)}%`,
            );
            result.failedGates = [`STALE_QUOTE: price moved ${(revDev * 100).toFixed(1)}% since signal`];
            markApprovalStaleQuote(revApprovalId, revOriginalPrice, revFreshMid, revDev).catch(() => {});
            notifyStaleQuoteAbort({
              ticker,
              decisionType: decision.decisionType,
              optionSymbol: optionEval.winnerCandidate.contract.symbol,
              originalPrice: revOriginalPrice,
              freshMid: revFreshMid,
              devPct: revDev,
            }).catch(() => {});
            break;
          }
          revSizing.limitPrice = Math.round(revFreshMid * 100) / 100;
          console.log(
            `[Pipeline] REVERSE quote refreshed: $${revSizing.limitPrice} (dev=${(revDev * 100).toFixed(1)}%)`,
          );
        } else {
          console.warn(
            `[Pipeline] REVERSE: fetchOptionMid returned null for ${optionEval.winnerCandidate.contract.symbol}` +
            ` — proceeding with original price $${revSizing.limitPrice} (stale check skipped)`,
          );
        }

        const revPositionId = await registry.createAndStart({
          decision, candidate: optionEval.winnerCandidate, sizing: revSizing, sessionId,
          entryConfidence: analysis.confidence, entryAlignment: signal.alignment, entryDirection: signal.direction,
        });
        if (!revPositionId) {
          console.warn(`[Pipeline] REVERSE: registry.createAndStart returned empty — position cap reached or agent.start() failed for ${ticker}`);
          break;
        }
        result.orderSubmitted = true;
        result.orderSymbol    = optionEval.winnerCandidate.contract.symbol;
        result.orderQty       = revSizing.qty;
        result.orderPrice     = revSizing.limitPrice;
        result.sizing         = revSizing;
        break;
      }

      case 'WAIT':
      default: {
        // Even on WAIT, existing positions need an AI evaluation.
        // Forward to monitoring agents so each agent makes its own final call
        // (may EXIT, REDUCE, or ADJUST_STOP independent of the pipeline's WAIT).
        const waitOutcomes = await registry.notifyWait(
          ticker,
          decision.reasoning.slice(0, 150),
          decision.orchestrationConfidence,
          marketContext,
        );
        if (waitOutcomes.length) result.orderAgentOutcomes = waitOutcomes;
        if (waitOutcomes.length) {
          console.log(`[Pipeline] WAIT — triggered AI eval for ${waitOutcomes.length} agent(s) for ${ticker}`);
        }
        break;
      }
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
