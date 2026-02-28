/**
 * OrderAgent — dynamically spawned per NEW_ENTRY / ADD_POSITION decision.
 *
 * Autonomous authority over its position's lifecycle.  The orchestrator's
 * EXIT / REDUCE decision is ONE INPUT evaluated through the skill-file rules —
 * the agent may override it based on position state.
 *
 * Exception: `immediate` urgency decisions (EOD, hard P&L stop) bypass AI
 * evaluation and execute directly.
 *
 * Decision priority per tick:
 *   1. Hard stop / TP / expiry  (deterministic — always first, never overridden)
 *   2. processOrchestratorDecision() when pipeline signals EXIT or REDUCE
 *      → immediate urgency → execute directly
 *      → standard / low urgency → AI evaluates, may OVERRIDE to HOLD/ADJUST_STOP
 *   3. Periodic AI monitor (every AI_TICK_INTERVAL ticks without orchestrator input)
 *      → independent monitoring, may EXIT / REDUCE / ADJUST_STOP / HOLD
 *
 * Primary input is always the orchestrator AI's DecisionResult — the agent
 * never re-accesses raw signal timeframes, DMI, or market context.
 */

import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client.js';
import { insertPosition, closePosition } from '../db/repositories/positions.js';
import { insertOrder } from '../db/repositories/orders.js';
import { insertEvaluation, getTickerEvaluations } from '../db/repositories/evaluations.js';
import { insertAgentTick, getRecentAgentTicks } from '../db/repositories/order-agent-ticks.js';
import { EvaluationAgent } from './evaluation-agent.js';
import { notifyAlert } from '../telegram/notifier.js';
import { loadSkill } from '../utils/skill-loader.js';
import {
  submitLimitBuyOrder,
  submitMarketSellOrder,
  reduceAlpacaPosition,
  getAlpacaOrder,
  getAlpacaPositionPrices,
} from '../lib/alpaca-api.js';
import { config } from '../config.js';
import type { DecisionResult } from '../types/decision.js';
import type { OptionCandidate } from '../types/options.js';
import type { SizeResult, OrderRecord } from '../types/trade.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrderAgentPhase =
  | 'AWAITING_FILL'
  | 'MONITORING'
  | 'CLOSING'
  | 'CLOSED'
  | 'FAILED';

/**
 * Config for a fresh OrderAgent.
 *
 * Primary input: `decision` — the orchestrator AI's full DecisionResult.
 *   Carries: id, ticker, decisionType, urgency, reasoning, orchestrationConfidence,
 *   entryStrategy, riskNotes, createdAt.
 *   The agent NEVER re-accesses raw orchestrator inputs.
 *
 * Additional computed inputs passed at creation time:
 *   candidate, sizing, sessionId, entryConfidence, entryAlignment, entryDirection
 */
export interface OrderAgentConfig {
  decision: DecisionResult;
  candidate: OptionCandidate;
  sizing: SizeResult;
  sessionId: string;
  entryConfidence: number;
  entryAlignment: string;
  entryDirection: string;
}

/** Restored from DB on app restart. */
export interface RestoredOrderAgentConfig extends OrderAgentConfig {
  positionId: string;
  alpacaOrderId: string | null;
  openedAt: string;
}

/** Orchestrator suggestion forwarded by the pipeline. */
export interface OrchestratorSuggestion {
  decisionType: 'EXIT' | 'REDUCE_EXPOSURE';
  reason: string;
  urgency: 'immediate' | 'standard' | 'low';
}

/** AI recommendation from order-agent.md skill. */
interface AiRecommendation {
  action: 'HOLD' | 'EXIT' | 'REDUCE' | 'ADJUST_STOP';
  reasoning: string;
  new_stop: number;
  overriding_orchestrator: boolean;
}

const TICK_INTERVAL_MS  = 30_000;
const AI_TICK_INTERVAL  = 5;     // periodic AI check every N ticks (2.5 min)

