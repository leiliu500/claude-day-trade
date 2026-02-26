/**
 * OrderAgent — dynamically spawned per NEW_ENTRY decision.
 *
 * Owns the full lifecycle of one position:
 *   PENDING → submit Alpaca limit buy
 *   AWAITING_FILL → poll order status every 30 s
 *   MONITORING → compare currentPrice vs stop / TP / expiry every 30 s
 *   CLOSING → exit order submitted (idempotent guard)
 *   CLOSED / FAILED → terminal; agent removes itself from registry
 *
 * Minimal config — only position-relevant data, no signal timeframes or AI context.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client.js';
import { insertPosition, closePosition } from '../db/repositories/positions.js';
import { insertOrder } from '../db/repositories/orders.js';
import { insertEvaluation } from '../db/repositories/evaluations.js';
import { EvaluationAgent } from './evaluation-agent.js';
import { notifyAlert } from '../telegram/notifier.js';
import {
  submitLimitBuyOrder,
  submitMarketSellOrder,
  reduceAlpacaPosition,
  getAlpacaOrder,
  getAlpacaPositionPrices,
} from '../lib/alpaca-api.js';
import type { OptionCandidate } from '../types/options.js';
import type { SizeResult, OrderRecord } from '../types/trade.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrderAgentPhase =
  | 'AWAITING_FILL'
  | 'MONITORING'
  | 'CLOSING'
  | 'CLOSED'
  | 'FAILED';

export interface OrderAgentConfig {
  decisionId: string;
  sessionId: string;
  ticker: string;
  candidate: OptionCandidate;   // contract details + entry / stop / tp premiums
  sizing: SizeResult;           // qty, limitPrice, conviction tier
  entryConfidence: number;
  entryAlignment: string;
  entryDirection: string;
  entryReasoning: string;
}

/** Restored from DB on startup — order already submitted, position may be filled. */
export interface RestoredOrderAgentConfig extends OrderAgentConfig {
  positionId: string;
  alpacaOrderId: string | null;
  openedAt: string;
}

const TICK_INTERVAL_MS = 30_000; // 30 seconds
const evaluationAgent = new EvaluationAgent();

// ── OrderAgent class ──────────────────────────────────────────────────────────

export class OrderAgent {
  private phase: OrderAgentPhase;
  private positionId: string = '';
  private alpacaOrderId: string | null = null;
  private openedAt: string = '';
  private fillPrice: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private expiryWarningSent = false;

