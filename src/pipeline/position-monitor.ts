/**
 * Position Monitor — runs every 30 s, independently of the 5-min signal pipeline.
 *
 * Responsibilities:
 *   1. Order-fill sync   — poll Alpaca for pending buy orders; update DB with actual fill price
 *   2. Stop / TP check   — compare current option price against stored levels; auto-exit on breach
 *   3. Expiry guard      — warn at T-30 min; force-close at T-15 min on expiry day
 */

import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { getPool } from '../db/client.js';
import { getActivePositions, closePosition } from '../db/repositories/positions.js';
import { insertOrder } from '../db/repositories/orders.js';
import { notifyAlert } from '../telegram/notifier.js';

const INTERVAL_MS = 30_000; // 30 seconds
let isRunning = false;

// ── Alpaca helpers ─────────────────────────────────────────────────────────────

const headers = () => ({
  'APCA-API-KEY-ID': config.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
});

interface AlpacaOrder {
  id: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  current_price: string;
}

async function getAlpacaOrder(orderId: string): Promise<AlpacaOrder | null> {
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/orders/${orderId}`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as AlpacaOrder;
  } catch { return null; }
}

async function getAlpacaPositions(): Promise<Map<string, number>> {
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/positions`, { headers: headers() });
    if (!res.ok) return new Map();
    const list = (await res.json()) as AlpacaPosition[];
    return new Map(list.map(p => [p.symbol, parseFloat(p.current_price)]));
  } catch { return new Map(); }
}

async function marketSell(symbol: string, qty: number): Promise<{ alpacaOrderId?: string; fillPrice?: number; error?: string }> {
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/orders`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol, qty: String(qty),
        side: 'sell', type: 'market',
        time_in_force: 'day',
        position_intent: 'sell_to_close',
      }),
    });
    if (!res.ok) return { error: await res.text() };
    const o = (await res.json()) as { id: string; filled_avg_price?: string };
    return {
      alpacaOrderId: o.id,
      fillPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined,
    };
  } catch (err) { return { error: (err as Error).message }; }
}

// ── Phase 1: Sync order fills ──────────────────────────────────────────────────

async function syncOrderFills(): Promise<void> {
  const pool = getPool();

  const { rows: pending } = await pool.query<{
    id: string;
    position_id: string | null;
    alpaca_order_id: string;
    option_symbol: string;
    submitted_qty: number;
  }>(`
    SELECT id, position_id, alpaca_order_id, option_symbol, submitted_qty
    FROM trading.order_executions
    WHERE order_side = 'buy'
      AND filled_qty = 0
      AND alpaca_order_id IS NOT NULL
      AND alpaca_status NOT IN ('canceled','expired','rejected','error')
      AND submitted_at > NOW() - INTERVAL '24 hours'
  `);

  for (const row of pending) {
    const order = await getAlpacaOrder(row.alpaca_order_id);
    if (!order) continue;

    if (order.status === 'filled' || order.status === 'partially_filled') {
      const filledQty   = parseInt(order.filled_qty ?? '0');
      const fillPrice   = order.filled_avg_price ? parseFloat(order.filled_avg_price) : null;
      const filledAt    = order.filled_at ?? new Date().toISOString();

      await pool.query(
        `UPDATE trading.order_executions
         SET filled_qty=$1, fill_price=$2, alpaca_status=$3, filled_at=$4
         WHERE id=$5`,
        [filledQty, fillPrice, order.status, filledAt, row.id]
      );

      // Sync actual fill price back to position_journal
      if (fillPrice && row.position_id) {
        await pool.query(
          `UPDATE trading.position_journal SET entry_price=$1 WHERE id=$2 AND status='OPEN'`,
          [fillPrice, row.position_id]
        );
      }
      console.log(`[Monitor] Filled: ${row.option_symbol} qty=${filledQty} @ $${fillPrice ?? 'n/a'}`);

    } else if (['canceled', 'expired', 'rejected'].includes(order.status)) {
      await pool.query(
        `UPDATE trading.order_executions SET alpaca_status=$1 WHERE id=$2`,
        [order.status, row.id]
      );
      // Close the position record — order never filled, nothing to hold
      if (row.position_id) {
        await pool.query(
          `UPDATE trading.position_journal
           SET status='CLOSED', close_reason=$1, closed_at=NOW()
           WHERE id=$2 AND status='OPEN'`,
          [`order_${order.status}`, row.position_id]
        );
        console.log(`[Monitor] Position voided (order ${order.status}): ${row.option_symbol}`);
      }
    }
  }
}

// ── Phase 2: Stop / TP check ───────────────────────────────────────────────────

async function checkStopTP(): Promise<void> {
  const positions = await getActivePositions();
  if (positions.length === 0) return;

  const priceMap = await getAlpacaPositions();

  for (const pos of positions) {
    const currentPrice = priceMap.get(pos.option_symbol as string);
    if (currentPrice == null) continue; // not filled yet on broker side

    const entryPrice = parseFloat(pos.entry_price as string);
    const stop = pos.current_stop ? parseFloat(pos.current_stop as string) : null;
    const tp   = pos.current_tp   ? parseFloat(pos.current_tp   as string) : null;

    let exitReason: string | null = null;
    let emoji = '🚪';

    if (stop != null && currentPrice <= stop) {
      exitReason = `STOP_HIT @ $${currentPrice.toFixed(2)} (stop=$${stop.toFixed(2)})`;
      emoji = '🛑';
    } else if (tp != null && currentPrice >= tp) {
      exitReason = `TP_HIT @ $${currentPrice.toFixed(2)} (tp=$${tp.toFixed(2)})`;
      emoji = '🎯';
    }

    if (!exitReason) continue;

    console.log(`[Monitor] ${exitReason} — exiting ${pos.option_symbol}`);

    const { alpacaOrderId, fillPrice, error } = await marketSell(
      pos.option_symbol as string,
      pos.qty as number
    );
    const exitPrice = fillPrice ?? currentPrice;

    await closePosition({ positionId: pos.id as string, exitPrice, closeReason: exitReason });

    await insertOrder({
      id: uuidv4(),
      positionId: pos.id as string,
      ticker: pos.ticker as string,
      optionSymbol: pos.option_symbol as string,
      alpacaOrderId,
      alpacaStatus: error ? 'error' : 'submitted',
      orderSide: 'sell',
      orderType: 'market',
      positionIntent: 'sell_to_close',
      submittedQty: pos.qty as number,
      filledQty: fillPrice ? (pos.qty as number) : 0,
      fillPrice,
      errorMessage: error,
      submittedAt: new Date().toISOString(),
    });

    const pnl = (exitPrice - entryPrice) * (pos.qty as number) * 100;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

    await notifyAlert(
      `${emoji} <b>Auto-exit: ${pos.ticker}</b>\n` +
      `<code>${pos.option_symbol}</code>\n` +
      `${exitReason}\n` +
      `Entry: $${entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
      `P&L: <b>${pnlStr}</b> | Qty: ${pos.qty}`
    );
  }
}