const openai            = new OpenAI({ apiKey: config.OPENAI_API_KEY });
const ORDER_AGENT_SKILL = loadSkill('order-agent');
const evaluationAgent   = new EvaluationAgent();

// ── OrderAgent ────────────────────────────────────────────────────────────────

export class OrderAgent {
  private phase: OrderAgentPhase     = 'AWAITING_FILL';
  private positionId: string         = '';
  private alpacaOrderId: string | null = null;
  private openedAt: string           = '';
  private fillPrice: number | null   = null;
  private timer: NodeJS.Timeout | null = null;
  private expiryWarningSent           = false;
  private tickCount                   = 0;

  constructor(private readonly cfg: OrderAgentConfig | RestoredOrderAgentConfig) {
    if ('positionId' in cfg) {
      this.positionId    = cfg.positionId;
      this.alpacaOrderId = cfg.alpacaOrderId;
      this.openedAt      = cfg.openedAt;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const { decision, candidate, sizing, sessionId } = this.cfg;
    const ticker = decision.ticker;

    let alpacaResponse: Record<string, string | undefined> = {};
    let errorMessage: string | undefined;

    try {
      const resp = await submitLimitBuyOrder(
        candidate.contract.symbol,
        sizing.qty,
        sizing.limitPrice,
      );
      alpacaResponse = resp as Record<string, string | undefined>;
    } catch (err) {
      errorMessage = (err as Error).message;
      console.error(`[OrderAgent ${ticker}] Entry submission failed: ${errorMessage}`);
    }

    this.alpacaOrderId = alpacaResponse['id'] ?? null;
    this.openedAt      = new Date().toISOString();

    this.positionId = await insertPosition({
      sessionId,
      decisionId: decision.id,
      ticker,
      candidate,
      sizing,
    });

    const entryOrder: OrderRecord = {
      id: uuidv4(),
      positionId:    this.positionId,
      decisionId:    decision.id,
      ticker,
      optionSymbol:  candidate.contract.symbol,
      alpacaOrderId: this.alpacaOrderId ?? undefined,
      alpacaStatus:  alpacaResponse['status'] ?? (errorMessage ? 'error' : 'submitted'),
      orderSide:     'buy',
      orderType:     'limit',
      positionIntent: 'buy_to_open',
      submittedQty:  sizing.qty,
      filledQty:     alpacaResponse['filled_qty'] ? parseInt(alpacaResponse['filled_qty']!) : 0,
      submittedPrice: sizing.limitPrice,
      fillPrice:     alpacaResponse['filled_avg_price'] ? parseFloat(alpacaResponse['filled_avg_price']!) : undefined,
      errorMessage,
      submittedAt:   this.openedAt,
    };
    await insertOrder(entryOrder);

    if (errorMessage) {
      await this._voidPosition('submission_error');
      this.phase = 'FAILED';
      console.log(`[OrderAgent ${ticker}] Phase: FAILED (submission error)`);
      this._selfRemove();
      return;
    }

    this.phase = 'AWAITING_FILL';
    console.log(
      `[OrderAgent ${ticker} ${candidate.contract.symbol}] Phase: AWAITING_FILL` +
      ` — orderId=${this.alpacaOrderId ?? 'none'} positionId=${this.positionId}` +
      ` (decision: ${decision.decisionType}, urgency: ${decision.urgency})`,
    );
    this._startTick();
  }

  startRestored(): void {
    const cfg = this.cfg as RestoredOrderAgentConfig;
    console.log(
      `[OrderAgent ${cfg.decision.ticker} ${cfg.candidate.contract.symbol}] ` +
      `Restored positionId=${cfg.positionId} — resuming AWAITING_FILL check`,
    );
    this._startTick();
  }

  /**
   * Receive an orchestrator pipeline suggestion (EXIT or REDUCE_EXPOSURE).
   *
   * The orchestrator's decision is an INPUT, not a command:
   *   - `immediate` urgency  → execute directly (EOD, hard P&L stop — non-negotiable)
   *   - `standard` / `low`   → evaluate through AI; agent may OVERRIDE to HOLD/ADJUST_STOP
   */
  async processOrchestratorDecision(suggestion: OrchestratorSuggestion): Promise<void> {
    if (this.phase === 'CLOSING' || this.phase === 'CLOSED' || this.phase === 'FAILED') return;
    if (this.phase === 'AWAITING_FILL') {
      // Order hasn't filled yet — only honour immediate exits
      if (suggestion.urgency === 'immediate') {
        await this._executeExit(`UNFILLED_${suggestion.decisionType}: ${suggestion.reason}`);
      }
      return;
    }

    const ticker = this.cfg.decision.ticker;
    const symbol = this.cfg.candidate.contract.symbol;

    // Immediate urgency (EOD liquidation, hard P&L stop) — no AI override allowed
    if (suggestion.urgency === 'immediate') {
      console.log(
        `[OrderAgent ${ticker} ${symbol}] Immediate ${suggestion.decisionType}` +
        ` — executing without AI override`,
      );
      if (suggestion.decisionType === 'EXIT') {
        await this._executeExit(suggestion.reason);
      } else {
        await this._executeReduce(suggestion.reason);
      }
      return;
    }

    // Standard / low urgency — let AI evaluate and potentially override
    console.log(
      `[OrderAgent ${ticker} ${symbol}] Received ${suggestion.decisionType}` +
      ` (urgency: ${suggestion.urgency}) — evaluating through AI`,
    );
    await this._runAIDecision(suggestion);
  }

  /**
   * Auto-resolve qty: pass 0 to read current qty from DB and halve.
   * Used by the AI recommendation handler and directly when needed.
   */
  async handleReduce(reduceQty: number = 0): Promise<void> {
    if (this.phase !== 'MONITORING') return;
    await this._executeReduce('ORCHESTRATOR_REDUCE', reduceQty);
  }

  getPhase(): OrderAgentPhase  { return this.phase; }
  getPositionId(): string      { return this.positionId; }
  getTicker(): string          { return this.cfg.decision.ticker; }

  getStatus() {
    const { decision, candidate, sizing, entryConfidence, entryAlignment, entryDirection } = this.cfg;
    return {
      positionId:        this.positionId,
      phase:             this.phase,
      ticker:            decision.ticker,
      profile:           decision.profile,
      optionSymbol:      candidate.contract.symbol,
      optionRight:       candidate.contract.side,
      direction:         entryDirection,
      confidence:        entryConfidence,
      alignment:         entryAlignment,
      qty:               sizing.qty,
      convictionTier:    sizing.convictionTier,
      limitPrice:        sizing.limitPrice,
      fillPrice:         this.fillPrice,
      openedAt:          this.openedAt,
      tickCount:         this.tickCount,
      alpacaOrderId:     this.alpacaOrderId,
      decisionType:      decision.decisionType,
      decisionReasoning: decision.reasoning,
    };
  }

  /**
   * Hard shutdown for daily cleanup — stops the tick loop and marks CLOSED
   * without touching Alpaca or the DB.  Only called when the registry is
   * being cleared before a full DB truncation.
   */
  shutdown(): void {
    this._stopTick();
    this.phase = 'CLOSED';
    console.log(
      `[OrderAgent ${this.cfg.decision.ticker}] Shutdown (daily cleanup)` +
      ` positionId=${this.positionId}`,
    );
  }

  // ── Internal tick loop ─────────────────────────────────────────────────────

  private _startTick(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this._tick().catch(err =>
        console.error(`[OrderAgent ${this.cfg.decision.ticker}] Tick error:`, (err as Error).message),
      );
    }, TICK_INTERVAL_MS);
  }

  private _stopTick(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async _tick(): Promise<void> {
    this.tickCount++;
    switch (this.phase) {
      case 'AWAITING_FILL': return this._checkFill();
      case 'MONITORING':    return this._monitorPosition();
      default: break;
    }
  }

  private async _checkFill(): Promise<void> {
    if (!this.alpacaOrderId) { this.phase = 'MONITORING'; return; }

    const order = await getAlpacaOrder(this.alpacaOrderId);
    if (!order) return;

    const { decision, candidate } = this.cfg;

    if (order.status === 'filled' || order.status === 'partially_filled') {
      const filledQty = parseInt(order.filled_qty ?? '0');
      const fillPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : null;
      const filledAt  = order.filled_at ?? new Date().toISOString();

      const pool = getPool();
      await pool.query(
        `UPDATE trading.order_executions
           SET filled_qty=$1, fill_price=$2, alpaca_status=$3, filled_at=$4
         WHERE position_id=$5 AND order_side='buy'`,
        [filledQty, fillPrice, order.status, filledAt, this.positionId],
      );
      if (fillPrice) {
        await pool.query(
          `UPDATE trading.position_journal SET entry_price=$1 WHERE id=$2 AND status='OPEN'`,
          [fillPrice, this.positionId],
        );
        this.fillPrice = fillPrice;
      }

      this.phase = 'MONITORING';
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `Filled qty=${filledQty} @ $${fillPrice ?? 'n/a'} → Phase: MONITORING`,
      );

    } else if (['canceled', 'expired', 'rejected'].includes(order.status)) {
      await this._voidPosition(`order_${order.status}`);
      this.phase = 'FAILED';
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `Phase: FAILED (order ${order.status})`,
      );
      this._stopTick();
      this._selfRemove();
    }
  }

  /**
   * Every tick:
   *   1. Fetch live price and DB state
   *   2. Hard stop / TP / expiry (deterministic — always fires first)
   *   3. Periodic AI check (no orchestrator input) every AI_TICK_INTERVAL ticks
   */
  private async _monitorPosition(): Promise<void> {
    const { decision, candidate } = this.cfg;
    const symbol = candidate.contract.symbol;
    const ticker = decision.ticker;

    const priceMap     = await getAlpacaPositionPrices();
    const currentPrice = priceMap.get(symbol);
    if (currentPrice == null) return;

    const pool = getPool();
    const { rows } = await pool.query<{
      current_stop: string | null;
      current_tp: string | null;
      qty: number;
      expiration: string | null;
    }>(
      `SELECT current_stop, current_tp, qty, expiration::text
         FROM trading.position_journal WHERE id=$1 AND status='OPEN'`,
      [this.positionId],
    );

    if (rows.length === 0) { this._stopTick(); this._selfRemove(); return; }

    const { current_stop, current_tp, qty, expiration } = rows[0]!;
    const stop = current_stop ? parseFloat(current_stop) : null;
    const tp   = current_tp   ? parseFloat(current_tp)   : null;

    // ── 1. Hard stop / TP (deterministic, no AI override) ─────────────────
    if (stop != null && currentPrice <= stop) {
      await this._executeExit(`STOP_HIT @ $${currentPrice.toFixed(2)} (stop=$${stop.toFixed(2)})`);
      return;
    }
    if (tp != null && currentPrice >= tp) {
      await this._executeExit(`TP_HIT @ $${currentPrice.toFixed(2)} (tp=$${tp.toFixed(2)})`);
      return;
    }

    // ── 2. Expiry guard (deterministic) ───────────────────────────────────
    if (expiration) {
      const now      = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const expStr   = new Date(expiration).toISOString().slice(0, 10);

      if (expStr === todayStr) {
        const utcHour = now.getUTCHours();
        const utcMin  = now.getUTCMinutes();

        if (utcHour === 19 && utcMin >= 30 && utcMin < 45 && !this.expiryWarningSent) {
          this.expiryWarningSent = true;
          await notifyAlert(
            `⏰ <b>Expiry Warning: ${ticker}</b>\n` +
            `<code>${symbol}</code> expires TODAY\n` +
            `Position still open — 30 min to market close!`,
          );
        } else if (utcHour === 19 && utcMin >= 45) {
          await this._executeExit('EXPIRY_FORCE_CLOSE');
          return;
        }
      }
    }

    // ── 3. Periodic AI independent monitoring ─────────────────────────────
    if (this.tickCount % AI_TICK_INTERVAL === 0) {
      await this._runAIDecision(null, { currentPrice, stop, tp, qty, expiration });
    }
  }

  // ── AI decision layer ──────────────────────────────────────────────────────

  /**
   * Build AI payload and apply the recommendation.
   *
   * `suggestion` = null for periodic ticks; populated when called from
   * processOrchestratorDecision() with standard/low urgency.
   *
   * The AI input is derived from:
   *   - `entry_decision`: orchestrator output when position opened (primary)
   *   - `orchestrator_suggestion`: current pipeline suggestion (if any)
   *   - `position`: live state from Alpaca + DB
   */
  private async _runAIDecision(
    suggestion: OrchestratorSuggestion | null,
    state?: { currentPrice: number; stop: number | null; tp: number | null; qty: number; expiration: string | null },
  ): Promise<void> {
    // If called from processOrchestratorDecision, fetch live state ourselves
    let s = state;
    if (!s) {
      const priceMap = await getAlpacaPositionPrices();
      const currentPrice = priceMap.get(this.cfg.candidate.contract.symbol);
      if (currentPrice == null) return;

      const pool = getPool();
      const { rows } = await pool.query<{
        current_stop: string | null;
        current_tp: string | null;
        qty: number;
        expiration: string | null;
      }>(
        `SELECT current_stop, current_tp, qty, expiration::text
           FROM trading.position_journal WHERE id=$1 AND status='OPEN'`,
        [this.positionId],
      );
      if (rows.length === 0) { this._stopTick(); this._selfRemove(); return; }
      const row = rows[0]!;
      s = {
        currentPrice,
        stop:       row.current_stop ? parseFloat(row.current_stop) : null,
        tp:         row.current_tp   ? parseFloat(row.current_tp)   : null,
        qty:        row.qty,
        expiration: row.expiration,
      };
    }

    const { decision, candidate } = this.cfg;
    const entryPrice    = this.fillPrice ?? candidate.entryPremium;
    const pnlPct        = entryPrice > 0 ? ((s.currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const minutesHeld   = Math.floor((Date.now() - new Date(this.openedAt).getTime()) / 60_000);
    const minutesToExp  = s.expiration
      ? Math.max(0, Math.floor((new Date(s.expiration).getTime() + 20 * 3_600_000 - Date.now()) / 60_000))
      : 9999;

    // Fetch prior AI decisions for this position so the AI has historical context
    const history = this.positionId ? await getRecentAgentTicks(this.positionId, 5) : [];

    // Fetch recent closed-trade evaluations for the same ticker + side
    const pastEvals = await getTickerEvaluations(
      decision.ticker,
      candidate.contract.side,
      3,
    ).catch(() => []);

    const payload = {
      // Orchestrator AI output — primary input (what opened this position)
      entry_decision: {
        decision_type:            decision.decisionType,
        urgency:                  decision.urgency,
        orchestration_confidence: decision.orchestrationConfidence,
        reasoning:                decision.reasoning.slice(0, 200),
      },
      // Current pipeline suggestion — one input among others (may be null)
      orchestrator_suggestion: suggestion
        ? {
            decision_type: suggestion.decisionType,
            reason:        suggestion.reason.slice(0, 200),
            urgency:       suggestion.urgency,
          }
        : null,
      // Live position state
      position: {
        option_symbol:      candidate.contract.symbol,
        option_side:        candidate.contract.side,
        strike:             candidate.contract.strike,
        entry_price:        entryPrice.toFixed(2),
        current_price:      s.currentPrice.toFixed(2),
        unrealized_pnl_pct: pnlPct.toFixed(1),
        stop_price:         s.stop?.toFixed(2)  ?? 'none',
        tp_price:           s.tp?.toFixed(2)    ?? 'none',
        qty:                s.qty,
        minutes_held:       minutesHeld,
        minutes_to_expiry:  minutesToExp,
      },
      // Prior AI decisions for this position (oldest → newest, up to 5)
      position_history: history.map(t => ({
        tick:                  t.tick_count,
        action:                t.action,
        pnl_pct:               t.pnl_pct ?? 'n/a',
        current_price:         t.current_price ?? 'n/a',
        new_stop:              t.new_stop ?? null,
        reasoning:             (t.reasoning ?? '').slice(0, 100),
        overrode_orchestrator: t.overriding_orchestrator,
      })),
      // Recent closed trades on this ticker + option side — how did similar positions end?
      ticker_evaluation_history: pastEvals.map(e => ({
        outcome:                 e.outcome,
        grade:                   e.grade,
        score:                   e.score,
        pnl_total:               e.pnlTotal,
        hold_duration_min:       e.holdDurationMin,
        signal_quality:          e.signalQuality,
        timing_quality:          e.timingQuality,
        risk_management_quality: e.riskManagementQuality,
        lessons_learned:         e.lessonsLearned.slice(0, 150),
      })),
    };

    try {
      const msg = await openai.chat.completions.create({
        model:      'gpt-4o-mini',
        max_tokens: 300,
        messages: [
          { role: 'system', content: ORDER_AGENT_SKILL },
          { role: 'user',   content: JSON.stringify(payload) },
        ],
      });

      const text  = msg.choices[0]?.message?.content ?? '{}';
      const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const rec   = JSON.parse(clean) as AiRecommendation;

      const overrideTag = rec.overriding_orchestrator ? ' [OVERRIDE]' : '';
      console.log(
        `[OrderAgent ${decision.ticker}] AI${overrideTag}: ${rec.action}` +
        ` — ${rec.reasoning.slice(0, 120)}`,
      );

      await this._applyRecommendation(rec, s.stop, s.qty, s.currentPrice, pnlPct, suggestion);
    } catch (err) {
      // AI errors are non-fatal; hard stops still protect the position
      console.warn(
        `[OrderAgent ${decision.ticker}] AI error (non-fatal):`,
        (err as Error).message,
      );
    }
  }

  private async _applyRecommendation(
    rec: AiRecommendation,
    currentStop: number | null,
    qty: number,
    currentPrice: number,
    pnlPct: number,
    suggestion: OrchestratorSuggestion | null,
  ): Promise<void> {
    // Persist this AI tick before acting so history is always written even if execution fails
    if (this.positionId) {
      await insertAgentTick({
        positionId:             this.positionId,
        tickCount:              this.tickCount,
        action:                 rec.action,
        newStop:                rec.new_stop > 0 ? rec.new_stop : undefined,
        reasoning:              rec.reasoning,
        pnlPct:                 Math.round(pnlPct * 100) / 100,
        currentPrice,
        overridingOrchestrator: rec.overriding_orchestrator,
        orchestratorSuggestion: suggestion?.decisionType,
      }).catch(err =>
        console.warn(`[OrderAgent ${this.cfg.decision.ticker}] Failed to persist tick:`, (err as Error).message),
      );
    }

    switch (rec.action) {
      case 'EXIT':
        await this._executeExit(`AI_EXIT: ${rec.reasoning}`);
        break;

      case 'REDUCE':
        if (qty >= 2) {
          await this._executeReduce(`AI_REDUCE: ${rec.reasoning}`, Math.max(1, Math.floor(qty / 2)));
        } else {
          await this._executeExit(`AI_EXIT (qty=1, reduce→exit): ${rec.reasoning}`);
        }
        break;

      case 'ADJUST_STOP': {
        const newStop = rec.new_stop;
        const side    = this.cfg.candidate.contract.side;
        const improves = newStop > 0 && (
          currentStop == null
            ? true
            : side === 'call' ? newStop > currentStop : newStop < currentStop
        );

        if (improves) {
          const pool = getPool();
          await pool.query(
            `UPDATE trading.position_journal SET current_stop=$1 WHERE id=$2 AND status='OPEN'`,
            [newStop, this.positionId],
          );
          console.log(
            `[OrderAgent ${this.cfg.decision.ticker}] Stop trailed:` +
            ` ${currentStop?.toFixed(2) ?? 'none'} → $${newStop.toFixed(2)}`,
          );
        }
        break;
      }

      case 'HOLD':
      default:
        break;
    }
  }

  // ── Order execution helpers ────────────────────────────────────────────────

  /**
   * Poll Alpaca for a sell order's fill price.
   * Paper-trading options often fill asynchronously — the submission response
   * returns filled_avg_price=null even though the order will fill shortly.
   * Retries every 3 s for up to 15 s before giving up.
   */
  private async _pollSellFill(orderId: string): Promise<number | null> {
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3_000));
      const order = await getAlpacaOrder(orderId);
      if (order?.filled_avg_price) return parseFloat(order.filled_avg_price);
      if (['canceled', 'expired', 'rejected'].includes(order?.status ?? '')) break;
    }
    return null;
  }

  /** Close the full position. Idempotent — CLOSING/CLOSED phases guard double-exit. */
  private async _executeExit(reason: string): Promise<void> {
    if (this.phase === 'CLOSING' || this.phase === 'CLOSED') return;
    this.phase = 'CLOSING';
    this._stopTick();

    const { decision, candidate, sizing } = this.cfg;
    const symbol = candidate.contract.symbol;
    const ticker = decision.ticker;

    // Read current qty from DB — may be less than sizing.qty if a REDUCE was executed earlier
    let currentQty = sizing.qty;
    if (this.positionId) {
      const pool = getPool();
      const { rows } = await pool.query<{ qty: number }>(
        `SELECT qty FROM trading.position_journal WHERE id=$1 AND status='OPEN'`,
        [this.positionId],
      );
      if (rows[0]?.qty) currentQty = rows[0].qty;
    }

    console.log(`[OrderAgent ${ticker} ${symbol}] Exiting qty=${currentQty} — ${reason}`);

    const { alpacaOrderId, fillPrice: immediateExitFill, error } = await submitMarketSellOrder(symbol, currentQty);

    // Paper-trading options fill asynchronously — poll if not immediately filled
    let exitFill = immediateExitFill;
    if (!exitFill && alpacaOrderId && !error) {
      exitFill = await this._pollSellFill(alpacaOrderId) ?? undefined;
      if (exitFill) {
        console.log(`[OrderAgent ${ticker} ${symbol}] Polled sell fill: $${exitFill}`);
      } else {
        console.warn(`[OrderAgent ${ticker} ${symbol}] Sell fill not confirmed within 15s — using entry price as fallback`);
      }
    }

    // Always derive both prices from confirmed fills, never from the stale DB column
    const entryPrice = this.fillPrice ?? candidate.entryPremium;
    const exitPrice  = exitFill ?? entryPrice;

    await insertOrder({
      id: uuidv4(),
      positionId:    this.positionId,
      decisionId:    decision.id,
      ticker,
      optionSymbol:  symbol,
      alpacaOrderId,
      alpacaStatus:  error ? 'error' : 'submitted',
      orderSide:     'sell',
      orderType:     'market',
      positionIntent: 'sell_to_close',
      submittedQty:  currentQty,
      filledQty:     exitFill ? currentQty : 0,
      fillPrice:     exitFill,
      errorMessage:  error,
      submittedAt:   new Date().toISOString(),
    });

    await closePosition({ positionId: this.positionId, exitPrice, entryPrice, closeReason: reason });

    const pnl = (exitPrice - entryPrice) * currentQty * 100;
    const pnlStr     = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const emoji      = reason.startsWith('STOP')    ? '🛑'
                     : reason.startsWith('TP')      ? '🎯'
                     : reason.startsWith('EXPIRY')  ? '⚠️'
                     : reason.startsWith('AI_EXIT') ? '🤖' : '🚪';

    await notifyAlert(
      `${emoji} <b>Auto-exit: ${ticker}</b>\n` +
      `<code>${symbol}</code>\n` +
      `${reason.slice(0, 120)}\n` +
      `Entry: $${entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
      `P&L: <b>${pnlStr}</b> | Qty: ${currentQty}`,
    );

    await this._triggerEvaluation(exitPrice, reason);
    this.phase = 'CLOSED';
    console.log(`[OrderAgent ${ticker} ${symbol}] Phase: CLOSED`);
    this._selfRemove();
  }

  /**
   * Partial close. qty=0 → auto-compute: read current qty from DB, halve it.
   */
  private async _executeReduce(reason: string, qty: number = 0): Promise<void> {
    if (this.phase !== 'MONITORING') return;
    const { decision, candidate } = this.cfg;
    const symbol = candidate.contract.symbol;

    let reduceQty = qty;
    if (reduceQty <= 0) {
      const pool = getPool();
      const { rows } = await pool.query<{ qty: number }>(
        `SELECT qty FROM trading.position_journal WHERE id=$1 AND status='OPEN'`,
        [this.positionId],
      );
      const current = rows[0]?.qty ?? this.cfg.sizing.qty;
      reduceQty = Math.max(1, Math.floor(current / 2));
    }

    console.log(`[OrderAgent ${decision.ticker} ${symbol}] REDUCE qty=${reduceQty} — ${reason}`);

    const { alpacaOrderId, error } = await reduceAlpacaPosition(symbol, reduceQty);

    await insertOrder({
      id: uuidv4(),
      positionId:    this.positionId,
      decisionId:    decision.id,
      ticker:        decision.ticker,
      optionSymbol:  symbol,
      alpacaOrderId,
      alpacaStatus:  error ? 'error' : 'submitted',
      orderSide:     'sell',
      orderType:     'market',
      positionIntent: 'sell_to_close',
      submittedQty:  reduceQty,
      filledQty:     0,
      errorMessage:  error,
      submittedAt:   new Date().toISOString(),
    });

    if (error) {
      console.error(`[OrderAgent ${decision.ticker}] Reduce error: ${error}`);
      return;
    }

    // Decrement qty in DB so subsequent monitor ticks and exits use the correct remaining qty
    const pool = getPool();
    await pool.query(
      `UPDATE trading.position_journal
          SET qty = GREATEST(qty - $1, 0)
        WHERE id = $2 AND status = 'OPEN'`,
      [reduceQty, this.positionId],
    );
    console.log(`[OrderAgent ${decision.ticker}] position_journal.qty decremented by ${reduceQty}`);
  }

  private async _triggerEvaluation(exitPrice: number, closeReason: string): Promise<void> {
    try {
      const { decision, candidate, sizing, entryConfidence, entryAlignment, entryDirection } = this.cfg;
      const c = candidate.contract;

      const evaluation = await evaluationAgent.evaluate({
        ticker:         decision.ticker,
        optionSymbol:   c.symbol,
        side:           c.side,
        strike:         c.strike,
        expiration:     c.expiration,
        entryPrice:     this.fillPrice ?? candidate.entryPremium,
        exitPrice,
        qty:            sizing.qty,
        openedAt:       this.openedAt,
        closedAt:       new Date().toISOString(),
        closeReason,
        entryConfidence,
        entryAlignment,
        entryDirection,
        entryReasoning: decision.reasoning,
        positionId:     this.positionId,
        decisionId:     decision.id,
      });

      await insertEvaluation(evaluation);
      console.log(
        `[OrderAgent ${decision.ticker}] Evaluation: ${evaluation.grade} (${evaluation.score})` +
        ` — ${evaluation.lessonsLearned}`,
      );
    } catch (err) {
      console.error(`[OrderAgent ${this.cfg.decision.ticker}] Evaluation error:`, (err as Error).message);
    }
  }

  private async _voidPosition(reason: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE trading.position_journal
         SET status='CLOSED', close_reason=$1, closed_at=NOW()
       WHERE id=$2 AND status='OPEN'`,
      [reason, this.positionId],
    );
  }

  private _selfRemove(): void {
    import('./order-agent-registry.js')
      .then(m => m.OrderAgentRegistry.getInstance().remove(this.positionId))
      .catch(() => {});
  }
}
