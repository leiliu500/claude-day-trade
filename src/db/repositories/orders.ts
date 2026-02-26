import { getPool } from '../client.js';
import type { OrderRecord } from '../../types/trade.js';

export async function insertOrder(order: OrderRecord): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO trading.order_executions (
      id, position_id, decision_id, ticker, option_symbol,
      alpaca_order_id, alpaca_status, order_side, order_type, position_intent,
      submitted_qty, filled_qty, submitted_price, fill_price, error_message,
      submitted_at, filled_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      order.id,
      order.positionId ?? null,
      order.decisionId ?? null,
      order.ticker,
      order.optionSymbol,
      order.alpacaOrderId ?? null,
      order.alpacaStatus ?? null,
      order.orderSide,
      order.orderType,
      order.positionIntent ?? null,
      order.submittedQty,
      order.filledQty,
      order.submittedPrice ?? null,
      order.fillPrice ?? null,
      order.errorMessage ?? null,
      order.submittedAt,
      order.filledAt ?? null,
    ]
  );
}

export async function syncBrokerPositions(positions: unknown[]): Promise<void> {
  const pool = getPool();
  for (const pos of positions) {
    const p = pos as Record<string, unknown>;
    await pool.query(
      `INSERT INTO trading.broker_positions (symbol, qty, avg_entry_price, market_value, unrealized_pl, unrealized_plpc, current_price, asset_class, raw_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [p['symbol'], p['qty'], p['avg_entry_price'], p['market_value'], p['unrealized_pl'], p['unrealized_plpc'], p['current_price'], p['asset_class'], JSON.stringify(p)]
    );
  }
}

export async function syncBrokerOrders(orders: unknown[]): Promise<void> {
  const pool = getPool();
  for (const o of orders) {
    const ord = o as Record<string, unknown>;
    await pool.query(
      `INSERT INTO trading.broker_open_orders (alpaca_order_id, symbol, order_type, side, qty, filled_qty, limit_price, status, created_at_broker, raw_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [ord['id'], ord['symbol'], ord['type'], ord['side'], ord['qty'], ord['filled_qty'], ord['limit_price'], ord['status'], ord['created_at'], JSON.stringify(o)]
    );
  }
}