// ── Phase 3: Expiry guard ──────────────────────────────────────────────────────

async function checkExpiry(): Promise<void> {
  const positions = await getActivePositions();
  if (positions.length === 0) return;

  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const utcHour  = now.getUTCHours();
  const utcMin   = now.getUTCMinutes();

  for (const pos of positions) {
    if (!pos.expiration) continue;
    const expStr = new Date(pos.expiration as string).toISOString().slice(0, 10);
    if (expStr !== todayStr) continue;

    // Warn: 19:30 UTC (T-30 min before market close at 20:00 UTC)
    if (utcHour === 19 && utcMin >= 30 && utcMin < 45) {
      await notifyAlert(
        `⏰ <b>Expiry Warning: ${pos.ticker}</b>\n` +
        `<code>${pos.option_symbol}</code> expires TODAY\n` +
        `Position still open — 30 min to market close!`
      );
      continue;
    }

    // Force-close: 19:45 UTC (T-15 min)
    if (utcHour === 19 && utcMin >= 45) {
      console.log(`[Monitor] Expiry force-close: ${pos.option_symbol}`);

      const priceMap   = await getAlpacaPositions();
      const livePrice  = priceMap.get(pos.option_symbol as string) ?? parseFloat(pos.entry_price as string);
      const { alpacaOrderId, fillPrice, error } = await marketSell(
        pos.option_symbol as string,
        pos.qty as number
      );
      const exitPrice = fillPrice ?? livePrice;

      await closePosition({
        positionId: pos.id as string,
        exitPrice,
        closeReason: 'EXPIRY_FORCE_CLOSE',
      });

      await insertOrder({
        id: uuidv4(),
        positionId: pos.id as string,
        ticker: pos.ticker as string,
        optionSymbol: pos.option_symbol as string,
        alpacaOrderId,
        alpacaStatus: error ? 'error' : 'submitted',
        orderSide: 'sell',
        orderType: 'market',
        positionIntent: 'sell_to_close',
        submittedQty: pos.qty as number,
        filledQty: fillPrice ? (pos.qty as number) : 0,
        fillPrice,
        errorMessage: error,
        submittedAt: new Date().toISOString(),
      });

      const pnl = (exitPrice - parseFloat(pos.entry_price as string)) * (pos.qty as number) * 100;
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

      await notifyAlert(
        `⚠️ <b>Expiry Force-Close: ${pos.ticker}</b>\n` +
        `<code>${pos.option_symbol}</code>\n` +
        `Exit: $${exitPrice.toFixed(2)} (T-15 min to expiry)\n` +
        `P&L: <b>${pnlStr}</b>`
      );
    }
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await syncOrderFills();
    await checkStopTP();
    await checkExpiry();
  } catch (err) {
    console.error('[Monitor] Error:', (err as Error).message);
  } finally {
    isRunning = false;
  }
}

export function startPositionMonitor(): void {
  setInterval(() => { tick().catch(err => console.error('[Monitor] Unhandled:', err)); }, INTERVAL_MS);
  console.log(`[Monitor] Started — checking every ${INTERVAL_MS / 1000}s (fill sync + stop/TP + expiry guard)`);
}