  constructor(private readonly cfg: OrderAgentConfig | RestoredOrderAgentConfig) {
    if ('positionId' in cfg) {
      // Restored from DB: skip submission, go straight to fill check
      this.positionId  = cfg.positionId;
      this.alpacaOrderId = cfg.alpacaOrderId;
      this.openedAt    = cfg.openedAt;
      this.phase       = 'AWAITING_FILL';
    } else {
      this.phase = 'AWAITING_FILL'; // will be set properly in start()
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Submit entry order to Alpaca, persist position + order to DB, start tick loop.
   * Called by registry for fresh positions.
   */
  async start(): Promise<void> {
    const { candidate, sizing, decisionId, sessionId, ticker } = this.cfg;

    // Submit limit buy
    let alpacaResponse = {};
    let errorMessage: string | undefined;

    try {
      alpacaResponse = await submitLimitBuyOrder(
        candidate.contract.symbol,
        sizing.qty,
        sizing.limitPrice,
      );
    } catch (err) {
      errorMessage = (err as Error).message;
      console.error(`[OrderAgent ${ticker}] Entry submission failed: ${errorMessage}`);
    }

    const resp = alpacaResponse as Record<string, string | undefined>;
    this.alpacaOrderId = resp['id'] ?? null;
    this.openedAt = new Date().toISOString();

    // Persist position to DB
    this.positionId = await insertPosition({
      sessionId,
      decisionId,
      ticker,
      candidate,
      sizing,
    });

    // Persist entry order to DB
    const entryOrder: OrderRecord = {
      id: uuidv4(),
      positionId: this.positionId,
      decisionId,
      ticker,
      optionSymbol: candidate.contract.symbol,
      alpacaOrderId: this.alpacaOrderId ?? undefined,
      alpacaStatus: resp['status'] ?? (errorMessage ? 'error' : 'submitted'),
      orderSide: 'buy',
      orderType: 'limit',
      positionIntent: 'buy_to_open',
      submittedQty: sizing.qty,
      filledQty: resp['filled_qty'] ? parseInt(resp['filled_qty']) : 0,
      submittedPrice: sizing.limitPrice,
      fillPrice: resp['filled_avg_price'] ? parseFloat(resp['filled_avg_price']) : undefined,
      errorMessage,
      submittedAt: this.openedAt,
    };
    await insertOrder(entryOrder);

    if (errorMessage) {
      // Close the position record immediately — order never made it
      await this._voidPosition('submission_error');
      this.phase = 'FAILED';
      console.log(`[OrderAgent ${ticker}] Phase: FAILED (submission error)`);
      this._selfRemove();
      return;
    }

    this.phase = 'AWAITING_FILL';
    console.log(
      `[OrderAgent ${ticker} ${candidate.contract.symbol}] Phase: AWAITING_FILL — ` +
      `alpacaOrderId=${this.alpacaOrderId ?? 'none'} positionId=${this.positionId}`,
    );
    this._startTick();
  }

  /**
   * Restore an already-submitted position (used on app restart).
   * Skips order submission; resumes monitoring from fill check.
   */
  startRestored(): void {
    const cfg = this.cfg as RestoredOrderAgentConfig;
    console.log(
      `[OrderAgent ${cfg.ticker} ${cfg.candidate.contract.symbol}] Restored — ` +
      `positionId=${cfg.positionId} phase=AWAITING_FILL`,
    );
    this._startTick();
  }

  /** Orchestrator-triggered EXIT (e.g., pipeline decides EXIT or REVERSE). */
  async handleExit(reason: string): Promise<void> {
    if (this.phase === 'CLOSING' || this.phase === 'CLOSED' || this.phase === 'FAILED') return;
    await this._executeExit(reason);
  }

  /** Orchestrator-triggered partial reduce. */
  async handleReduce(reduceQty: number): Promise<void> {
    if (this.phase !== 'MONITORING') return;
    const { candidate, ticker } = this.cfg;
    const symbol = candidate.contract.symbol;

    console.log(`[OrderAgent ${ticker}] Reducing ${symbol} by qty=${reduceQty}`);
    const { alpacaOrderId, error } = await reduceAlpacaPosition(symbol, reduceQty);

    const order: OrderRecord = {
      id: uuidv4(),
      positionId: this.positionId,
      decisionId: this.cfg.decisionId,
      ticker,
      optionSymbol: symbol,
      alpacaOrderId,
      alpacaStatus: error ? 'error' : 'submitted',
      orderSide: 'sell',
      orderType: 'market',
      positionIntent: 'sell_to_close',
      submittedQty: reduceQty,
      filledQty: 0,
      errorMessage: error,
      submittedAt: new Date().toISOString(),
    };
    await insertOrder(order);
    if (error) {
      console.error(`[OrderAgent ${ticker}] Reduce failed: ${error}`);
    }
  }

  getPhase(): OrderAgentPhase { return this.phase; }
  getPositionId(): string { return this.positionId; }
  getTicker(): string { return this.cfg.ticker; }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _startTick(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this._tick().catch(err =>
        console.error(`[OrderAgent ${this.cfg.ticker}] Tick error:`, (err as Error).message),
      );
    }, TICK_INTERVAL_MS);
  }

  private _stopTick(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async _tick(): Promise<void> {
    switch (this.phase) {
      case 'AWAITING_FILL': return this._checkFill();
      case 'MONITORING':    return this._monitorPosition();
      default: break;
    }
  }

  /** Poll Alpaca for fill status. */
  private async _checkFill(): Promise<void> {
    if (!this.alpacaOrderId) {
      // No Alpaca order ID — assume filled (manual / restored without order ID)
      this.phase = 'MONITORING';
      return;
    }

    const order = await getAlpacaOrder(this.alpacaOrderId);
    if (!order) return; // transient error, retry next tick

    const { ticker, candidate } = this.cfg;

    if (order.status === 'filled' || order.status === 'partially_filled') {
      const filledQty  = parseInt(order.filled_qty ?? '0');
      const fillPrice  = order.filled_avg_price ? parseFloat(order.filled_avg_price) : null;
      const filledAt   = order.filled_at ?? new Date().toISOString();

      // Sync fill data to DB
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
        `[OrderAgent ${ticker} ${candidate.contract.symbol}] ` +
        `Filled qty=${filledQty} @ $${fillPrice ?? 'n/a'} → Phase: MONITORING`,
      );

    } else if (['canceled', 'expired', 'rejected'].includes(order.status)) {
      await this._voidPosition(`order_${order.status}`);
      this.phase = 'FAILED';
      console.log(
        `[OrderAgent ${ticker} ${candidate.contract.symbol}] ` +
        `Phase: FAILED (order ${order.status})`,
      );
      this._stopTick();
      this._selfRemove();
    }
  }

