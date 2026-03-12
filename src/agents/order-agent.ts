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
import { insertDispatch } from '../db/repositories/order-agent-dispatches.js';
import { EvaluationAgent } from './evaluation-agent.js';
import { notifyAlert, notifyOrderAgentDecision, notifyOrderAgentDispatch, notifyFillStale } from '../telegram/notifier.js';
import { loadSkill } from '../utils/skill-loader.js';
import {
  submitLimitBuyOrder,
  submitMarketSellOrder,
  reduceAlpacaPosition,
  getAlpacaOrder,
  getAlpacaPositionPrices,
  cancelOpenOrdersForSymbol,
  fetchOptionMid,
} from '../lib/alpaca-api.js';
import { AlpacaStreamManager } from '../lib/alpaca-stream.js';
import type { TradeUpdateEvent } from '../lib/alpaca-stream.js';
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
  decisionType: 'EXIT' | 'REDUCE_EXPOSURE' | 'CONFIRM_HOLD' | 'WAIT' | 'ADD_POSITION' | 'REVERSE';
  reason: string;
  urgency: 'immediate' | 'standard' | 'low';
  /** Orchestration confidence (0–1) — passed through so dispatch records prove low-confidence inputs reach agents */
  confidence?: number;
  /**
   * Live market context from the orchestrator pipeline — structured indicator data used to
   * predict whether a P&L dip is temporary (trend still intact) or terminal (trend reversed).
   * Only omitted when the pipeline encounters an error before signal/analysis are available.
   */
  marketContext?: {
    /** Trend direction synthesized across all timeframes. */
    direction: 'bullish' | 'bearish' | 'neutral';
    /** Timeframe agreement: all_aligned | htf_mtf_aligned | mtf_ltf_aligned | mixed. */
    alignment: string;
    /** ADX-based trend strength 0–100 (≥30 = strong, 20–29 = moderate, <20 = weak). */
    strengthScore: number;
    /** Top factors driving the signal (from AnalysisAgent). */
    keyFactors: string[];
    /** Current risks flagged by AnalysisAgent. */
    risks: string[];
  };
}

/** AI recommendation from order-agent.md skill. */
interface AiRecommendation {
  action: 'HOLD' | 'EXIT' | 'REDUCE' | 'ADJUST_STOP';
  reasoning: string;
  new_stop: number;
  overriding_orchestrator: boolean;
}

/** Outcome returned by processOrchestratorDecision — used by the pipeline for notifications. */
export interface OrderAgentOutcome {
  action: 'EXIT' | 'REDUCE' | 'HOLD' | 'ADJUST_STOP';
  reasoning: string;
  overridingOrchestrator: boolean;
  optionSymbol: string;
  pnlPct?: number;
}

