/**
 * OrderAgentRegistry — singleton that manages all live OrderAgent instances.
 *
 * Responsibilities:
 *   - createAndStart()   : spawn a new OrderAgent for a NEW_ENTRY / ADD_POSITION decision
 *   - notifyExit()       : forward EXIT decision to all MONITORING agents for a ticker
 *   - notifyReduce()     : forward REDUCE decision to all MONITORING agents for a ticker
 *   - restoreFromDB()    : on startup, recreate agents for any OPEN positions in the DB
 *   - remove()           : called by an agent when it reaches CLOSED or FAILED
 *
 * Data-flow contract:
 *   The registry always receives a DecisionResult (orchestrator AI output) as the
 *   primary input when creating agents.  It never touches raw signal or analysis data.
 */

import { getPool } from '../db/client.js';
import { OrderAgent } from './order-agent.js';
import type { OrderAgentConfig, RestoredOrderAgentConfig, OrchestratorSuggestion, OrderAgentOutcome } from './order-agent.js';
import type { DecisionResult } from '../types/decision.js';
import type { OptionCandidate } from '../types/options.js';
import type { SizeResult } from '../types/trade.js';
import { cancelAllOpenOrders } from '../lib/alpaca-api.js';

// ── Registry ──────────────────────────────────────────────────────────────────

export class OrderAgentRegistry {
  private static _instance: OrderAgentRegistry | null = null;

  // positionId → OrderAgent
  private agents = new Map<string, OrderAgent>();

  private constructor() {}