  /** Compare current option price to stop / TP / expiry. */
  private async _monitorPosition(): Promise<void> {
    const { candidate, ticker } = this.cfg;
    const symbol = candidate.contract.symbol;

    // Fetch live prices
    const priceMap = await getAlpacaPositionPrices();
    const currentPrice = priceMap.get(symbol);
    if (currentPrice == null) return; // not filled on broker side yet

    // Fetch current stop/tp from DB (may have been updated externally)
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

    if (rows.length === 0) {
      // Position was closed externally
      this._stopTick();
      this._selfRemove();
      return;
    }

    const row = rows[0]!;
    const stop = row.current_stop ? parseFloat(row.current_stop) : null;
    const tp   = row.current_tp   ? parseFloat(row.current_tp)   : null;

    // Stop / TP check
    if (stop != null && currentPrice <= stop) {
      await this._executeExit(`STOP_HIT @ $${currentPrice.toFixed(2)} (stop=$${stop.toFixed(2)})`);
      return;
    }
    if (tp != null && currentPrice >= tp) {
      await this._executeExit(`TP_HIT @ $${currentPrice.toFixed(2)} (tp=$${tp.toFixed(2)})`);
      return;
    }

    // Expiry guard
    if (row.expiration) {
      const now       = new Date();
      const todayStr  = now.toISOString().slice(0, 10);
      const expStr    = new Date(row.expiration).toISOString().slice(0, 10);

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
        }
      }
    }
  }

  /** Submit market sell, persist order + close position in DB, trigger evaluation. */
  private async _executeExit(reason: string): Promise<void> {
    if (this.phase === 'CLOSING' || this.phase === 'CLOSED') return; // idempotent guard
    this.phase = 'CLOSING';
    this._stopTick();

    const { candidate, ticker, sizing } = this.cfg;
    const symbol = candidate.contract.symbol;

    console.log(`[OrderAgent ${ticker} ${symbol}] Exiting — ${reason}`);

    const { alpacaOrderId, fillPrice: exitFill, error } = await submitMarketSellOrder(
      symbol,
      sizing.qty,
    );

    const exitPrice = exitFill ?? (this.fillPrice ?? candidate.entryPremium);

    // Persist exit order to DB
    await insertOrder({
      id: uuidv4(),
      positionId: this.positionId,
      decisionId: this.cfg.decisionId,
      ticker,
      optionSymbol: symbol,
      alpacaOrderId,
      alpacaStatus: error ? 'error' : 'submitted',
      orderSide: 'sell',
      orderType: 'market',
      positionIntent: 'sell_to_close',
      submittedQty: sizing.qty,
      filledQty: exitFill ? sizing.qty : 0,
      fillPrice: exitFill,
      errorMessage: error,
      submittedAt: new Date().toISOString(),
    });

    // Close position in DB
    await closePosition({ positionId: this.positionId, exitPrice, closeReason: reason });

    // Telegram alert
    const entryPrice = this.fillPrice ?? candidate.entryPremium;
    const pnl = (exitPrice - entryPrice) * sizing.qty * 100;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const emoji = reason.startsWith('STOP') ? '🛑' : reason.startsWith('TP') ? '🎯' : reason.startsWith('EXPIRY') ? '⚠️' : '🚪';

    await notifyAlert(
      `${emoji} <b>Auto-exit: ${ticker}</b>\n` +
      `<code>${symbol}</code>\n` +
      `${reason}\n` +
      `Entry: $${entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
      `P&L: <b>${pnlStr}</b> | Qty: ${sizing.qty}`,
    );

    // Trigger post-trade evaluation
    await this._triggerEvaluation(exitPrice, reason);

    this.phase = 'CLOSED';
    console.log(`[OrderAgent ${ticker} ${symbol}] Phase: CLOSED`);
    this._selfRemove();
  }

  private async _triggerEvaluation(exitPrice: number, closeReason: string): Promise<void> {
    try {
      const { candidate, ticker, entryConfidence, entryAlignment, entryDirection, entryReasoning } = this.cfg;
      const c = candidate.contract;

      const evaluation = await evaluationAgent.evaluate({
        ticker,
        optionSymbol: c.symbol,
        side: c.side,
        strike: c.strike,
        expiration: c.expiration,
        entryPrice: this.fillPrice ?? candidate.entryPremium,
        exitPrice,
        qty: this.cfg.sizing.qty,
        openedAt: this.openedAt,
        closedAt: new Date().toISOString(),
        closeReason,
        entryConfidence,
        entryAlignment,
        entryDirection,
        entryReasoning,
        positionId: this.positionId,
        decisionId: this.cfg.decisionId,
      });

      await insertEvaluation(evaluation);
      console.log(
        `[OrderAgent ${ticker}] Evaluation: ${evaluation.grade} (${evaluation.score}) — ${evaluation.lessonsLearned}`,
      );
    } catch (err) {
      console.error(`[OrderAgent ${this.cfg.ticker}] Evaluation error:`, (err as Error).message);
    }
  }

  /** Mark position as CLOSED in DB with no exit price (order never filled). */
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
    // Lazy import to avoid circular dep — registry is a singleton
    import('./order-agent-registry.js')
      .then(m => m.OrderAgentRegistry.getInstance().remove(this.positionId))
      .catch(() => {});
  }
}
