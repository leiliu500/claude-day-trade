import { config } from "../config.js";
import type { Bar } from "../types.js";
import { logger } from "../util/logger.js";

const log = logger("alpaca-rest");

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function headers(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": config.alpaca.apiKey,
    "APCA-API-SECRET-KEY": config.alpaca.secretKey,
    "accept": "application/json",
  };
}

async function getJson<T>(url: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: headers() });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1_000 * (i + 1)));
        continue;
      }
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${url}: ${body.slice(0, 200)}`);
      }
      return (await r.json()) as T;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await new Promise((res) => setTimeout(res, 300 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function bar(b: AlpacaBar): Bar {
  return { t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
}

export async function fetchStockBars(
  symbol: string,
  timeframe: "1Min" | "5Min" | "15Min" | "1Hour" | "1Day",
  startISO: string,
  endISO: string,
  feed: "sip" | "iex" = "sip",
): Promise<Bar[]> {
  const bars: Bar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({
      symbols: symbol,
      timeframe,
      start: startISO,
      end: endISO,
      limit: "10000",
      adjustment: "split",
      feed,
    });
    if (pageToken) qs.set("page_token", pageToken);
    const url = `${config.alpaca.dataUrl}/v2/stocks/bars?${qs}`;
    const res = await getJson<{
      bars: Record<string, AlpacaBar[]>;
      next_page_token: string | null;
    }>(url);
    const arr = res.bars?.[symbol] ?? [];
    for (const b of arr) bars.push(bar(b));
    pageToken = res.next_page_token ?? undefined;
    if (!pageToken) break;
  }
  return bars;
}

export async function fetchOptionBars(
  symbols: string[],
  timeframe: "1Min" | "5Min" | "1Hour" | "1Day",
  startISO: string,
  endISO: string,
): Promise<Record<string, Bar[]>> {
  if (symbols.length === 0) return {};
  const out: Record<string, Bar[]> = {};
  const CHUNK = 100;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const qs = new URLSearchParams({
      symbols: chunk.join(","),
      timeframe,
      start: startISO,
      end: endISO,
      limit: "10000",
    });
    const url = `${config.alpaca.dataUrl}/v1beta1/options/bars?${qs}`;
    try {
      const res = await getJson<{ bars: Record<string, AlpacaBar[]> }>(url);
      for (const [sym, arr] of Object.entries(res.bars ?? {})) {
        out[sym] = (arr ?? []).map(bar);
      }
    } catch (e) {
      log.warn(`option bars fetch failed for chunk ${i}-${i + chunk.length}`, (e as Error).message);
    }
  }
  return out;
}

export interface AlpacaOptionSnapshot {
  symbol: string;
  latestQuote?: { bp: number; ap: number; bs: number; as: number; t: string };
  latestTrade?: { p: number; t: string };
  greeks?: { delta: number; gamma: number; theta: number; vega: number; rho?: number };
  impliedVolatility?: number;
  openInterest?: number;
}

export async function fetchOptionSnapshots(
  underlying: string,
  opts: { expiration?: string; strikeMin?: number; strikeMax?: number; type?: "call" | "put" } = {},
): Promise<AlpacaOptionSnapshot[]> {
  const snaps: AlpacaOptionSnapshot[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "200" });
    if (opts.expiration) qs.set("expiration_date", opts.expiration);
    if (opts.strikeMin !== undefined) qs.set("strike_price_gte", String(opts.strikeMin));
    if (opts.strikeMax !== undefined) qs.set("strike_price_lte", String(opts.strikeMax));
    if (opts.type) qs.set("type", opts.type);
    if (pageToken) qs.set("page_token", pageToken);
    const url = `${config.alpaca.dataUrl}/v1beta1/options/snapshots/${underlying}?${qs}`;
    const res = await getJson<{
      snapshots: Record<string, Omit<AlpacaOptionSnapshot, "symbol">>;
      next_page_token: string | null;
    }>(url);
    for (const [sym, s] of Object.entries(res.snapshots ?? {})) {
      snaps.push({ symbol: sym, ...s });
    }
    pageToken = res.next_page_token ?? undefined;
    if (!pageToken) break;
  }
  return snaps;
}

export interface AlpacaAccount {
  equity: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  daytrading_buying_power: string;
}

export async function fetchAccount(): Promise<AlpacaAccount> {
  return getJson<AlpacaAccount>(`${config.alpaca.baseUrl}/v2/account`);
}

export interface MlegLeg {
  symbol: string;
  side: "buy" | "sell";
  ratio_qty: string;
  position_intent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
}

export async function submitMlegOrder(params: {
  qty: number;
  limitDebit?: number;
  legs: MlegLeg[];
  tif?: "day";
  orderType?: "limit" | "market";
  clientOrderId?: string;
}): Promise<{ id: string; status: string }> {
  const orderType = params.orderType ?? "limit";
  if (orderType === "limit" && params.limitDebit === undefined) {
    throw new Error("limitDebit required for limit orders");
  }
  const body: Record<string, unknown> = {
    order_class: "mleg",
    type: orderType,
    time_in_force: params.tif ?? "day",
    qty: String(params.qty),
    legs: params.legs,
    client_order_id: params.clientOrderId,
  };
  if (orderType === "limit") body.limit_price = params.limitDebit!.toFixed(2);
  const r = await fetch(`${config.alpaca.baseUrl}/v2/orders`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`submit mleg failed: ${r.status} ${t}`);
  }
  return (await r.json()) as { id: string; status: string };
}

export async function cancelOrder(orderId: string): Promise<void> {
  const r = await fetch(`${config.alpaca.baseUrl}/v2/orders/${orderId}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!r.ok && r.status !== 422 && r.status !== 404) {
    const t = await r.text().catch(() => "");
    throw new Error(`cancel failed: ${r.status} ${t}`);
  }
}

export async function getOrder(orderId: string): Promise<{
  id: string;
  status: string;
  filled_avg_price: string | null;
  filled_qty: string;
}> {
  return getJson(`${config.alpaca.baseUrl}/v2/orders/${orderId}`);
}