  static getInstance(): OrderAgentRegistry {
    if (!OrderAgentRegistry._instance) {
      OrderAgentRegistry._instance = new OrderAgentRegistry();
    }
    return OrderAgentRegistry._instance;
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Create a fresh OrderAgent for a NEW_ENTRY / ADD_POSITION decision and start it.
   *
   * @param decision   - Orchestrator AI output (primary input)
   * @param candidate  - Selected option contract + premiums (OptionAgent output)
   * @param sizing     - Qty / limitPrice / conviction tier (ExecutionAgent output)
   * @param sessionId  - DB session ID
   * @param entryConfidence  - Deterministic confidence from AnalysisAgent
   * @param entryAlignment   - Signal alignment label (for post-trade evaluation)
   * @param entryDirection   - Signal direction (for post-trade evaluation)
   *
   * Returns the positionId assigned by the DB after the agent inserts the record.
   */
  async createAndStart(params: {
    decision: DecisionResult;
    candidate: OptionCandidate;
    sizing: SizeResult;
    sessionId: string;
    entryConfidence: number;
    entryAlignment: string;
    entryDirection: string;
  }): Promise<string> {
    // Registry-level cap: never allow more than 2 concurrent positions per ticker.
    // ADD_POSITION is intentional scaling but must stay bounded.
    const MAX_POSITIONS_PER_TICKER = 2;
    const existingCount = this.getByTicker(params.decision.ticker).length;
    if (existingCount >= MAX_POSITIONS_PER_TICKER) {
      console.warn(
        `[Registry] createAndStart blocked — max ${MAX_POSITIONS_PER_TICKER} concurrent ` +
        `position(s) per ticker reached for ${params.decision.ticker} (current: ${existingCount})`,
      );
      return '';
    }

    const config: OrderAgentConfig = {
      decision:         params.decision,
      candidate:        params.candidate,
      sizing:           params.sizing,
      sessionId:        params.sessionId,
      entryConfidence:  params.entryConfidence,
      entryAlignment:   params.entryAlignment,
      entryDirection:   params.entryDirection,
    };

    const agent = new OrderAgent(config);

    // agent.start() submits to Alpaca, persists position + order, sets positionId
    await agent.start();

    const positionId = agent.getPositionId();
    if (positionId && agent.getPhase() !== 'FAILED') {
      this.agents.set(positionId, agent);
      console.log(
        `[Registry] Registered agent for ${params.decision.ticker}` +
        ` positionId=${positionId} (total active: ${this.agents.size})`,
      );
    }

    return positionId;
  }

  // ── Orchestrator signal handlers ──────────────────────────────────────────

  /**
   * Forward an EXIT suggestion to all active agents for the given ticker.
   *
   * The suggestion is passed to `processOrchestratorDecision()` — each agent
   * evaluates it through its own position-management rules and may OVERRIDE
   * if its position state warrants it (unless urgency = "immediate").
   *
   * Falls back to a direct DB close if no agents are registered for the ticker.
   */
  async notifyExit(
    ticker: string,
    reason: string,
    urgency: OrchestratorSuggestion['urgency'] = 'standard',
    confidence?: number,
    marketContext?: OrchestratorSuggestion['marketContext'],
  ): Promise<OrderAgentOutcome[]> {
    const targets = this.getByTicker(ticker).filter(
      a => a.getPhase() === 'MONITORING' || a.getPhase() === 'AWAITING_FILL',
    );

    if (targets.length === 0) {
      console.warn(
        `[Registry] notifyExit: no active agents for ${ticker} — ` +
        `falling back to direct DB close`,
      );
      await this._directDbFallbackExit(ticker, reason);
      return [];
    }

    const suggestion: OrchestratorSuggestion = { decisionType: 'EXIT', reason, urgency, confidence, marketContext };
    const results = await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyExit (urgency=${urgency}) dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
    return results.filter((r): r is OrderAgentOutcome => r !== null);
  }

  /**
   * Forward a CONFIRM_HOLD suggestion to all MONITORING agents for the ticker.
   *
   * The orchestrator has reviewed the signal and suggests continuing to hold.
   * Each agent runs its own full AI evaluation and makes the final call —
   * it may EXIT, REDUCE, or ADJUST_STOP if position state warrants it.
   * Only notifies when the agent actively overrides EXIT/REDUCE suggestions.
   */
  async notifyConfirmHold(
    ticker: string,
    reason: string = 'Orchestrator CONFIRM_HOLD signal',
    confidence?: number,
    marketContext?: OrchestratorSuggestion['marketContext'],
  ): Promise<OrderAgentOutcome[]> {
    const targets = this.getByTicker(ticker).filter(a => a.getPhase() === 'MONITORING');

    if (targets.length === 0) {
      console.log(`[Registry] notifyConfirmHold: no MONITORING agents for ${ticker}`);
      return [];
    }

    const suggestion: OrchestratorSuggestion = { decisionType: 'CONFIRM_HOLD', reason, urgency: 'standard', confidence, marketContext };
    const results = await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyConfirmHold dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
    return results.filter((r): r is OrderAgentOutcome => r !== null);
  }

  /**
   * Forward a WAIT suggestion to all MONITORING agents for the ticker.
   *
   * The orchestrator sees no new entry signal, but existing positions still need
   * evaluation.  Each agent runs its own full AI evaluation and makes the final
   * call — it may EXIT, REDUCE, or ADJUST_STOP even though the pipeline said WAIT.
   */
  async notifyWait(
    ticker: string,
    reason: string = 'Orchestrator WAIT — evaluate existing positions',
    confidence?: number,
    marketContext?: OrchestratorSuggestion['marketContext'],
  ): Promise<OrderAgentOutcome[]> {
    const targets = this.getByTicker(ticker).filter(a => a.getPhase() === 'MONITORING');

    if (targets.length === 0) return [];

    const suggestion: OrchestratorSuggestion = { decisionType: 'WAIT', reason, urgency: 'low', confidence, marketContext };
    const results = await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyWait dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
    return results.filter((r): r is OrderAgentOutcome => r !== null);
  }

  /**
   * Forward an ADD_POSITION suggestion to all MONITORING agents for the ticker.
   *
   * The orchestrator wants to scale in.  Each agent evaluates whether its current
   * position supports adding more exposure:
   *   HOLD → "position is healthy, agree to scale-in" (pipeline may create new agent)
   *   EXIT → "position is struggling, veto the add" (existing position also exits)
   *   REDUCE / ADJUST_STOP → position-level action, signals caution about scaling
   */
  async notifyAddPosition(
    ticker: string,
    reason: string = 'Orchestrator ADD_POSITION signal',
    confidence?: number,
    marketContext?: OrchestratorSuggestion['marketContext'],
  ): Promise<OrderAgentOutcome[]> {
    const targets = this.getByTicker(ticker).filter(a => a.getPhase() === 'MONITORING');

    if (targets.length === 0) return [];

    const suggestion: OrchestratorSuggestion = { decisionType: 'ADD_POSITION', reason, urgency: 'standard', confidence, marketContext };
    const results = await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyAddPosition dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
    return results.filter((r): r is OrderAgentOutcome => r !== null);
  }

  /**
   * Forward a REVERSE suggestion to all active agents for the ticker.
   *
   * The orchestrator wants to flip direction.  Each agent evaluates:
   *   EXIT → "agree to reverse" — pipeline will open opposite-direction position
   *   HOLD → "refuse reversal" — position is running well, staying in trade
   *
   * urgency='immediate' bypasses AI; urgency='standard' lets agent evaluate.
   */
  async notifyReverse(
    ticker: string,
    reason: string,
    urgency: OrchestratorSuggestion['urgency'] = 'standard',
    confidence?: number,
    marketContext?: OrchestratorSuggestion['marketContext'],
  ): Promise<OrderAgentOutcome[]> {
    const targets = this.getByTicker(ticker).filter(
      a => a.getPhase() === 'MONITORING' || a.getPhase() === 'AWAITING_FILL',
    );

    if (targets.length === 0) return [];

    const suggestion: OrchestratorSuggestion = { decisionType: 'REVERSE', reason, urgency, confidence, marketContext };
    const results = await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyReverse (urgency=${urgency}) dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
    return results.filter((r): r is OrderAgentOutcome => r !== null);
  }

  /**
   * Forward a REDUCE_EXPOSURE suggestion to all MONITORING agents for the ticker.
   *
   * Each agent evaluates it through its own position-management rules.
   * If the position is running well the agent may OVERRIDE to HOLD.
   */
  async notifyReduce(
    ticker: string,
    reason: string = 'Orchestrator REDUCE_EXPOSURE signal',
    urgency: OrchestratorSuggestion['urgency'] = 'standard',
    confidence?: number,
    marketContext?: OrchestratorSuggestion['marketContext'],
  ): Promise<OrderAgentOutcome[]> {
    const targets = this.getByTicker(ticker).filter(a => a.getPhase() === 'MONITORING');

    if (targets.length === 0) {
      console.warn(`[Registry] notifyReduce: no MONITORING agents for ${ticker}`);
      return [];
    }

    const suggestion: OrchestratorSuggestion = { decisionType: 'REDUCE_EXPOSURE', reason, urgency, confidence, marketContext };
    const results = await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyReduce (urgency=${urgency}) dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
    return results.filter((r): r is OrderAgentOutcome => r !== null);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Called by OrderAgent when it reaches CLOSED or FAILED. */
  remove(positionId: string): void {
    if (this.agents.delete(positionId)) {
      console.log(
        `[Registry] Removed agent positionId=${positionId}` +
        ` (active: ${this.agents.size})`,
      );
    }
  }

  /**
   * Close positions immediately, bypassing AI evaluation.
   *
   * @param ticker  Optional symbol filter (e.g. 'SPY').
   *                When provided, only that ticker's positions/orders are closed.
   *                When omitted, ALL positions and ALL open orders are closed.
   *
   * Flow:
   *   1. notifyExit (immediate urgency) for each live agent.
   *   2. DB fallback for any OPEN positions with no live agent.
   *   3. Cancel open Alpaca orders (per-symbol or all).
   */
  async closeAllPositions(
    reason: string = 'User-initiated emergency close-all',
    ticker?: string,
  ): Promise<{
    agentsNotified: number;
    dbFallbackClosed: number;
    ordersCancelled: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let agentsNotified = 0;
    let dbFallbackClosed = 0;

    // Step 1: notify live agents (immediate urgency bypasses AI)
    const targetTickers = ticker
      ? [ticker]
      : [...new Set(this.getAll().map(a => a.getTicker()))];

    for (const t of targetTickers) {
      try {
        await this.notifyExit(t, reason, 'immediate');
        agentsNotified += this.getByTicker(t).length;
      } catch (err) {
        errors.push(`notifyExit(${t}): ${(err as Error).message}`);
      }
    }

    // Step 2: DB fallback for OPEN positions with no live agent
    const pool = getPool();
    const { rows: openRows } = await pool.query<{ id: string; ticker: string; option_symbol: string; qty: number }>(
      ticker
        ? `SELECT id, ticker, option_symbol, qty FROM trading.position_journal WHERE status='OPEN' AND ticker=$1`
        : `SELECT id, ticker, option_symbol, qty FROM trading.position_journal WHERE status='OPEN'`,
      ticker ? [ticker] : [],
    );

    const managedPositionIds = new Set(
      this.getAll().map(a => a.getPositionId()).filter(Boolean) as string[],
    );

    for (const pos of openRows.filter(r => !managedPositionIds.has(r.id))) {
      try {
        await this._directDbFallbackExit(pos.ticker, reason);
        dbFallbackClosed++;
      } catch (err) {
        errors.push(`fallbackExit(${pos.option_symbol}): ${(err as Error).message}`);
      }
    }

    // Step 3: cancel open Alpaca orders (per-symbol or all)
    let ordersCancelled = 0;
    if (ticker) {
      // Cancel orders only for the target symbol — use per-symbol cancel
      const { cancelOpenOrdersForSymbol } = await import('../lib/alpaca-api.js');
      try {
        await cancelOpenOrdersForSymbol(ticker);
        ordersCancelled = 1; // per-symbol cancel doesn't return a count
      } catch (err) {
        errors.push(`cancelOrders(${ticker}): ${(err as Error).message}`);
      }
    } else {
      const { cancelled, errors: cancelErrors } = await cancelAllOpenOrders();
      ordersCancelled = cancelled;
      errors.push(...cancelErrors);
    }

    const scope = ticker ?? 'ALL';
    console.log(
      `[Registry] closeAllPositions(${scope}) — agents notified: ${agentsNotified}, ` +
      `DB fallback closed: ${dbFallbackClosed}, orders cancelled: ${ordersCancelled}` +
      (errors.length ? `, errors: ${errors.length}` : ''),
    );

    return { agentsNotified, dbFallbackClosed, ordersCancelled, errors };
  }

  /**
   * Hard-stop all agents (daily cleanup before DB truncation).
   * Calls agent.shutdown() on each — cancels tick timers, marks phase CLOSED —
   * without touching Alpaca or the DB.  Clears the registry map.
   */
  shutdownAll(): void {
    const count = this.agents.size;
    for (const agent of this.agents.values()) {
      agent.shutdown();
    }
    this.agents.clear();
    console.log(`[Registry] shutdownAll — stopped ${count} agent(s)`);
  }

  // ── Startup recovery ──────────────────────────────────────────────────────

  /**
   * On app restart: recreate OrderAgents for every OPEN position still in the DB.
   * These agents start in AWAITING_FILL (they re-check the Alpaca order status on
   * first tick, so they transition to MONITORING if already filled).
   */
  async restoreFromDB(): Promise<void> {
    const pool = getPool();

    const { rows } = await pool.query<{
      position_id: string;
      decision_id: string;
      session_id: string | null;
      ticker: string;
      option_symbol: string;
      option_right: 'call' | 'put';
      strike: string;
      expiration: string | null;
      qty: number;
      entry_price: string;
      current_stop: string | null;
      current_tp: string | null;
      conviction_score: number;
      conviction_tier: string;
      opened_at: string;
      alpaca_order_id: string | null;
    }>(`
      SELECT
        pj.id                  AS position_id,
        pj.decision_id,
        pj.session_id,
        pj.ticker,
        pj.option_symbol,
        pj.option_right,
        pj.strike::text,
        pj.expiration::text,
        pj.qty,
        pj.entry_price::text,
        pj.current_stop::text,
        pj.current_tp::text,
        pj.conviction_score,
        pj.conviction_tier,
        pj.opened_at::text,
        oe.alpaca_order_id
      FROM trading.position_journal pj
      LEFT JOIN LATERAL (
        SELECT alpaca_order_id
          FROM trading.order_executions
         WHERE position_id = pj.id
           AND order_side  = 'buy'
         ORDER BY submitted_at DESC
         LIMIT 1
      ) oe ON true
      WHERE pj.status = 'OPEN'
      ORDER BY pj.opened_at ASC
    `);

    if (rows.length === 0) {
      console.log('[Registry] No open positions to restore');
      return;
    }

    // Fetch the original decisions to recover the full DecisionResult
    const decisionIds = [...new Set(rows.map(r => r.decision_id))];
    const decisionMap = await this._fetchDecisions(decisionIds);

    let restored = 0;
    for (const row of rows) {
      try {
        const decision = decisionMap.get(row.decision_id);
        if (!decision) {
          console.warn(`[Registry] No decision found for positionId=${row.position_id} — skipping restore`);
          continue;
        }

        // Reconstruct a minimal OptionCandidate from stored position data
        const candidate: OptionCandidate = {
          contract: {
            symbol:            row.option_symbol,
            underlyingSymbol:  row.ticker,
            expiration:        row.expiration ?? '',
            strike:            parseFloat(row.strike),
            side:              row.option_right,
            bid:               0,
            ask:               0,
            mid:               parseFloat(row.entry_price),
            spread:            0,
            spreadPct:         0,
            openInterest:      0,
            volume:            0,
          },
          score: {
            passesFilter: true,
            liquidityOk: true,
            sideMatchOk: true,
            rrRatio: 0,
            spreadPct: 0,
            openInterest: 0,
            totalScore: 0,
          },
          entryPremium: parseFloat(row.entry_price),
          stopPremium:  row.current_stop ? parseFloat(row.current_stop) : 0,
          tpPremium:    row.current_tp   ? parseFloat(row.current_tp)   : 0,
          rrRatio:      0,
        };

        const sizing: SizeResult = {
          qty:               row.qty,
          convictionScore:   row.conviction_score,
          convictionTier:    row.conviction_tier as SizeResult['convictionTier'],
          baseRiskUsd:       0,
          effectiveRiskUsd:  0,
          riskPerContract:   0,
          limitPrice:        parseFloat(row.entry_price),
        };

        const restoredCfg: RestoredOrderAgentConfig = {
          decision,
          candidate,
          sizing,
          sessionId:       row.session_id ?? '',
          entryConfidence: decision.orchestrationConfidence,
          entryAlignment:  '',
          entryDirection:  '',
          positionId:      row.position_id,
          alpacaOrderId:   row.alpaca_order_id,
          openedAt:        row.opened_at,
        };

        const agent = new OrderAgent(restoredCfg);
        agent.startRestored();
        this.agents.set(row.position_id, agent);
        restored++;
      } catch (err) {
        console.error(
          `[Registry] Failed to restore positionId=${row.position_id}:`,
          (err as Error).message,
        );
      }
    }

    console.log(
      `[Registry] Restored ${restored} / ${rows.length} open position agent(s)`,
    );
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getByTicker(ticker: string): OrderAgent[] {
    return [...this.agents.values()].filter(a => a.getTicker() === ticker);
  }

  getAll(): OrderAgent[] {
    return [...this.agents.values()];
  }

  getCount(): number {
    return this.agents.size;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Fetch stored DecisionResult rows from the DB for the given IDs.
   * Used during restoreFromDB to reconstruct the orchestrator output.
   */
  private async _fetchDecisions(ids: string[]): Promise<Map<string, DecisionResult>> {
    if (ids.length === 0) return new Map();
    const pool = getPool();

    const { rows } = await pool.query<{
      id: string;
      signal_snapshot_id: string | null;
      session_id: string | null;
      decision_type: string;
      ticker: string;
      profile: string;
      confirmation_count: number;
      orchestration_confidence: string;
      reasoning: string;
      urgency: string;
      should_execute: boolean;
      created_at: string;
    }>(
      `SELECT id, signal_snapshot_id, session_id, decision_type, ticker, profile,
              confirmation_count, orchestration_confidence::text,
              reasoning, urgency, should_execute, created_at::text
         FROM trading.trading_decisions
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    const map = new Map<string, DecisionResult>();
    for (const r of rows) {
      map.set(r.id, {
        id:                     r.id,
        signalId:               r.signal_snapshot_id ?? '',
        sessionId:              r.session_id ?? undefined,
        decisionType:           r.decision_type as DecisionResult['decisionType'],
        ticker:                 r.ticker,
        profile:                r.profile,
        confirmationCount:      r.confirmation_count,
        orchestrationConfidence: parseFloat(r.orchestration_confidence),
        reasoning:              r.reasoning,
        urgency:                r.urgency as DecisionResult['urgency'],
        shouldExecute:          r.should_execute,
        createdAt:              r.created_at,
      });
    }
    return map;
  }

  /**
   * Safety fallback: directly close all OPEN DB positions for a ticker when
   * no live agents exist (e.g. positions pre-dating the registry pattern).
   * Records the sell order in order_executions and triggers evaluation.
   */
  private async _directDbFallbackExit(ticker: string, reason: string): Promise<void> {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      option_symbol: string;
      option_right: 'call' | 'put';
      strike: string;
      expiration: string | null;
      qty: number;
      entry_price: string;
      opened_at: string;
      decision_id: string;
    }>(
      `SELECT id, option_symbol, option_right, strike::text, expiration::text,
              qty, entry_price::text, opened_at::text, decision_id
         FROM trading.position_journal
        WHERE ticker=$1 AND status='OPEN'`,
      [ticker],
    );

    const { submitMarketSellOrder: sell } = await import('../lib/alpaca-api.js');
    const { insertOrder }      = await import('../db/repositories/orders.js');
    const { insertEvaluation } = await import('../db/repositories/evaluations.js');
    const { EvaluationAgent }  = await import('./evaluation-agent.js');
    const { v4: uuidv4 }       = await import('uuid');
    const evaluationAgent      = new EvaluationAgent();

    for (const pos of rows) {
      const { alpacaOrderId, fillPrice, error } = await sell(pos.option_symbol, pos.qty);
      const exitPrice  = fillPrice ?? 0;
      const entryPrice = parseFloat(pos.entry_price);

      // Record sell order in order_executions
      try {
        await insertOrder({
          id:             uuidv4(),
          positionId:     pos.id,
          decisionId:     pos.decision_id,
          ticker,
          optionSymbol:   pos.option_symbol,
          alpacaOrderId,
          alpacaStatus:   error ? 'error' : 'submitted',
          orderSide:      'sell',
          orderType:      'market',
          positionIntent: 'sell_to_close',
          submittedQty:   pos.qty,
          filledQty:      fillPrice ? pos.qty : 0,
          fillPrice,
          errorMessage:   error,
          submittedAt:    new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[Registry] Fallback insertOrder error:`, (err as Error).message);
      }

      await pool.query(
        `UPDATE trading.position_journal
            SET status='CLOSED', exit_price=$1,
                realized_pnl=(($1::numeric - $2::numeric) * qty * 100),
                close_reason=$3, closed_at=NOW()
          WHERE id=$4`,
        [exitPrice, entryPrice, reason, pos.id],
      );

      console.log(
        `[Registry] Fallback exit: ${pos.option_symbol} @ $${exitPrice}` +
        `${error ? ` (error: ${error})` : ''}`,
      );

      // Trigger evaluation with available DB data
      try {
        const evaluation = await evaluationAgent.evaluate({
          ticker,
          optionSymbol:    pos.option_symbol,
          side:            pos.option_right,
          strike:          parseFloat(pos.strike),
          expiration:      pos.expiration ?? '',
          entryPrice,
          exitPrice,
          qty:             pos.qty,
          openedAt:        pos.opened_at,
          closedAt:        new Date().toISOString(),
          closeReason:     reason,
          entryConfidence: 0,
          entryAlignment:  'unknown',
          entryDirection:  'unknown',
          entryReasoning:  reason,
          positionId:      pos.id,
          decisionId:      pos.decision_id,
        });
        await insertEvaluation(evaluation);
        console.log(
          `[Registry] Fallback evaluation: ${evaluation.grade} (${evaluation.score})` +
          ` — ${evaluation.lessonsLearned}`,
        );
      } catch (err) {
        console.error(`[Registry] Fallback evaluation error:`, (err as Error).message);
      }
    }
  }
}
