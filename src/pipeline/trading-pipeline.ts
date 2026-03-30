import { SignalAgent } from '../agents/signal-agent.js';
import { OptionAgent } from '../agents/option-agent.js';
import { AnalysisAgent } from '../agents/analysis-agent.js';
import { DecisionOrchestrator } from '../agents/decision-orchestrator.js';
import { ExecutionAgent } from '../agents/execution-agent.js';
import { OrderAgentRegistry } from '../agents/order-agent-registry.js';
import type { OrderAgentOutcome } from '../agents/order-agent.js';
import { buildContext } from './context-builder.js';
import { checkMarketOpen } from './safety-gates.js';
import { getOrCreateSession } from '../db/repositories/sessions.js';
import { insertSignalSnapshot } from '../db/repositories/signals.js';
import { insertDecision } from '../db/repositories/decisions.js';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { getTickerConfig, type TickerConfig } from '../ticker-configs.js';
import { fetchOptionMid } from '../lib/alpaca-api.js';
import type { TradingProfile } from '../types/market.js';
import type { DecisionType, DecisionResult, PositionContext } from '../types/decision.js';
import type { SignalPayload } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { AnalysisResult } from '../types/analysis.js';
import type { SizeResult } from '../types/trade.js';
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
  tickerCfg: TickerConfig,
): DecisionResult {
  const confPct = (analysis.confidence * 100).toFixed(0);
  const threshPct = (tickerCfg.minConfidence * 100).toFixed(0);
  const belowThreshold = analysis.confidence < tickerCfg.minConfidence;
  const reason = !timeGateOk
    ? `Market closed (time gate) — no open positions to manage. AI orchestration skipped. (Confidence ${confPct}%, threshold ${threshPct}%)`
    : belowThreshold
      ? `Confidence ${confPct}% < threshold ${threshPct}% — no open positions to manage. AI orchestration skipped.`
      : `Entry filter blocked: ${analysis.entryBlockReason ?? 'unknown'} (confidence ${confPct}% meets ${threshPct}% threshold) — no open positions to manage. AI orchestration skipped.`;
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

// ── Per-ticker agent instances ──────────────────────────────────────────────
// Each ticker gets its own DecisionOrchestrator (stateful: confirmation history)
// and AnalysisAgent (may be extended with per-symbol tuning).
// Signal, Option, and Execution agents are stateless — shared across tickers.
const signalAgent    = new SignalAgent();
const optionAgent    = new OptionAgent();
const executionAgent = new ExecutionAgent();

interface TickerAgents {
  analysisAgent: AnalysisAgent;
  decisionOrchestrator: DecisionOrchestrator;
}
const tickerAgents = new Map<string, TickerAgents>();

function getAgentsForTicker(ticker: string): TickerAgents {
  let agents = tickerAgents.get(ticker);
  if (!agents) {
    agents = {
      analysisAgent: new AnalysisAgent(),
      decisionOrchestrator: new DecisionOrchestrator(),
    };
    tickerAgents.set(ticker, agents);
    console.log(`[Pipeline] Created isolated agents for ${ticker}`);
  }
  return agents;
}

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
  const tickerCfg = getTickerConfig(ticker);
  const { analysisAgent, decisionOrchestrator } = getAgentsForTicker(ticker);
  console.log(`[Pipeline] Starting: ${ticker} ${profile} (${trigger}) [minConf=${tickerCfg.minConfidence}]`);

  try {
    // ── Phase 1: Market hours (cheap — determines whether AI calls are needed) ─
    const timeGateOk = await checkMarketOpen();

    // ── Phase 2: Session ───────────────────────────────────────────────────
    const intervals = profile === 'S' ? '2m,3m,5m' : profile === 'M' ? '1m,5m,15m' : '5m,1h,1d';
    const sessionId = await getOrCreateSession(ticker, profile, intervals);

    // ── Phase 3: Signal Generation + Option Contract Prefetch (parallel) ──
    // Start fetching option contracts while signal computes indicators.
    // Uses stream cache for ATM estimate; skips prefetch if cache is cold.
    const { AlpacaStreamManager } = await import('../lib/alpaca-stream.js');
    const latestBars = AlpacaStreamManager.getInstance().getBars(ticker, '1m', 1);
    const estimatedAtm = latestBars?.[0] ? Math.round(latestBars[0].close) : 0;
    const contractsPrefetch = estimatedAtm > 0
      ? optionAgent.prefetchContracts(ticker, estimatedAtm)
      : undefined;

    const signal = await signalAgent.run(ticker, profile, trigger, sessionId, tickerCfg);
    const modeLabel = signal.signalMode === 'range'
      ? ` [RANGE mode: support=$${signal.rangeSupport?.toFixed(2)}, resist=$${signal.rangeResistance?.toFixed(2)}]`
      : signal.signalMode === 'breakout'
        ? ` [BREAKOUT mode: level=$${signal.breakoutLevel?.toFixed(2)}, beyond=${signal.breakoutBeyond?.toFixed(3)}%]`
        : signal.signalMode === 'vwap_reversion'
          ? ` [VWAP_REV mode: target=$${signal.vwapReversionTarget?.toFixed(2)}, dist=${signal.vwapDistance?.toFixed(3)}%]`
          : signal.signalMode === 'trend'
            ? ' [TREND mode]'
            : ' [NO SETUP]';
    console.log(`[Pipeline] Signal: ${signal.direction} (${signal.alignment})${modeLabel}`);

    // ── Short-circuit: no qualifying mode — skip tick ────────────────────────
    if (signal.signalMode === 'none') {
      console.log(`[Pipeline] No qualifying regime detected for ${ticker} — skipping tick`);
      return {
        ticker,
        profile,
        direction: signal.direction,
        alignment: signal.alignment,
        confidence: 0,
        decision: 'WAIT',
        reasoning: 'No qualifying market regime (trend/range/breakout/vwap_reversion) detected',
        orderSubmitted: false,
        signal,
      };
    }

    // ── Phase 4: Option Selection (contracts already prefetched if stream was warm) ──
    const prefetched = contractsPrefetch ? await contractsPrefetch : undefined;
    const optionEval = await optionAgent.run(signal, prefetched);
    console.log(`[Pipeline] Option: winner=${optionEval.winner ?? 'none'}, liq=${optionEval.liquidityOk}`);

    // ── Phase 5: Analysis (deterministic confidence; AI explanation only when market open) ──
    const analysis = await analysisAgent.run(signal, optionEval, timeGateOk, tickerCfg);
    console.log(`[Pipeline] Analysis: confidence=${analysis.confidence.toFixed(2)}, threshold=${analysis.meetsEntryThreshold}`);
    if (analysis.confidenceBreakdown) {
      const cb = analysis.confidenceBreakdown;
      console.log(`[Pipeline] ConfBreakdown[${ticker}]: base=${cb.base.toFixed(2)} di=${cb.diSpreadBonus.toFixed(3)} adx=${cb.adxBonus.toFixed(2)} cross=${cb.diCrossBonus.toFixed(3)} align=${cb.alignmentBonus.toFixed(2)} td=${cb.tdAdjustment.toFixed(3)} obv=${cb.obvBonus.toFixed(3)} vwap=${cb.vwapBonus.toFixed(3)} oiVol=${cb.oiVolumeBonus.toFixed(3)} pos=${cb.pricePositionAdjustment.toFixed(3)} maturity=${cb.adxMaturityPenalty.toFixed(3)} phase=${cb.trendPhaseBonus.toFixed(3)} accel=${cb.momentumAccelBonus.toFixed(3)} struct=${cb.structureBonus.toFixed(3)} orb=${cb.orbBonus.toFixed(3)} rpa=${cb.recentPriceActionBonus.toFixed(3)} trc=${cb.trContractionPenalty.toFixed(3)} lvp=${cb.lowVolPenalty.toFixed(3)} mex=${cb.moveExhaustionPenalty.toFixed(3)} con=${cb.consolidationPenalty.toFixed(3)} nlv=${cb.nearLevelPenalty.toFixed(3)} thd=${cb.thetaDecayPenalty.toFixed(3)} per=${cb.trendPersistenceBonus.toFixed(3)}`);
    }

    // ── Phase 6: Persist Signal Snapshot + Build Context (parallel) ───────
    const [snapshotId, context] = await Promise.all([
      insertSignalSnapshot(signal, optionEval, analysis, sessionId),
      buildContext(ticker),
    ]);
    signal.id = snapshotId;

    // ── Phase 7: Decision Orchestrator (or deterministic bypass) ──────────
    // Run AI decision + fresh option quote fetch in PARALLEL to minimize price drift.
    // The fresh quote is captured at the same time as the AI streams its decision,
    // so by the time execution starts, the option price is current (not 1-3s stale).
    const registry = OrderAgentRegistry.getInstance();
    const hasActiveAgents = registry.getByTicker(ticker).some(
      a => a.getPhase() === 'MONITORING' || a.getPhase() === 'AWAITING_FILL',
    );
    const useAI = needsAIOrchestration(analysis, context, timeGateOk, hasActiveAgents);
    const optionSymbol = optionEval.winnerCandidate?.contract.symbol;

    // Fire both concurrently: AI streams decision while fresh quote fetches
    const [decision, freshMid] = await Promise.all([
      useAI
        ? decisionOrchestrator.run({ signal, option: optionEval, analysis, context, timeGateOk }, tickerCfg)
        : deterministicWait(signal, analysis, ticker, profile, timeGateOk, sessionId, tickerCfg),
      optionSymbol ? fetchOptionMid(optionSymbol).catch(() => null) : Promise.resolve(null),
    ]);
    console.log(`[Pipeline] Decision: ${decision.decisionType} (execute=${decision.shouldExecute}${useAI ? '' : ', deterministic'})`);

    // Refresh candidate entry premium with the fresh quote captured during AI call.
    // This ensures execution-agent sizing and order-agent limit price use a current price
    // instead of the stale mid from Phase 4 (which may be 1-3s old after AI streaming).
    if (freshMid !== null && optionEval.winnerCandidate) {
      const oldMid = optionEval.winnerCandidate.entryPremium;
      const driftPct = Math.abs(freshMid - oldMid) / oldMid;
      if (driftPct > 0.005) { // update if moved more than 0.5%
        console.log(
          `[Pipeline] Fresh option mid: $${oldMid.toFixed(2)} → $${freshMid.toFixed(2)} ` +
          `(drift=${(driftPct * 100).toFixed(1)}%, refreshed during AI call)`,
        );
        optionEval.winnerCandidate.entryPremium = freshMid;
        // Recalculate stop and TP proportionally to preserve R:R ratio
        const ratio = freshMid / oldMid;
        const oldStop = optionEval.winnerCandidate.stopPremium;
        const oldTp = optionEval.winnerCandidate.tpPremium;
        optionEval.winnerCandidate.stopPremium = Math.round(oldStop * ratio * 100) / 100;
        optionEval.winnerCandidate.tpPremium = Math.round(oldTp * ratio * 100) / 100;
      }
    }

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
          dailyRealizedPnl: context.dailyRealizedPnl, timeGateOk, tickerCfg,
        });
        if (!newPassed || !newSizing || !optionEval.winnerCandidate) {
          result.failedGates = newFailed; break;
        }

        const newPositionId = await registry.createAndStart({
          decision, candidate: optionEval.winnerCandidate, sizing: newSizing, sessionId,
          entryConfidence: analysis.confidence, entryAlignment: signal.alignment, entryDirection: signal.direction,
          signalPrice: signal.currentPrice,
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
          dailyRealizedPnl: context.dailyRealizedPnl, timeGateOk, tickerCfg,
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

        const addPositionId = await registry.createAndStart({
          decision, candidate: optionEval.winnerCandidate, sizing: addSizing, sessionId,
          entryConfidence: analysis.confidence, entryAlignment: signal.alignment, entryDirection: signal.direction,
          signalPrice: signal.currentPrice,
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
          dailyRealizedPnl: context.dailyRealizedPnl, timeGateOk, tickerCfg,
        });
        if (!revPassed || !revSizing || !optionEval.winnerCandidate) {
          result.failedGates = revFailed; break;
        }

        const revPositionId = await registry.createAndStart({
          decision, candidate: optionEval.winnerCandidate, sizing: revSizing, sessionId,
          entryConfidence: analysis.confidence, entryAlignment: signal.alignment, entryDirection: signal.direction,
          signalPrice: signal.currentPrice,
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
