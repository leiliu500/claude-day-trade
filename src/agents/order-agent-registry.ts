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
import type { OrderAgentConfig, RestoredOrderAgentConfig, OrchestratorSuggestion } from './order-agent.js';
import type { DecisionResult } from '../types/decision.js';
import type { OptionCandidate } from '../types/options.js';
import type { SizeResult } from '../types/trade.js';

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
  ): Promise<void> {
    const targets = this.getByTicker(ticker).filter(
      a => a.getPhase() === 'MONITORING' || a.getPhase() === 'AWAITING_FILL',
    );

    if (targets.length === 0) {
      console.warn(
        `[Registry] notifyExit: no active agents for ${ticker} — ` +
        `falling back to direct DB close`,
      );
      await this._directDbFallbackExit(ticker, reason);
      return;
    }

    const suggestion: OrchestratorSuggestion = { decisionType: 'EXIT', reason, urgency };
    await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyExit (urgency=${urgency}) dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
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
  ): Promise<void> {
    const targets = this.getByTicker(ticker).filter(a => a.getPhase() === 'MONITORING');

    if (targets.length === 0) {
      console.warn(`[Registry] notifyReduce: no MONITORING agents for ${ticker}`);
      return;
    }

    const suggestion: OrchestratorSuggestion = { decisionType: 'REDUCE_EXPOSURE', reason, urgency };
    await Promise.all(targets.map(a => a.processOrchestratorDecision(suggestion)));
    console.log(
      `[Registry] notifyReduce (urgency=${urgency}) dispatched to ${targets.length} agent(s) for ${ticker}`,
    );
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
      signal_id: string;
      session_id: string | null;
      decision_type: string;
      ticker: string;
      profile: string;
      confirmation_count: number;
      orchestration_confidence: string;
      reasoning: string;
      urgency: string;
      should_execute: boolean;
      risk_notes: string | null;
      streak_context: string | null;
      created_at: string;
    }>(
      `SELECT id, signal_id, session_id, decision_type, ticker, profile,
              confirmation_count, orchestration_confidence::text,
              reasoning, urgency, should_execute,
              risk_notes, streak_context, created_at::text
         FROM trading.trading_decisions
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    const map = new Map<string, DecisionResult>();
    for (const r of rows) {
      map.set(r.id, {
        id:                     r.id,
        signalId:               r.signal_id,
        sessionId:              r.session_id ?? undefined,
        decisionType:           r.decision_type as DecisionResult['decisionType'],
        ticker:                 r.ticker,
        profile:                r.profile,
        confirmationCount:      r.confirmation_count,
        orchestrationConfidence: parseFloat(r.orchestration_confidence),
        reasoning:              r.reasoning,
        urgency:                r.urgency as DecisionResult['urgency'],
        shouldExecute:          r.should_execute,
        riskNotes:              r.risk_notes ?? undefined,
        streakContext:          r.streak_context ?? undefined,
        createdAt:              r.created_at,
      });
    }
    return map;
  }

  /**
   * Safety fallback: directly close all OPEN DB positions for a ticker when
   * no live agents exist (e.g. positions pre-dating the registry pattern).
   */
  private async _directDbFallbackExit(ticker: string, reason: string): Promise<void> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string; option_symbol: string; qty: number }>(
      `SELECT id, option_symbol, qty FROM trading.position_journal
        WHERE ticker=$1 AND status='OPEN'`,
      [ticker],
    );

    for (const pos of rows) {
      const { submitMarketSellOrder: sell } = await import('../lib/alpaca-api.js');
      const { fillPrice, error } = await sell(pos.option_symbol, pos.qty);
      const exitPrice = fillPrice ?? 0;

      await pool.query(
        `UPDATE trading.position_journal
            SET status='CLOSED', exit_price=$1,
                realized_pnl=0, close_reason=$2, closed_at=NOW()
          WHERE id=$3`,
        [exitPrice, reason, pos.id],
      );

      console.log(
        `[Registry] Fallback exit: ${pos.option_symbol} @ $${exitPrice}` +
        `${error ? ` (error: ${error})` : ''}`,
      );
    }
  }
}
