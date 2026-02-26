/**
 * alpaca-api.ts — Shared Alpaca REST helpers used by ExecutionAgent and OrderAgent.
 * All Alpaca fetch() calls live here so they are not duplicated across modules.
 */

import { config } from '../config.js';

export interface AlpacaOrderResponse {
  id?: string;
  status?: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
  filled_at?: string | null;
  [key: string]: unknown;
}

export interface AlpacaOrder {
  id: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
}

function headers(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
  };
}

function authHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
}

/** Submit a limit buy order (buy_to_open). */
export async function submitLimitBuyOrder(
  symbol: string,
  qty: number,
  limitPrice: number,
): Promise<AlpacaOrderResponse> {
  const res = await fetch(`${config.ALPACA_BASE_URL}/v2/orders`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: 'buy',
      type: 'limit',
      time_in_force: 'day',
      order_class: 'simple',
      position_intent: 'buy_to_open',
      limit_price: limitPrice.toFixed(2),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca order error ${res.status}: ${text}`);
  }

  return res.json() as Promise<AlpacaOrderResponse>;
}

/** Submit a market sell order (sell_to_close). */
export async function submitMarketSellOrder(
  symbol: string,
  qty: number,
): Promise<{ alpacaOrderId?: string; fillPrice?: number; error?: string }> {
  try {
    const res = await fetch(`${config.ALPACA_BASE_URL}/v2/orders`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side: 'sell',
        type: 'market',
        time_in_force: 'day',
        position_intent: 'sell_to_close',
      }),
    });

    if (!res.ok) return { error: await res.text() };
    const o = (await res.json()) as AlpacaOrderResponse;
    return {
      alpacaOrderId: o.id,
      fillPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Cancel all open (unfilled) orders for a given option symbol. */
export async function cancelOpenOrdersForSymbol(symbol: string): Promise<void> {
  const res = await fetch(
    `${config.ALPACA_BASE_URL}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return;

  const orders = (await res.json()) as Array<{ id: string }>;
  for (const order of orders) {
    await fetch(`${config.ALPACA_BASE_URL}/v2/orders/${order.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).catch(() => {}); // ignore if already filled/cancelled
  }
}

/** Close an entire Alpaca position (market order via DELETE /positions). */
export async function closeAlpacaPosition(symbol: string): Promise<AlpacaOrderResponse> {
  await cancelOpenOrdersForSymbol(symbol);

  const res = await fetch(
    `${config.ALPACA_BASE_URL}/v2/positions/${encodeURIComponent(symbol)}`,
    { method: 'DELETE', headers: authHeaders() },
  );

  // 404 = order was never filled, no position to close — treat as success
  if (res.status === 404) return {};

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alpaca close error ${res.status}: ${text}`);
  }

  return res.json() as Promise<AlpacaOrderResponse>;
}

/** Partially close an Alpaca position by qty. */
export async function reduceAlpacaPosition(
  symbol: string,
  qty: number,
): Promise<{ alpacaOrderId?: string; error?: string }> {
  try {
    const res = await fetch(
      `${config.ALPACA_BASE_URL}/v2/positions/${encodeURIComponent(symbol)}?qty=${qty}`,
      { method: 'DELETE', headers: authHeaders() },
    );

    if (!res.ok) return { error: await res.text() };
    const o = (await res.json()) as AlpacaOrderResponse;
    return { alpacaOrderId: o.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Fetch a single Alpaca order by ID. */
export async function getAlpacaOrder(orderId: string): Promise<AlpacaOrder | null> {
  try {
    const res = await fetch(
      `${config.ALPACA_BASE_URL}/v2/orders/${orderId}`,
      { headers: authHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as AlpacaOrder;
  } catch {
    return null;
  }
}

/** Fetch all open Alpaca positions and return a symbol → currentPrice map. */
export async function getAlpacaPositionPrices(): Promise<Map<string, number>> {
  try {
    const res = await fetch(
      `${config.ALPACA_BASE_URL}/v2/positions`,
      { headers: authHeaders() },
    );
    if (!res.ok) return new Map();

    const list = (await res.json()) as Array<{ symbol: string; current_price: string }>;
    return new Map(list.map(p => [p.symbol, parseFloat(p.current_price)]));
  } catch {
    return new Map();
  }
}