const TICK_INTERVAL_MS          = 10_000;   // 10 s — fast deterministic checks (was 30 s)
const AI_TICK_INTERVAL          = 2;        // AI check every 2nd tick (~20 s) — balances responsiveness with mutex contention
const FILL_TIMEOUT_MS           = 90_000;   // cancel unfilled limit order after 90 s
const FILL_STALE_CHECK_MS    = 45_000; // check for adverse price move at 45 s
const FILL_STALE_ABORT_PCT   = 0.15;  // cancel if current mid dropped > 15% below limit price

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
  private highestPrice: number | null = null;
  /** Highest unrealized P&L % ever seen — used to trigger profit-protection floors. */
  private peakPnlPct: number          = 0;
  /** Previous tick's price — used to detect consecutive price declines. */
  private lastPrice: number | null    = null;
  /** Number of consecutive 10 s ticks where price fell — drives rapid-decline exit and adaptive AI. */
  private consecutiveDeclines: number = 0;
  /** Rolling buffer of last 5 pnlPctNow values — used to detect sustained-loss hold traps. */
  private recentTickPnls: number[] = [];
  /** True once the 45 s stale-price fill check has run (runs at most once per order). */
  private fillStaleChecked = false;
  /**
   * Mutex: true while an AI evaluation (_runAIDecision) is in-flight.
   * Prevents concurrent calls from the 30 s tick and the orchestrator pipeline
   * from both reaching _executeReduce / _executeExit simultaneously.
   */
  private isAIRunning = false;
  /** Last market context received from the orchestrator — reused on self-ticks when no new dispatch. */
  private cachedMarketContext: OrchestratorSuggestion['marketContext'] | null = null;
  /**
   * Queued orchestrator suggestion — set when processOrchestratorDecision arrives while
   * AI is already running. The next AI completion or tick will pick this up and process it
   * so EXIT/REDUCE signals from the pipeline are never silently dropped.
   */
  private pendingSuggestion: OrchestratorSuggestion | null = null;
  /** In-memory trailing stop — synced after each 30s tick, used by stream price handler to avoid DB reads. */
  private currentStop: number | null = null;
  /** In-memory TP level — synced after each 30s tick. */
  private currentTp: number | null = null;
  /** Timestamp (ms) of the last stream-triggered price check — used to throttle quote callbacks. */
  private lastStreamCheckMs = 0;
  /** Last price seen in stream handler — used to track price direction at 5s granularity. */
  private lastStreamPrice: number | null = null;
  /** Consecutive stream-level price declines (5s granularity) — feeds profit-lock rules in stream handler. */
  private streamConsecutiveDeclines = 0;
  /** Rolling price+timestamp buffer for velocity detection — keeps last 20 entries (~100s at 5s stream cadence). */
  private priceHistory: { price: number; ts: number }[] = [];

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

    // Register with the trading stream for instant fill notification.
    // The 30 s polling tick remains active as a fallback.
    if (this.alpacaOrderId) {
      AlpacaStreamManager.getInstance().watchOrder(this.alpacaOrderId, (event) => {
        void this._handleTradeUpdate(event);
      });
    }

    this._startTick();
  }

  startRestored(): void {
    const cfg = this.cfg as RestoredOrderAgentConfig;
    console.log(
      `[OrderAgent ${cfg.decision.ticker} ${cfg.candidate.contract.symbol}] ` +
      `Restored positionId=${cfg.positionId} — resuming AWAITING_FILL check`,
    );

    // Re-register with stream in case the order is still pending fill
    if (cfg.alpacaOrderId) {
      AlpacaStreamManager.getInstance().watchOrder(cfg.alpacaOrderId, (event) => {
        void this._handleTradeUpdate(event);
      });
    }

    // Recover in-memory trailing-stop state from DB so the profit-protection
    // floors are not lost across restarts.
    this._restoreStateFromDB().catch(err =>
      console.warn(
        `[OrderAgent ${cfg.decision.ticker}] State restore warning:`,
        (err as Error).message,
      ),
    );

    this._startTick();
  }

  /**
   * Reconstruct in-memory trailing-stop state (highestPrice / peakPnlPct) from the
   * position's stored current_stop after an app restart.
   *
   * Under the trailing-stop formula: stop = highestPrice * 0.85 (before profit floors),
   * so highestPrice ≈ stop / 0.85.  This is a conservative lower bound — real peak
   * could have been higher, but this prevents the stop from being reset below its
   * last recorded value on the next tick.
   */
  private async _restoreStateFromDB(): Promise<void> {
    const pool = getPool();
    const { rows } = await pool.query<{
      current_stop: string | null;
      entry_price: string | null;
      peak_pnl_pct: string | null;
    }>(
      `SELECT current_stop, entry_price, peak_pnl_pct FROM trading.position_journal WHERE id=$1 AND status='OPEN'`,
      [this.positionId],
    );
    if (!rows[0]) return;

    const { current_stop, entry_price, peak_pnl_pct } = rows[0];

    // Restore fill price if the agent was reconstructed without it
    if (entry_price && !this.fillPrice) {
      this.fillPrice = parseFloat(entry_price);
    }

    const entry = this.fillPrice ?? this.cfg.candidate.entryPremium;

    if (peak_pnl_pct !== null) {
      // Preferred path: use the exact persisted peak value
      this.peakPnlPct = Math.max(0, parseFloat(peak_pnl_pct));
      // Reconstruct highestPrice from peak so trailing stop formula stays consistent
      if (entry > 0) {
        this.highestPrice = parseFloat((entry * (1 + this.peakPnlPct / 100)).toFixed(2));
      }
    } else if (current_stop) {
      // Fallback for positions created before the peak_pnl_pct column existed:
      // derive implied peak from stored stop (lower bound; real peak may have been higher).
      // Must match the trailing stop formula: stop = highestPrice * 0.87 → highestPrice = stop / 0.87
      const dbStop      = parseFloat(current_stop);
      const impliedPeak = parseFloat((dbStop / 0.87).toFixed(2));
      this.highestPrice = Math.max(impliedPeak, entry);
      if (entry > 0) {
        this.peakPnlPct = Math.max(0, ((this.highestPrice - entry) / entry) * 100);
      }
    }

    console.log(
      `[OrderAgent ${this.cfg.decision.ticker}] Restored state:` +
      ` fillPrice=$${this.fillPrice} highestPrice=$${this.highestPrice}` +
      ` peakPnlPct=${this.peakPnlPct.toFixed(1)}%` +
      (peak_pnl_pct !== null ? ' (from DB)' : ' (derived from stop — pre-migration)'),
    );
  }

  /**
   * Receive an orchestrator pipeline suggestion (EXIT or REDUCE_EXPOSURE).
   *
   * The orchestrator's decision is an INPUT, not a command:
   *   - `immediate` urgency  → execute directly (EOD, hard P&L stop — non-negotiable)
   *   - `standard` / `low`   → evaluate through AI; agent may OVERRIDE to HOLD/ADJUST_STOP
   */
  async processOrchestratorDecision(suggestion: OrchestratorSuggestion): Promise<OrderAgentOutcome | null> {
    if (this.phase === 'CLOSING' || this.phase === 'CLOSED' || this.phase === 'FAILED') return null;

    const ticker = this.cfg.decision.ticker;
    const symbol = this.cfg.candidate.contract.symbol;

    // Persist every dispatch so the dashboard can prove all orchestrator decisions
    // (including AWAITING_FILL agents and low-confidence WAIT/CONFIRM_HOLD) reach active order agents.
    void insertDispatch({
      positionId:           this.positionId,
      ticker,
      optionSymbol:         symbol,
      orchestratorDecision: suggestion.decisionType,
      confidence:           suggestion.confidence,
      urgency:              suggestion.urgency,
      reason:               suggestion.reason,
    }).catch(err =>
      console.warn(`[OrderAgent ${ticker}] Failed to persist dispatch:`, (err as Error).message),
    );

    if (this.phase === 'AWAITING_FILL') {
      // Order hasn't filled yet.
      // Cancel when:
      //   (a) immediate urgency — EOD / hard P&L stop, non-negotiable, OR
      //   (b) standard urgency EXIT/REDUCE with high confidence (>= MIN_CONFIDENCE) —
      //       market has turned while we waited; filling into a losing trade is worse than missing the entry.
      const isExitOrReduce = suggestion.decisionType === 'EXIT' || suggestion.decisionType === 'REDUCE_EXPOSURE';
      const isHighConfidence = (suggestion.confidence ?? 0) >= config.MIN_CONFIDENCE;
      const shouldCancel =
        suggestion.urgency === 'immediate' ||
        (isExitOrReduce && suggestion.urgency === 'standard' && isHighConfidence);

      if (shouldCancel) {
        const reason = `UNFILLED_CANCELLED: ${suggestion.reason}`;

        // Cancel the pending buy order so it never fills and creates an orphaned position.
        // _executeExit must NOT be used here — it tries sell_to_close on a position that
        // doesn't exist yet (Alpaca error 42210000), and crucially never cancels the buy.
        this.phase = 'CLOSING';
        this._stopTick();
        if (this.alpacaOrderId) AlpacaStreamManager.getInstance().unwatchOrder(this.alpacaOrderId);
        await cancelOpenOrdersForSymbol(symbol).catch(err =>
          console.warn(`[OrderAgent ${ticker} ${symbol}] Cancel buy order failed (best-effort):`, (err as Error).message),
        );
        await this._voidPosition(reason);
        this.phase = 'FAILED';
        console.log(
          `[OrderAgent ${ticker} ${symbol}] Phase: FAILED — buy order cancelled` +
          ` (urgency=${suggestion.urgency}, confidence=${suggestion.confidence?.toFixed(2) ?? 'n/a'}, reason=${reason})`,
        );
        this._selfRemove();

        return { action: 'EXIT', reasoning: suggestion.reason, overridingOrchestrator: false, optionSymbol: symbol };
      }
      return null;
    }

    // CONFIRM_HOLD / WAIT — fall through to AI evaluation.
    // These are suggestions just like EXIT / REDUCE; the agent makes the final call.
    // (No special-case handling — _runAIDecision at the bottom covers them.)

    // Immediate urgency (EOD liquidation, hard P&L stop) — no AI override allowed
    if (suggestion.urgency === 'immediate') {
      console.log(
        `[OrderAgent ${ticker} ${symbol}] Immediate ${suggestion.decisionType}` +
        ` — executing without AI override`,
      );
      if (suggestion.decisionType === 'EXIT' || suggestion.decisionType === 'REVERSE') {
        await this._executeExit(suggestion.reason);
        // Persist the immediate-exit tick (bypasses _applyRecommendation)
        void insertAgentTick({
          positionId: this.positionId, tickCount: this.tickCount,
          action: 'EXIT', reasoning: `IMMEDIATE: ${suggestion.reason}`,
          pnlPct: 0, currentPrice: this.fillPrice ?? 0,
          overridingOrchestrator: false, orchestratorSuggestion: suggestion.decisionType,
        }).catch(() => {});
        return { action: 'EXIT', reasoning: suggestion.reason, overridingOrchestrator: false, optionSymbol: symbol };
      } else if (suggestion.decisionType === 'REDUCE_EXPOSURE') {
        await this._executeReduce(suggestion.reason);
        void insertAgentTick({
          positionId: this.positionId, tickCount: this.tickCount,
          action: 'REDUCE', reasoning: `IMMEDIATE: ${suggestion.reason}`,
          pnlPct: 0, currentPrice: this.fillPrice ?? 0,
          overridingOrchestrator: false, orchestratorSuggestion: suggestion.decisionType,
        }).catch(() => {});
        return { action: 'REDUCE', reasoning: suggestion.reason, overridingOrchestrator: false, optionSymbol: symbol };
      }
      // ADD_POSITION with immediate urgency — not actionable on existing position, fall through to AI
    }

    // Standard / low urgency — let AI evaluate and potentially override
    console.log(
      `[OrderAgent ${ticker} ${symbol}] Received ${suggestion.decisionType}` +
      ` (urgency: ${suggestion.urgency}) — evaluating through AI`,
    );
    // Notify that orchestrator has reached this agent (proves dispatch is working)
    void notifyOrderAgentDispatch({
      ticker,
      optionSymbol:        symbol,
      optionSide:          this.cfg.candidate.contract.side,
      orchestratorDecision: suggestion.decisionType,
      urgency:             suggestion.urgency,
      reason:              suggestion.reason,
    });
    // Cache market context BEFORE entering _runAIDecision so that even if the
    // isAIRunning mutex blocks, the next self-tick AI will use fresh context.
    if (suggestion.marketContext) this.cachedMarketContext = suggestion.marketContext;
    return await this._runAIDecision(suggestion);
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
      // Suggested levels from OptionAgent (before execution sizing)
      suggestedEntry:    candidate.entryPremium,
      suggestedStop:     candidate.stopPremium,
      suggestedTp:       candidate.tpPremium,
      suggestedRR:       candidate.rrRatio,
    };
  }

  /**
   * Hard shutdown for daily cleanup — stops the tick loop and marks CLOSED
   * without touching Alpaca or the DB.  Only called when the registry is
   * being cleared before a full DB truncation.
   */
  shutdown(): void {
    this._stopTick();
    AlpacaStreamManager.getInstance().unwatchOptionQuote(this.cfg.candidate.contract.symbol);
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

  /**
   * Real-time fill handler — called immediately by the trading stream WebSocket.
   * Transitions AWAITING_FILL → MONITORING on fill, or FAILED on cancel/reject.
   * The 30 s polling fallback (_checkFill) is idempotent and harmless if it fires too.
   */
  private async _handleTradeUpdate(event: TradeUpdateEvent): Promise<void> {
    if (this.phase !== 'AWAITING_FILL') return;

    const { decision, candidate } = this.cfg;
    const { order } = event;

    console.log(
      `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
      `Stream trade_update: event=${event.event} status=${order.status}`,
    );

    if (event.event === 'fill') {
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
      this._forceNextAI = true;
      // Subscribe to real-time quotes for immediate stop/TP detection
      AlpacaStreamManager.getInstance().watchOptionQuote(candidate.contract.symbol, (mid) => {
        void this._handlePriceUpdate(mid);
      });
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `[STREAM] Filled qty=${filledQty} @ $${fillPrice ?? 'n/a'} → Phase: MONITORING`,
      );
      // Immediately run the first monitor tick instead of waiting up to 30 s
      // for the next setInterval fire (which would then also delay the AI check
      // by another 30 s due to AI_TICK_INTERVAL = 2).
      void this._monitorPosition();

    } else if (event.event === 'partial_fill') {
      // Update DB record with the partial fill details but remain in AWAITING_FILL.
      // A subsequent 'fill' event will arrive when the order completes.
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
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `[STREAM] Partial fill qty=${filledQty} @ $${fillPrice ?? 'n/a'} — still AWAITING_FILL`,
      );

    } else if (['canceled', 'expired', 'rejected'].includes(event.event)) {
      await this._voidPosition(`order_${event.event}`);
      this.phase = 'FAILED';
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `[STREAM] Phase: FAILED (order ${event.event})`,
      );
      this._stopTick();
      this._selfRemove();
    }
  }

  /**
   * 30 s polling fallback for fill detection.
   * Runs every tick while in AWAITING_FILL phase.
   * Harmless if _handleTradeUpdate already transitioned to MONITORING.
   */
  private async _checkFill(): Promise<void> {
    // Already transitioned by the stream handler — nothing to do
    if (this.phase !== 'AWAITING_FILL') return;
    if (!this.alpacaOrderId) { this.phase = 'MONITORING'; return; }

    // Cancel the limit order if it has been pending too long — prevents
    // (1) blocking new entries and (2) a stale fill at a bad price.
    const elapsedMs = Date.now() - new Date(this.openedAt).getTime();
    if (elapsedMs > FILL_TIMEOUT_MS) {
      const { decision, candidate } = this.cfg;
      console.warn(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `FILL_TIMEOUT — order unfilled after ${Math.round(elapsedMs / 1000)}s, cancelling`,
      );
      if (this.alpacaOrderId) AlpacaStreamManager.getInstance().unwatchOrder(this.alpacaOrderId);
      await cancelOpenOrdersForSymbol(candidate.contract.symbol);
      await this._voidPosition('fill_timeout');
      this.phase = 'FAILED';
      this._stopTick();
      this._selfRemove();
      return;
    }

    // Mid-wait stale-price guard: if the underlying has moved against us significantly
    // since the order was placed, cancel rather than risk filling into a losing entry.
    // Only checked once at the FILL_STALE_CHECK_MS mark (first tick after 45 s).
    if (elapsedMs >= FILL_STALE_CHECK_MS && !this.fillStaleChecked) {
      this.fillStaleChecked = true;
      const { decision, candidate } = this.cfg;
      const currentMid = await fetchOptionMid(candidate.contract.symbol);
      if (currentMid !== null) {
        const dropPct = (this.cfg.sizing.limitPrice - currentMid) / this.cfg.sizing.limitPrice;
        if (dropPct > FILL_STALE_ABORT_PCT) {
          const elapsedSec = Math.round(elapsedMs / 1000);
          console.warn(
            `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
            `FILL_STALE — mid dropped ${(dropPct * 100).toFixed(1)}% from limit ` +
            `$${this.cfg.sizing.limitPrice} to $${currentMid.toFixed(2)} after ${elapsedSec}s, cancelling`,
          );
          if (this.alpacaOrderId) AlpacaStreamManager.getInstance().unwatchOrder(this.alpacaOrderId);
          await cancelOpenOrdersForSymbol(candidate.contract.symbol);
          await this._voidPosition('fill_stale');
          this.phase = 'FAILED';
          this._stopTick();
          notifyFillStale({
            ticker: decision.ticker,
            optionSymbol: candidate.contract.symbol,
            limitPrice: this.cfg.sizing.limitPrice,
            currentMid,
            dropPct,
            elapsedSec,
          }).catch(() => {});
          this._selfRemove();
          return;
        }
      }
    }

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
      this._forceNextAI = true;
      // Subscribe to real-time quotes for immediate stop/TP detection
      AlpacaStreamManager.getInstance().watchOptionQuote(candidate.contract.symbol, (mid) => {
        void this._handlePriceUpdate(mid);
      });
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `[POLL] Filled qty=${filledQty} @ $${fillPrice ?? 'n/a'} → Phase: MONITORING`,
      );
      // Immediately run the first monitor tick instead of waiting for the next interval.
      void this._monitorPosition();

    } else if (['canceled', 'expired', 'rejected'].includes(order.status)) {
      if (this.alpacaOrderId) AlpacaStreamManager.getInstance().unwatchOrder(this.alpacaOrderId);
      await this._voidPosition(`order_${order.status}`);
      this.phase = 'FAILED';
      console.log(
        `[OrderAgent ${decision.ticker} ${candidate.contract.symbol}] ` +
        `[POLL] Phase: FAILED (order ${order.status})`,
      );
      this._stopTick();
      this._selfRemove();
    }
  }

  private _monitorRunning = false;
  /** Set when transitioning to MONITORING so the immediate post-fill tick always runs AI. */
  private _forceNextAI = false;

  /**
   * Called on every real-time option quote update from the data stream.
   * Runs all deterministic exit checks using only in-memory state — no REST, DB, or AI calls.
   * The 10 s polling tick remains authoritative for trailing stop DB sync, AI decisions,
   * and full state refresh.
   *
   * Uses `_monitorRunning` as a shared mutex: if the full 10 s tick is already running,
   * the stream check is skipped (the full tick already covers all checks with a fresher price).
   */
  private async _handlePriceUpdate(midPrice: number): Promise<void> {
    if (this.phase !== 'MONITORING') return;
    if (this._monitorRunning) return;

    // Throttle: at most one stream-triggered check per second (exits are idempotent via phase guard)
    const now = Date.now();
    if (now - this.lastStreamCheckMs < 1_000) return;
    this.lastStreamCheckMs = now;

    // ── Update in-memory peak tracking (ratchets up only, mirrors _updateTrailingStop) ──
    const entry = this.fillPrice ?? this.cfg.candidate.entryPremium;
    if (this.highestPrice === null) this.highestPrice = entry;
    if (midPrice > this.highestPrice) this.highestPrice = midPrice;
    if (entry > 0) {
      const peakNow = ((this.highestPrice - entry) / entry) * 100;
      this.peakPnlPct = Math.max(this.peakPnlPct, peakNow);
    }

    // Compute effective stop from in-memory state (mirrors _updateTrailingStop formula)
    // Adaptive trail factor: tighten as peak grows (same logic as _updateTrailingStop)
    const trailFactor = this.peakPnlPct >= 40 ? 0.92
                      : this.peakPnlPct >= 25 ? 0.90
                      : 0.87;
    const rawTrailingStop = parseFloat((this.highestPrice * trailFactor).toFixed(2));
    let profitFloor = 0;
    if      (this.peakPnlPct >= 40) profitFloor = parseFloat((entry * 1.25).toFixed(2));
    else if (this.peakPnlPct >= 30) profitFloor = parseFloat((entry * 1.18).toFixed(2));
    else if (this.peakPnlPct >= 20) profitFloor = parseFloat((entry * 1.08).toFixed(2));
    else if (this.peakPnlPct >= 15) profitFloor = parseFloat((entry * 1.03).toFixed(2));
    else if (this.peakPnlPct >= 10) profitFloor = parseFloat(entry.toFixed(2));
    else if (this.peakPnlPct >= 5)  profitFloor = parseFloat(entry.toFixed(2)); // breakeven floor once 5% peak reached
    else if (this.peakPnlPct >= 3)  profitFloor = parseFloat((entry * 0.995).toFixed(2)); // near-breakeven floor for small gains
    // currentStop is the last DB-synced value; use it as a floor too (never regress below DB stop)
    const streamStop = Math.max(rawTrailingStop, profitFloor, this.currentStop ?? 0);

    const pnlPct = entry > 0 ? ((midPrice - entry) / entry) * 100 : 0;
    const { decision } = this.cfg;

    // ── Track price direction at stream granularity (5s) ──
    if (this.lastStreamPrice !== null) {
      if (midPrice < this.lastStreamPrice) {
        this.streamConsecutiveDeclines++;
      } else {
        this.streamConsecutiveDeclines = 0;
      }
    }
    this.lastStreamPrice = midPrice;

    // ── Record into velocity buffer (ring buffer of 20) ──
    this.priceHistory.push({ price: midPrice, ts: now });
    if (this.priceHistory.length > 20) this.priceHistory.shift();

    // ── Hard stop ──
    if (midPrice <= streamStop) {
      console.log(
        `[OrderAgent ${decision.ticker}] [STREAM] STOP_HIT` +
        ` mid=$${midPrice.toFixed(2)} stop=$${streamStop.toFixed(2)}`,
      );
      await this._executeExit(
        `STOP_HIT @ $${midPrice.toFixed(2)} (stop=$${streamStop.toFixed(2)}) [stream]`,
      );
      return;
    }

    // ── Take-profit ──
    if (this.currentTp != null && midPrice >= this.currentTp) {
      console.log(
        `[OrderAgent ${decision.ticker}] [STREAM] TP_HIT` +
        ` mid=$${midPrice.toFixed(2)} tp=$${this.currentTp.toFixed(2)}`,
      );
      await this._executeExit(
        `TP_HIT @ $${midPrice.toFixed(2)} (tp=$${this.currentTp.toFixed(2)}) [stream]`,
      );
      return;
    }

    // ── Profit-lock exits (deterministic — no consecutiveDeclines dependency) ──
    // Fire purely on peak-erosion % + minimum hold time (tickCount).
    // Stream handler uses same thresholds as 10s tick for consistency.
    const streamRetainedPct = this.peakPnlPct > 0 ? (pnlPct / this.peakPnlPct) * 100 : 100;

    if (this.peakPnlPct >= 35 && streamRetainedPct < 60 && pnlPct > 0 && this.tickCount >= 4) {
      await this._executeExit(`PROFIT_LOCK_EXTREME [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% (${streamRetainedPct.toFixed(0)}% of peak)`);
      return;
    }
    if (this.peakPnlPct >= 25 && streamRetainedPct < 50 && pnlPct > 0 && this.tickCount >= 4) {
      await this._executeExit(`PROFIT_LOCK_LARGE [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% (${streamRetainedPct.toFixed(0)}% of peak)`);
      return;
    }
    if (this.peakPnlPct >= 20 && streamRetainedPct < 50 && pnlPct > 0 && this.tickCount >= 4) {
      await this._executeExit(`PROFIT_LOCK_MEDIUM [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% (${streamRetainedPct.toFixed(0)}% of peak)`);
      return;
    }
    if (this.peakPnlPct >= 15 && streamRetainedPct < 45 && pnlPct > 0 && this.tickCount >= 6) {
      await this._executeExit(`PROFIT_LOCK_MODERATE [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% (${streamRetainedPct.toFixed(0)}% of peak)`);
      return;
    }
    if (this.peakPnlPct >= 10 && streamRetainedPct < 40 && pnlPct > 0 && this.tickCount >= 8) {
      await this._executeExit(`PROFIT_LOCK_SMALL [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% (${streamRetainedPct.toFixed(0)}% of peak)`);
      return;
    }

    // ── Peak-erosion exits: exit while still in profit, never let profit turn to loss ──
    if (this.peakPnlPct >= 20 && pnlPct <= 8) {
      await this._executeExit(`PEAK_EROSION [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — protecting remaining profit`);
      return;
    }
    if (this.peakPnlPct >= 12 && pnlPct <= 3) {
      await this._executeExit(`PEAK_GONE [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — locking last gains`);
      return;
    }
    if (this.peakPnlPct >= 10 && pnlPct <= 2) {
      await this._executeExit(`PEAK_REVERSAL [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — gains nearly gone`);
      return;
    }
    if (this.peakPnlPct >= 5 && pnlPct <= 0.5) {
      await this._executeExit(`PEAK_GAINS_GONE [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — locking remainder before loss`);
      return;
    }
    // Last resort for any profitable position turning negative — exit immediately at breakeven
    if (this.peakPnlPct >= 1.0 && pnlPct <= 0 && (this.tickCount >= 4 || this.peakPnlPct >= 5)) {
      await this._executeExit(`PROFIT_REVERSED [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPct.toFixed(1)}% — exiting at breakeven`);
      return;
    }
    if (pnlPct <= -10 && this.tickCount >= 9) {
      await this._executeExit(`PRE_EMPTIVE_LOSS [stream]: pnl=${pnlPct.toFixed(1)}%`);
      return;
    }

    // ── Velocity-based exits (rate of P&L change within a rolling window) ──
    // A sharp drop within any 15s window is a strong reversal signal regardless of absolute level.
    if (this.priceHistory.length >= 3) {
      const windowMs = 15_000;
      const cutoffTs = now - windowMs;
      const oldest = this.priceHistory.find(p => p.ts >= cutoffTs) ?? this.priceHistory[0]!;
      if (oldest.price > 0) {
        const velocityPct = ((midPrice - oldest.price) / oldest.price) * 100;
        // Fast crash: dropped 4%+ in ≤15s — exit immediately regardless of peak/ticks
        if (velocityPct <= -4) {
          await this._executeExit(`VELOCITY_CRASH [stream]: ${velocityPct.toFixed(1)}% in ${((now - oldest.ts) / 1000).toFixed(0)}s — rapid price collapse`);
          return;
        }
        // Fast fade: dropped 2.5%+ in ≤15s while already losing — entry is wrong
        if (velocityPct <= -2.5 && pnlPct < 0) {
          await this._executeExit(`VELOCITY_FADE [stream]: ${velocityPct.toFixed(1)}% in ${((now - oldest.ts) / 1000).toFixed(0)}s, pnl=${pnlPct.toFixed(1)}% — accelerating loss`);
          return;
        }
        // Profit velocity reversal: dropped 3%+ in ≤15s from profitable position
        if (velocityPct <= -3 && pnlPct > 0 && this.peakPnlPct >= 5) {
          await this._executeExit(`VELOCITY_PROFIT_DROP [stream]: ${velocityPct.toFixed(1)}% in ${((now - oldest.ts) / 1000).toFixed(0)}s, pnl=+${pnlPct.toFixed(1)}%, peak=+${this.peakPnlPct.toFixed(1)}% — rapid profit erosion`);
          return;
        }
      }
    }

    // ── Small-gain profit protection (peak 1-5% range) ──
    // Exit while still slightly positive to lock in small profits instead of giving them all back.
    // Without this, peaks of 1-5% have zero protection until they hit the trailing stop at -13%.
    if (this.peakPnlPct >= 3 && this.peakPnlPct < 5 && pnlPct <= 0.5 && this.tickCount >= 4) {
      await this._executeExit(`SMALL_GAIN_LOCK [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — locking remaining small profit`);
      return;
    }
    if (this.peakPnlPct >= 2 && this.peakPnlPct < 3 && pnlPct <= 0.5 && this.tickCount >= 4) {
      await this._executeExit(`TINY_GAIN_LOCK [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — locking remaining tiny profit`);
      return;
    }
    if (this.peakPnlPct >= 1.0 && this.peakPnlPct < 2 && pnlPct <= 0.4 && this.tickCount >= 4) {
      await this._executeExit(`MICRO_GAIN_LOCK [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPct.toFixed(1)}% — locking remaining micro profit`);
      return;
    }

    // ── Bad entry fast-cut rules (minimize loss on entries that were immediately wrong) ──

    // Never confirmed: position never went positive within first 3 ticks (~30s) and already -1.5%
    if (this.peakPnlPct < 0.3 && pnlPct <= -1.5 && this.tickCount >= 3 && this.tickCount <= 8) {
      await this._executeExit(`NEVER_CONFIRMED [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPct.toFixed(1)}% — price never went positive, cutting early`);
      return;
    }

    // Immediate adverse: price has fallen every tick since fill and already -3%
    if (this.peakPnlPct < 0.5 && pnlPct <= -3 && this.streamConsecutiveDeclines >= 3 && this.tickCount >= 3) {
      await this._executeExit(`IMMEDIATE_ADVERSE [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPct.toFixed(1)}%, ${this.streamConsecutiveDeclines} consecutive drops — entry immediately wrong`);
      return;
    }

    // Bad entry cut: never confirmed (peak < +1%) after 40s and losing -1.5%+ (tightened from -2%/60s)
    if (this.peakPnlPct < 1.0 && pnlPct <= -1.5 && this.tickCount >= 4) {
      await this._executeExit(`BAD_ENTRY_CUT [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPct.toFixed(1)}% — thesis never confirmed after ${Math.round(this.tickCount * 10 / 60)}+ min`);
      return;
    }

    // Early bleed: never profitable and already -3% (tightened from -4%/4 ticks)
    if (this.peakPnlPct < 1.0 && pnlPct <= -3 && this.tickCount >= 3) {
      await this._executeExit(`EARLY_BLEED [stream]: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPct.toFixed(1)}% — never profitable`);
      return;
    }
  }

  /**
   * Every 10 s tick:
   *   1. Fetch live price and DB state
   *   2. Hard stop / TP / expiry (deterministic — always fires first)
   *   3. AI check every 3rd tick (~30 s) when orchestrator is silent
   *
   * Re-entrant guard (_monitorRunning) prevents overlap between the immediate
   * post-fill call and the next setInterval tick.
   */
  private async _monitorPosition(): Promise<void> {
    if (this._monitorRunning) return;
    this._monitorRunning = true;
    try {
      await this._doMonitorPosition();
    } finally {
      this._monitorRunning = false;
    }
  }

  private async _doMonitorPosition(): Promise<void> {
    const { decision, candidate } = this.cfg;
    const symbol = candidate.contract.symbol;
    const ticker = decision.ticker;

    const priceMap     = await getAlpacaPositionPrices();
    const currentPrice = priceMap.get(symbol);
    if (currentPrice == null) {
      console.warn(`[OrderAgent ${ticker}] No broker price for ${symbol} — tick ${this.tickCount} skipped (position may have closed at broker)`);
      return;
    }

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
    const dbStop = current_stop ? parseFloat(current_stop) : null;
    const tp     = current_tp   ? parseFloat(current_tp)   : null;

    // ── 0. Trailing stop: 15% from peak (ratchets up only) ────────────────
    const stop = await this._updateTrailingStop(currentPrice, dbStop);

    // Sync in-memory stop/TP so stream-triggered checks always use the latest values
    this.currentStop = stop;
    this.currentTp   = tp;

    // ── 0b. Track price direction (10 s granularity) ───────────────────────
    const prevPrice = this.lastPrice;
    this.lastPrice  = currentPrice;
    if (prevPrice !== null) {
      if (currentPrice < prevPrice) {
        this.consecutiveDeclines++;
      } else {
        this.consecutiveDeclines = 0;
      }
    }

    // Record into velocity buffer (shared with stream handler)
    const nowMs = Date.now();
    this.priceHistory.push({ price: currentPrice, ts: nowMs });
    if (this.priceHistory.length > 20) this.priceHistory.shift();

    // ── 1. Hard stop / TP (deterministic, no AI override) ─────────────────
    if (currentPrice <= stop) {
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
        // Compute ET minutes via DST-aware offset (same logic as computeEodWindow in decision-orchestrator)
        const year     = now.getUTCFullYear();
        const dstStart = new Date(Date.UTC(year, 2, 1));
        dstStart.setUTCDate(1 + ((7 - dstStart.getUTCDay()) % 7) + 7); // 2nd Sunday March
        const dstEnd   = new Date(Date.UTC(year, 10, 1));
        dstEnd.setUTCDate(1 + ((7 - dstEnd.getUTCDay()) % 7)); // 1st Sunday November
        const isDst        = now >= dstStart && now < dstEnd;
        const etOffsetMin  = isDst ? -4 * 60 : -5 * 60;
        const etMinutes    = (now.getUTCHours() * 60 + now.getUTCMinutes() + etOffsetMin + 24 * 60) % (24 * 60);
        const minsToClose  = 16 * 60 - etMinutes; // minutes until 4:00 PM ET

        if (minsToClose >= 25 && minsToClose <= 35 && !this.expiryWarningSent) {
          this.expiryWarningSent = true;
          await notifyAlert(
            `⏰ <b>Expiry Warning: ${ticker}</b>\n` +
            `<code>${symbol}</code> expires TODAY\n` +
            `Position still open — ~30 min to market close!`,
          );
        } else if (minsToClose >= 0 && minsToClose <= 15) {
          await this._executeExit('EXPIRY_FORCE_CLOSE');
          return;
        }
      }
    }

    // ── 2b. Deterministic exit rules (no AI — fire before AI check) ─────────
    // These protect profits and cut losses faster than waiting for AI evaluation.
    const entryForRapid = this.fillPrice ?? candidate.entryPremium;
    const pnlPctNow = entryForRapid > 0 ? ((currentPrice - entryForRapid) / entryForRapid) * 100 : 0;

    // Track rolling pnl for hold-trap detection (keep last 15 values — ~150s at 10s ticks)
    this.recentTickPnls.push(pnlPctNow);
    if (this.recentTickPnls.length > 15) this.recentTickPnls.shift();

    // Rapid-decline: 9+ consecutive drops (~90s) AND P&L ≤ -6%
    if (this.consecutiveDeclines >= 9 && pnlPctNow <= -6) {
      await this._executeExit(
        `RAPID_DECLINE: ${this.consecutiveDeclines} consecutive ticks falling,` +
        ` pnl=${pnlPctNow.toFixed(1)}%`,
      );
      return;
    }

    // ── Profit-lock exits: deterministic — no consecutiveDeclines dependency ──
    // Fire purely on peak-erosion % + minimum hold time (tickCount).
    // Catches slow bleed-outs where small bounces reset consecutiveDeclines.
    // Ordered largest peak first so the tightest threshold wins.

    const pnlRetainedPct = this.peakPnlPct > 0 ? (pnlPctNow / this.peakPnlPct) * 100 : 100;

    // Extreme peak (≥35%): gave back 40%+ of gains → lock in
    if (this.peakPnlPct >= 35 && pnlRetainedPct < 60 && pnlPctNow > 0 && this.tickCount >= 4) {
      await this._executeExit(
        `PROFIT_LOCK_EXTREME: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% (${pnlRetainedPct.toFixed(0)}% of peak) — locking exceptional profit`,
      );
      return;
    }
    // Large peak (≥25%): gave back 50%+ of gains
    if (this.peakPnlPct >= 25 && pnlRetainedPct < 50 && pnlPctNow > 0 && this.tickCount >= 4) {
      await this._executeExit(
        `PROFIT_LOCK_LARGE: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% (${pnlRetainedPct.toFixed(0)}% of peak) — locking profit`,
      );
      return;
    }
    // Medium peak (≥20%): gave back 50%+ of gains
    if (this.peakPnlPct >= 20 && pnlRetainedPct < 50 && pnlPctNow > 0 && this.tickCount >= 4) {
      await this._executeExit(
        `PROFIT_LOCK_MEDIUM: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% (${pnlRetainedPct.toFixed(0)}% of peak) — locking profit`,
      );
      return;
    }
    // Moderate peak (≥15%): gave back 55%+ of gains
    if (this.peakPnlPct >= 15 && pnlRetainedPct < 45 && pnlPctNow > 0 && this.tickCount >= 6) {
      await this._executeExit(
        `PROFIT_LOCK_MODERATE: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% (${pnlRetainedPct.toFixed(0)}% of peak) — locking profit`,
      );
      return;
    }
    // Small peak (≥10%): gave back 60%+ of gains
    if (this.peakPnlPct >= 10 && pnlRetainedPct < 40 && pnlPctNow > 0 && this.tickCount >= 8) {
      await this._executeExit(
        `PROFIT_LOCK_SMALL: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% (${pnlRetainedPct.toFixed(0)}% of peak) — locking remaining profit`,
      );
      return;
    }

    // ── Mature position profit protection ──────────────────────────────────────
    // After 40+ min, option theta decay accelerates. Lock in profits — no decline dependency.
    const minutesHeld = Math.floor((Date.now() - new Date(this.openedAt).getTime()) / 60_000);
    if (minutesHeld >= 40 && pnlPctNow >= 15 && pnlPctNow < this.peakPnlPct * 0.85) {
      await this._executeExit(
        `MATURE_PROFIT_EXIT: held=${minutesHeld}min, pnl=+${pnlPctNow.toFixed(1)}%, peak=+${this.peakPnlPct.toFixed(1)}% — protecting mature profit`,
      );
      return;
    }
    // Held 30+ min with +20% — lock in if any erosion from peak
    if (minutesHeld >= 30 && pnlPctNow >= 20 && pnlPctNow < this.peakPnlPct * 0.85) {
      await this._executeExit(
        `MATURE_PROFIT_EXIT: held=${minutesHeld}min, pnl=+${pnlPctNow.toFixed(1)}%, peak=+${this.peakPnlPct.toFixed(1)}% — locking +20% profit after 30 min`,
      );
      return;
    }

    // ── Peak-erosion exits: exit while still in profit, never let profit turn to loss ──
    if (this.peakPnlPct >= 20 && pnlPctNow <= 8) {
      await this._executeExit(
        `PEAK_EROSION: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — protecting remaining profit`,
      );
      return;
    }
    if (this.peakPnlPct >= 12 && pnlPctNow <= 3) {
      await this._executeExit(
        `PEAK_GONE: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — locking last gains`,
      );
      return;
    }
    if (this.peakPnlPct >= 10 && pnlPctNow <= 2) {
      await this._executeExit(
        `PEAK_REVERSAL: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — gains nearly gone`,
      );
      return;
    }
    if (this.peakPnlPct >= 5 && pnlPctNow <= 0.5) {
      await this._executeExit(
        `PEAK_GAINS_GONE: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — locking remainder before loss`,
      );
      return;
    }
    // Last resort for any profitable position turning negative — exit immediately at breakeven
    if (this.peakPnlPct >= 1.0 && pnlPctNow <= 0 && (this.tickCount >= 3 || this.peakPnlPct >= 5)) {
      await this._executeExit(
        `PROFIT_REVERSED: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPctNow.toFixed(1)}% — exiting at breakeven`,
      );
      return;
    }

    // Hold-trap: position was profitable but has been consistently losing for 9+ ticks (~90s).
    // Catches cases where the AI repeatedly HOLDs through a profit→loss transition.
    if (this.peakPnlPct > 0 && pnlPctNow <= -3 && this.recentTickPnls.length >= 9) {
      const last9 = this.recentTickPnls.slice(-9);
      const allNegative = last9.every(p => p <= -2);
      if (allNegative) {
        await this._executeExit(
          `HOLD_TRAP: position was profitable (peak=+${this.peakPnlPct.toFixed(1)}%)` +
          ` but negative for 9 consecutive ticks (~90s) — now=${pnlPctNow.toFixed(1)}%`,
        );
        return;
      }
    }

    // ── Velocity-based exits (rate of P&L change within a rolling window) ──
    if (this.priceHistory.length >= 3) {
      const windowMs = 15_000;
      const cutoffTs = nowMs - windowMs;
      const oldest = this.priceHistory.find(p => p.ts >= cutoffTs) ?? this.priceHistory[0]!;
      if (oldest.price > 0) {
        const velocityPct = ((currentPrice - oldest.price) / oldest.price) * 100;
        if (velocityPct <= -4) {
          await this._executeExit(
            `VELOCITY_CRASH: ${velocityPct.toFixed(1)}% in ${((nowMs - oldest.ts) / 1000).toFixed(0)}s — rapid price collapse`,
          );
          return;
        }
        if (velocityPct <= -2.5 && pnlPctNow < 0) {
          await this._executeExit(
            `VELOCITY_FADE: ${velocityPct.toFixed(1)}% in ${((nowMs - oldest.ts) / 1000).toFixed(0)}s, pnl=${pnlPctNow.toFixed(1)}% — accelerating loss`,
          );
          return;
        }
        if (velocityPct <= -3 && pnlPctNow > 0 && this.peakPnlPct >= 5) {
          await this._executeExit(
            `VELOCITY_PROFIT_DROP: ${velocityPct.toFixed(1)}% in ${((nowMs - oldest.ts) / 1000).toFixed(0)}s, pnl=+${pnlPctNow.toFixed(1)}%, peak=+${this.peakPnlPct.toFixed(1)}% — rapid profit erosion`,
          );
          return;
        }
      }
    }

    // ── Small-gain profit protection (peak 1-5% range) ──
    if (this.peakPnlPct >= 3 && this.peakPnlPct < 5 && pnlPctNow <= 0.5 && this.tickCount >= 4) {
      await this._executeExit(
        `SMALL_GAIN_LOCK: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — locking remaining small profit`,
      );
      return;
    }
    if (this.peakPnlPct >= 2 && this.peakPnlPct < 3 && pnlPctNow <= 0.5 && this.tickCount >= 4) {
      await this._executeExit(
        `TINY_GAIN_LOCK: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — locking remaining tiny profit`,
      );
      return;
    }
    if (this.peakPnlPct >= 1.0 && this.peakPnlPct < 2 && pnlPctNow <= 0.4 && this.tickCount >= 4) {
      await this._executeExit(
        `MICRO_GAIN_LOCK: peak=+${this.peakPnlPct.toFixed(1)}%, now=+${pnlPctNow.toFixed(1)}% — locking remaining micro profit`,
      );
      return;
    }

    // ── Bad entry fast-cut rules (minimize loss on entries that were immediately wrong) ──

    // Never confirmed: position never went positive within first 3 ticks (~30s) and already -1.5%
    if (this.peakPnlPct < 0.3 && pnlPctNow <= -1.5 && this.tickCount >= 3 && this.tickCount <= 8) {
      await this._executeExit(
        `NEVER_CONFIRMED: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPctNow.toFixed(1)}%` +
        ` — price never went positive, cutting early`,
      );
      return;
    }

    // Immediate adverse: price has fallen every tick since fill and already -3%
    // Catches entries where price moved against us from the moment we filled.
    if (this.peakPnlPct < 0.5 && pnlPctNow <= -3 && this.consecutiveDeclines >= 3 && this.tickCount >= 3) {
      await this._executeExit(
        `IMMEDIATE_ADVERSE: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPctNow.toFixed(1)}%` +
        ` — ${this.consecutiveDeclines} consecutive drops, entry immediately wrong`,
      );
      return;
    }

    // Bad entry cut: never confirmed (peak < +1%) after 40s and losing -1.5%+ (tightened from -2%/60s).
    if (this.peakPnlPct < 1.0 && pnlPctNow <= -1.5 && this.tickCount >= 4) {
      await this._executeExit(
        `BAD_ENTRY_CUT: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPctNow.toFixed(1)}%` +
        ` — thesis never confirmed after ${Math.round(this.tickCount * 10 / 60)} min, cutting early`,
      );
      return;
    }

    // Early bleed: position NEVER profitable and already -3% (tightened from -4%/4 ticks).
    if (this.peakPnlPct < 1.0 && pnlPctNow <= -3 && this.tickCount >= 3) {
      await this._executeExit(
        `EARLY_BLEED: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPctNow.toFixed(1)}%` +
        ` — never profitable after ${this.tickCount} ticks, cutting losses`,
      );
      return;
    }

    // Stuck-negative: position NEVER reached 1% profit and has been losing for 15+ ticks.
    // Catches slow-bleed entries that oscillate down without 3 consecutive drops (RAPID_DECLINE
    // never fires because any uptick resets consecutiveDeclines). Exit at -5% before hard stop.
    if (this.peakPnlPct < 1.0 && pnlPctNow <= -5 && this.tickCount >= 15) {
      const last15 = this.recentTickPnls.slice(-15);
      const mostlyNegative = last15.filter(p => p < 0).length >= 12; // 12 of last 15 ticks negative
      if (mostlyNegative) {
        await this._executeExit(
          `STUCK_NEGATIVE: peak=+${this.peakPnlPct.toFixed(1)}%, now=${pnlPctNow.toFixed(1)}%` +
          ` — never profitable, losing for ${Math.round(this.tickCount * 10 / 60)} min`,
        );
        return;
      }
    }

    // Pre-emptive loss exit: exit at -10% before hard stop fires at ~-13%.
    // Saves 3%+ per trade. Only activates after 90s (9 ticks) to avoid entry-bar noise.
    if (pnlPctNow <= -10 && this.tickCount >= 9) {
      await this._executeExit(
        `PRE_EMPTIVE_LOSS: pnl=${pnlPctNow.toFixed(1)}% — cutting before hard stop`,
      );
      return;
    }

    // ── 3. AI monitoring every 10s tick ──
    // Runs independently of orchestrator dispatches so the agent always has
    // its own 10s-cadence AI evaluation, even when the pipeline is dispatching
    // every ~1 min. The isAIRunning mutex inside _runAIDecision prevents
    // concurrent evaluations if an orchestrator dispatch arrives mid-tick.
    const forceAI = this._forceNextAI;
    this._forceNextAI = false;
    const shouldRunAI =
      forceAI ||
      this.consecutiveDeclines >= 3 ||
      (this.peakPnlPct > 0 && pnlPctNow < 0) ||
      (this.peakPnlPct >= 10 && pnlPctNow < this.peakPnlPct * 0.55) ||   // large peak erosion — urgent AI check
      pnlPctNow <= -8 ||                                                   // deep loss — urgent AI check
      this.tickCount % AI_TICK_INTERVAL === 0;
    if (shouldRunAI) {
      // Fire-and-forget: do NOT await AI so _monitorRunning is released immediately.
      // This ensures the next 30 s tick's deterministic checks (hard stop, TP, profit-lock)
      // always run on schedule even if the Claude API call takes >30 s.
      // isAIRunning mutex inside _runAIDecision prevents concurrent AI evaluations.
      void this._runAIDecision(null, { currentPrice, stop, tp, qty, expiration });
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
  ): Promise<OrderAgentOutcome | null> {
    // Mutex: prevent concurrent AI evaluations (e.g. 30 s tick + orchestrator pipeline firing simultaneously).
    // Without this, two calls can both reach _executeReduce before either changes the phase,
    // causing duplicate reduce orders to be submitted to Alpaca.
    if (this.isAIRunning) {
      // Queue orchestrator suggestions so they are never silently dropped.
      // Pipeline EXIT/REDUCE signals are higher priority than routine periodic checks.
      if (suggestion) {
        this.pendingSuggestion = suggestion;
        console.log(`[OrderAgent ${this.cfg.decision.ticker}] AI already running — queued ${suggestion.decisionType} for immediate processing after current AI completes`);
      } else {
        console.log(`[OrderAgent ${this.cfg.decision.ticker}] AI already running — skipping periodic tick`);
      }
      return null;
    }
    this.isAIRunning = true;

    try {
    // If called from processOrchestratorDecision, fetch live state ourselves
    let s = state;
    if (!s) {
      const priceMap = await getAlpacaPositionPrices();
      const currentPrice = priceMap.get(this.cfg.candidate.contract.symbol);
      if (currentPrice == null) return null;

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
      if (rows.length === 0) { this._stopTick(); this._selfRemove(); return null; }
      const row = rows[0]!;
      const dbStop = row.current_stop ? parseFloat(row.current_stop) : null;
      // Update trailing stop with this fresh price so peaks seen by the
      // orchestrator pipeline (1 min cadence) are not missed by the 30 s tick loop.
      const updatedStop = await this._updateTrailingStop(currentPrice, dbStop);
      s = {
        currentPrice,
        stop:       updatedStop,
        tp:         row.current_tp ? parseFloat(row.current_tp) : null,
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
            confidence:    suggestion.confidence ?? null,
          }
        : null,
      // Live position state
      position: {
        option_symbol:       candidate.contract.symbol,
        option_side:         candidate.contract.side,
        strike:              candidate.contract.strike,
        entry_price:         entryPrice.toFixed(2),
        current_price:       s.currentPrice.toFixed(2),
        unrealized_pnl_pct:  pnlPct.toFixed(1),
        // Highest P&L% ever reached — key for detecting peak-erosion situations
        peak_pnl_pct:        this.peakPnlPct.toFixed(1),
        stop_price:          s.stop?.toFixed(2)  ?? 'none',
        tp_price:            s.tp?.toFixed(2)    ?? 'none',
        qty:                 s.qty,
        minutes_held:        minutesHeld,
        minutes_to_expiry:   minutesToExp,
        // Real-time price momentum from 10 s tick history
        price_trend:         this.consecutiveDeclines >= 12 ? 'falling_fast'
                           : this.consecutiveDeclines >= 6 ? 'falling'
                           : this.consecutiveDeclines >= 3 ? 'slight_dip'
                           : 'stable_or_rising',
        consecutive_declines: this.consecutiveDeclines,
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
      // Current market context — from orchestrator dispatch (fresh) or cached from last dispatch (stale ≤1 min).
      // Null only on the very first self-tick before any orchestrator dispatch has arrived.
      market_context: (() => {
        if (suggestion?.marketContext) this.cachedMarketContext = suggestion.marketContext;
        const ctx = this.cachedMarketContext;
        if (!ctx) return null;
        return {
          direction:             ctx.direction,
          alignment:             ctx.alignment,
          strength_score:        ctx.strengthScore,
          key_factors:           ctx.keyFactors,
          risks:                 ctx.risks,
          trend_supports_position:
            (candidate.contract.side === 'call' && ctx.direction === 'bullish') ||
            (candidate.contract.side === 'put'  && ctx.direction === 'bearish'),
          source: suggestion?.marketContext ? 'fresh' : 'cached',
        };
      })(),
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

      return await this._applyRecommendation(rec, s.stop, s.qty, s.currentPrice, pnlPct, suggestion);
    } catch (err) {
      // AI errors are non-fatal; hard stops still protect the position
      console.warn(
        `[OrderAgent ${decision.ticker}] AI error (non-fatal):`,
        (err as Error).message,
      );
      return null;
    }
    } finally {
      this.isAIRunning = false;

      // Drain queued orchestrator suggestion that arrived while AI was running.
      // This ensures pipeline EXIT/REDUCE signals are never silently dropped.
      const queued = this.pendingSuggestion;
      this.pendingSuggestion = null;
      if (queued && this.phase === 'MONITORING') {
        console.log(
          `[OrderAgent ${this.cfg.decision.ticker}] Processing queued ${queued.decisionType} suggestion`,
        );
        // Run asynchronously but don't block the finally clause
        void this._runAIDecision(queued);
      }
    }
  }

  private async _applyRecommendation(
    rec: AiRecommendation,
    currentStop: number | null,
    qty: number,
    currentPrice: number,
    pnlPct: number,
    suggestion: OrchestratorSuggestion | null,
  ): Promise<OrderAgentOutcome> {
    const symbol = this.cfg.candidate.contract.symbol;
    const marketContextSource = (suggestion?.marketContext ? 'fresh' : this.cachedMarketContext ? 'cached' : 'none') as 'fresh' | 'cached' | 'none';

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
        marketContextSource,
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

      case 'ADJUST_STOP':
        // Trailing stop is automatic — treat ADJUST_STOP as HOLD and notify so the
        // decision is visible in Telegram rather than silently discarded.
        console.log(`[OrderAgent ${this.cfg.decision.ticker}] AI ADJUST_STOP → HOLD (trailing stop is automatic)`);
        notifyOrderAgentDecision({
          action:                 'HOLD',
          ticker:                 this.cfg.decision.ticker,
          optionSymbol:           symbol,
          optionSide:             this.cfg.candidate.contract.side,
          reasoning:              `[ADJUST_STOP] ${rec.reasoning}`,
          overridingOrchestrator: rec.overriding_orchestrator,
          orchestratorSuggestion: suggestion?.decisionType ?? null,
          pnlPct,
          currentPrice,
          entryPrice:             this.fillPrice ?? this.cfg.candidate.entryPremium,
          peakPnlPct:             this.peakPnlPct,
          consecutiveDeclines:    this.consecutiveDeclines,
          oldStop:                currentStop,
          marketContextSource,
        }).catch(err => console.warn(`[OrderAgent ${this.cfg.decision.ticker}] Notify error:`, (err as Error).message));
        break;

      case 'HOLD':
      default:
        // Notify on every HOLD so the user can see all agent decisions,
        // including periodic independent checks and orchestrator dispatches.
        notifyOrderAgentDecision({
          action:                 'HOLD',
          ticker:                 this.cfg.decision.ticker,
          optionSymbol:           symbol,
          optionSide:             this.cfg.candidate.contract.side,
          reasoning:              rec.reasoning,
          overridingOrchestrator: rec.overriding_orchestrator,
          orchestratorSuggestion: suggestion?.decisionType ?? null,
          pnlPct,
          currentPrice,
          entryPrice:             this.fillPrice ?? this.cfg.candidate.entryPremium,
          peakPnlPct:             this.peakPnlPct,
          consecutiveDeclines:    this.consecutiveDeclines,
          oldStop:                currentStop,
          marketContextSource,
        }).catch(err => console.warn(`[OrderAgent ${this.cfg.decision.ticker}] Notify error:`, (err as Error).message));
        break;
    }

    return {
      action:                 rec.action,
      reasoning:              rec.reasoning,
      overridingOrchestrator: rec.overriding_orchestrator,
      optionSymbol:           symbol,
      pnlPct,
    };
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
      if (order?.filled_avg_price) {
        const price = parseFloat(order.filled_avg_price);
        if (price > 0) return price; // paper trading may return "0" before async fill
      }
      if (['canceled', 'expired', 'rejected'].includes(order?.status ?? '')) break;
    }
    return null;
  }

  /**
   * Ratchet the trailing stop (15% below peak) upward whenever a fresh price is
   * available. Called from both _monitorPosition (30 s tick) and _runAIDecision
   * (1 min orchestrator cadence) so that brief peaks are never missed.
   *
   * Returns the effective stop to use for the current check:
   *   Math.max(new trailing stop, existing DB stop)
   */
  private async _updateTrailingStop(currentPrice: number, dbStop: number | null): Promise<number> {
    const entryForTrail = this.fillPrice ?? this.cfg.candidate.entryPremium;
    if (this.highestPrice === null) this.highestPrice = entryForTrail;
    if (currentPrice > this.highestPrice) this.highestPrice = currentPrice;

    // Track peak P&L % — ratchets up only, never resets
    if (entryForTrail > 0) {
      const peakNow = ((this.highestPrice - entryForTrail) / entryForTrail) * 100;
      this.peakPnlPct = Math.max(this.peakPnlPct, peakNow);
    }

    // Adaptive trailing stop: tighten as gains grow to protect more profit at large peaks
    //   Peak < 25%:  13% trailing (0.87 factor)
    //   Peak ≥ 25%:  10% trailing (0.90 factor) — lock in more from a large run
    //   Peak ≥ 40%:   8% trailing (0.92 factor) — lock in most of an exceptional run
    const trailFactor = this.peakPnlPct >= 40 ? 0.92
                      : this.peakPnlPct >= 25 ? 0.90
                      : 0.87;
    const rawTrailingStop = parseFloat((this.highestPrice * trailFactor).toFixed(2));

    // Profit-protection floors — once a profit threshold is crossed, the stop never
    // falls below that floor.  This prevents giving back gains on small/moderate peaks
    // where the raw trailing stop would still be below the entry price.
    //   Peak ≥  +3% → stop floor at -0.5% (near breakeven)
    //   Peak ≥  +5% → stop floor at breakeven (entry)
    //   Peak ≥ +10% → stop floor at breakeven (entry)
    //   Peak ≥ +15% → stop floor at +3% profit
    //   Peak ≥ +20% → stop floor at +8% profit
    //   Peak ≥ +30% → stop floor at +18% profit
    //   Peak ≥ +40% → stop floor at +25% profit (new — exceptional run protection)
    let profitFloor = 0;
    if      (this.peakPnlPct >= 40) profitFloor = parseFloat((entryForTrail * 1.25).toFixed(2));
    else if (this.peakPnlPct >= 30) profitFloor = parseFloat((entryForTrail * 1.18).toFixed(2));
    else if (this.peakPnlPct >= 20) profitFloor = parseFloat((entryForTrail * 1.08).toFixed(2));
    else if (this.peakPnlPct >= 15) profitFloor = parseFloat((entryForTrail * 1.03).toFixed(2));
    else if (this.peakPnlPct >= 10) profitFloor = parseFloat(entryForTrail.toFixed(2));
    else if (this.peakPnlPct >= 5)  profitFloor = parseFloat(entryForTrail.toFixed(2)); // breakeven floor once 5% peak reached
    else if (this.peakPnlPct >= 3)  profitFloor = parseFloat((entryForTrail * 0.995).toFixed(2)); // near-breakeven floor for small gains

    const trailingStop = parseFloat(Math.max(rawTrailingStop, profitFloor).toFixed(2));

    const pool = getPool();
    if (dbStop === null || trailingStop > dbStop) {
      await pool.query(
        `UPDATE trading.position_journal SET current_stop=$1, peak_pnl_pct=GREATEST(COALESCE(peak_pnl_pct,0),$2) WHERE id=$3 AND status='OPEN'`,
        [trailingStop, this.peakPnlPct, this.positionId],
      );
    } else {
      // Stop didn't move but peak may have — persist peak separately
      await pool.query(
        `UPDATE trading.position_journal SET peak_pnl_pct=GREATEST(COALESCE(peak_pnl_pct,0),$1) WHERE id=$2 AND status='OPEN'`,
        [this.peakPnlPct, this.positionId],
      );
    }
    return Math.max(trailingStop, dbStop ?? 0);
  }

  /** Close the full position. Idempotent — CLOSING/CLOSED phases guard double-exit. */
  private async _executeExit(reason: string): Promise<void> {
    if (this.phase === 'CLOSING' || this.phase === 'CLOSED') return;
    this.phase = 'CLOSING';
    this._stopTick();
    AlpacaStreamManager.getInstance().unwatchOptionQuote(this.cfg.candidate.contract.symbol);

    // Track deterministic exits in DB. AI_EXIT and IMMEDIATE: are already persisted by their callers.
    if (this.positionId && !reason.startsWith('AI_') && !reason.startsWith('IMMEDIATE:')) {
      const trackedPrice = this.lastPrice;
      if (trackedPrice != null) {
        const entryForCalc = this.fillPrice ?? this.cfg.candidate.entryPremium;
        const pnlPct = entryForCalc > 0 ? ((trackedPrice - entryForCalc) / entryForCalc) * 100 : 0;
        void insertAgentTick({
          positionId:             this.positionId,
          tickCount:              this.tickCount,
          action:                 'EXIT',
          reasoning:              reason,
          pnlPct:                 Math.round(pnlPct * 100) / 100,
          currentPrice:           trackedPrice,
          overridingOrchestrator: false,
          marketContextSource:    this.cachedMarketContext ? 'cached' : 'none',
        }).catch(() => {});
      }
    }

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

    // Detect Alpaca 42210000 — "position intent mismatch, inferred: sell_to_open".
    // This means Alpaca has no long position for this symbol (expired worthless, already
    // closed on their side, etc.).  Treat the exit price as $0 so we record a full loss
    // and close the DB record cleanly rather than leaving it stuck as OPEN.
    let positionGoneFromAlpaca = false;
    if (error) {
      try {
        const errObj = JSON.parse(error) as { code?: number };
        if (errObj.code === 42210000) {
          positionGoneFromAlpaca = true;
          console.warn(
            `[OrderAgent ${ticker} ${symbol}] Position not found in Alpaca (code 42210000) —` +
            ` recording as $0 exit (expired worthless / already closed)`,
          );
        }
      } catch { /* non-JSON error body — fall through */ }
    }

    // Paper-trading options fill asynchronously — poll if not immediately filled
    let exitFill = immediateExitFill;
    if (!exitFill && alpacaOrderId && !error) {
      exitFill = await this._pollSellFill(alpacaOrderId) ?? undefined;
      if (exitFill) {
        console.log(`[OrderAgent ${ticker} ${symbol}] Polled sell fill: $${exitFill}`);
      } else {
        console.warn(`[OrderAgent ${ticker} ${symbol}] Sell fill not confirmed within 15s — recording as fill_pending`);
      }
    }

    // Always derive both prices from confirmed fills, never from the stale DB column.
    // If Alpaca had no position (code 42210000), record exit at $0 (full loss).
    // If sell fill was not confirmed within 15 s, exitPrice stays null so evaluation
    // is skipped rather than recording a misleading 0% P&L.
    const entryPrice = this.fillPrice ?? candidate.entryPremium;
    const exitPrice: number | null = positionGoneFromAlpaca ? 0 : (exitFill ?? null);

    // Record sell order and close position in DB.
    // Errors here are non-fatal — evaluation must still run regardless.
    try {
      await insertOrder({
        id: uuidv4(),
        positionId:    this.positionId,
        decisionId:    decision.id,
        ticker,
        optionSymbol:  symbol,
        alpacaOrderId,
        alpacaStatus:  error ? 'error' : (exitFill ? 'filled' : 'fill_pending'),
        orderSide:     'sell',
        orderType:     'market',
        positionIntent: 'sell_to_close',
        submittedQty:  currentQty,
        filledQty:     exitFill ? currentQty : 0,
        fillPrice:     exitFill,
        errorMessage:  error,
        submittedAt:   new Date().toISOString(),
        filledAt:      exitFill ? new Date().toISOString() : undefined,
      });
      // Pass 0 when fill unconfirmed — closePosition treats 0 as "look up fill from order_executions"
      await closePosition({ positionId: this.positionId, exitPrice: exitPrice ?? 0, entryPrice, closeReason: reason });
    } catch (dbErr) {
      console.error(
        `[OrderAgent ${ticker} ${symbol}] Exit DB error (non-fatal):`,
        (dbErr as Error).message,
      );
    }

    const displayExit = exitPrice ?? entryPrice;
    const pnl = (displayExit - entryPrice) * currentQty * 100;
    const pnlStr = exitPrice != null
      ? (pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)
      : '(fill pending)';
    const emoji  = reason.startsWith('STOP')            ? '🛑'
                 : reason.startsWith('TP')              ? '🎯'
                 : reason.startsWith('EXPIRY')          ? '⚠️'
                 : reason.startsWith('AI_EXIT')         ? '🤖'
                 : reason.startsWith('UNFILLED_')       ? '🚫'
                 : reason.startsWith('PROFIT_LOCK')     ? '🔒'
                 : reason.startsWith('PEAK')            ? '📉'
                 : reason.startsWith('RAPID_DECLINE')   ? '📉'
                 : reason.startsWith('HOLD_TRAP')       ? '📉'
                 : reason.startsWith('PRE_EMPTIVE')     ? '✂️'
                 : reason.startsWith('PROFIT_REVERSED') ? '🔄'
                 : reason.startsWith('VELOCITY')          ? '💨'
                 : reason.startsWith('SMALL_GAIN')      ? '🔒'
                 : reason.startsWith('TINY_GAIN')       ? '🔒'
                 : reason.startsWith('MICRO_GAIN')      ? '🔒'
                 : reason.startsWith('NEVER_CONFIRMED') ? '❌'
                 : reason.startsWith('IMMEDIATE_ADVERSE') ? '❌'
                 : reason.startsWith('IMMEDIATE')       ? '⚡'
                 : reason.startsWith('BAD_ENTRY')       ? '❌'
                 : '🚪';

    // Label the source so the notification is unambiguous
    const sourceLabel = reason.startsWith('AI_EXIT')
      ? 'OrderAgent AI'
      : reason.startsWith('STOP') || reason.startsWith('TP')
        ? 'Hard stop / TP'
        : reason.startsWith('EXPIRY')
          ? 'Expiry close'
          : reason.startsWith('IMMEDIATE:')
            ? 'Orchestrator (immediate)'
            : reason.startsWith('UNFILLED_')
              ? 'Fill timeout'
              : reason.startsWith('VELOCITY')
                ? 'Velocity exit'
                : reason.startsWith('SMALL_GAIN') || reason.startsWith('TINY_GAIN')
                  ? 'Small-gain protection'
                  : reason.startsWith('NEVER_CONFIRMED') || reason.startsWith('IMMEDIATE_ADVERSE') || reason.startsWith('BAD_ENTRY')
                    ? 'Bad entry fast-cut'
                    : 'Deterministic rule';

    await notifyAlert(
      `${emoji} <b>Exit: ${ticker}</b> — ${sourceLabel}\n` +
      `<code>${symbol}</code>\n` +
      `${reason.slice(0, 120)}\n` +
      `Entry: $${entryPrice.toFixed(2)} → Exit: ${exitPrice != null ? `$${exitPrice.toFixed(2)}` : '(fill pending)'}\n` +
      `P&L: <b>${pnlStr}</b> | Qty: ${currentQty}`,
    ).catch(err => console.warn(`[OrderAgent ${ticker}] Notify error:`, (err as Error).message));

    // Skip evaluation when fill price wasn't confirmed — a 0% P&L record would corrupt AI history
    if (exitPrice != null) {
      await this._triggerEvaluation(exitPrice, reason);
    } else {
      console.warn(`[OrderAgent ${ticker} ${symbol}] Skipping evaluation — sell fill unconfirmed`);
    }
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

    const submittedAt = new Date().toISOString();
    const orderId = uuidv4();

    if (error) {
      console.error(`[OrderAgent ${decision.ticker}] Reduce error: ${error}`);
      await insertOrder({
        id: orderId,
        positionId:    this.positionId,
        decisionId:    decision.id,
        ticker:        decision.ticker,
        optionSymbol:  symbol,
        alpacaOrderId,
        alpacaStatus:  'error',
        orderSide:     'sell',
        orderType:     'market',
        positionIntent: 'sell_to_close',
        submittedQty:  reduceQty,
        filledQty:     0,
        errorMessage:  error,
        submittedAt,
      });
      return;
    }

    // Poll for fill — reduce orders via DELETE /positions fill asynchronously
    let reduceFill: number | null = null;
    let actualFilledQty = 0;
    if (alpacaOrderId) {
      reduceFill = await this._pollSellFill(alpacaOrderId);
      if (reduceFill != null) {
        actualFilledQty = reduceQty; // market sell — if filled, full qty filled
        console.log(`[OrderAgent ${decision.ticker} ${symbol}] Reduce fill confirmed: qty=${actualFilledQty} @ $${reduceFill}`);
      } else {
        console.warn(`[OrderAgent ${decision.ticker} ${symbol}] Reduce fill not confirmed within 15s — checking Alpaca order`);
        const order = await getAlpacaOrder(alpacaOrderId);
        actualFilledQty = order?.filled_qty ? parseInt(order.filled_qty) : 0;
        reduceFill = order?.filled_avg_price ? parseFloat(order.filled_avg_price) : null;
      }
    }

    await insertOrder({
      id: orderId,
      positionId:    this.positionId,
      decisionId:    decision.id,
      ticker:        decision.ticker,
      optionSymbol:  symbol,
      alpacaOrderId,
      alpacaStatus:  reduceFill ? 'filled' : 'submitted',
      orderSide:     'sell',
      orderType:     'market',
      positionIntent: 'sell_to_close',
      submittedQty:  reduceQty,
      filledQty:     actualFilledQty,
      fillPrice:     reduceFill ?? undefined,
      submittedAt,
      filledAt:      reduceFill ? new Date().toISOString() : undefined,
    });

    if (actualFilledQty === 0) {
      console.warn(`[OrderAgent ${decision.ticker}] Reduce submitted but 0 contracts filled — skipping DB qty decrement`);
      return;
    }

    // Decrement qty in DB by actually-filled qty so subsequent monitor ticks and exits are correct
    const pool = getPool();
    await pool.query(
      `UPDATE trading.position_journal
          SET qty = GREATEST(qty - $1, 0)
        WHERE id = $2 AND status = 'OPEN'`,
      [actualFilledQty, this.positionId],
    );
    console.log(`[OrderAgent ${decision.ticker}] position_journal.qty decremented by ${actualFilledQty}`);

    const entryForPnl = this.fillPrice ?? candidate.entryPremium;
    const pnlPct = entryForPnl > 0 && reduceFill
      ? ((reduceFill - entryForPnl) / entryForPnl) * 100 : 0;

    if (this.positionId) {
      void insertAgentTick({
        positionId:             this.positionId,
        tickCount:              this.tickCount,
        action:                 'REDUCE',
        reasoning:              reason,
        pnlPct:                 Math.round(pnlPct * 100) / 100,
        currentPrice:           reduceFill ?? this.lastPrice ?? 0,
        overridingOrchestrator: false,
        marketContextSource:    this.cachedMarketContext ? 'cached' : 'none',
      }).catch(() => {});
    }

    const pnlSign = pnlPct >= 0 ? '+' : '';
    await notifyAlert(
      `📉 <b>OrderAgent: REDUCE — ${decision.ticker}</b>\n` +
      `<code>${symbol}</code>\n` +
      `${reason.slice(0, 120)}\n` +
      `Reduced: ${actualFilledQty} contract(s)` +
      (reduceFill ? ` @ $${reduceFill.toFixed(2)}` : '') +
      ` | P&L: <b>${pnlSign}${pnlPct.toFixed(1)}%</b>`,
    ).catch(err => console.warn(`[OrderAgent ${decision.ticker}] Notify error:`, (err as Error).message));
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
