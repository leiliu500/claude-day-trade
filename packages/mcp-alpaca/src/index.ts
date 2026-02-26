#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAlpacaClient } from './alpaca-client.js';

const client = createAlpacaClient();
const server = new McpServer({ name: 'mcp-alpaca', version: '1.0.0' });

// ── Market Clock ──────────────────────────────────────────────────────────────
server.tool('get_market_clock', 'Get current market clock status', {}, async () => {
  const data = await client.get<unknown>('base', '/v2/clock');
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});

// ── Account ───────────────────────────────────────────────────────────────────
server.tool('get_account', 'Get Alpaca account details (equity, buying power)', {}, async () => {
  const data = await client.get<unknown>('base', '/v2/account');
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});

// ── Stock Bars ────────────────────────────────────────────────────────────────
server.tool(
  'get_stock_bars',
  'Fetch OHLCV bars for a stock symbol',
  {
    symbol: z.string().describe('Stock ticker symbol, e.g. SPY'),
    timeframe: z.string().describe('Bar timeframe: 1m, 2m, 3m, 5m, 15m, 1h, 1d'),
    limit: z.number().default(1000).describe('Number of bars to fetch (max 10000)'),
    start: z.string().optional().describe('ISO 8601 start date (optional)'),
    adjustment: z.string().default('raw').describe('Price adjustment: raw, split, dividend, all'),
  },
  async ({ symbol, timeframe, limit, start, adjustment }) => {
    const params: Record<string, string | number> = {
      timeframe,
      limit,
      adjustment,
      feed: 'iex',
    };
    if (start) params['start'] = start;

    const data = await client.get<unknown>('data', `/v2/stocks/${symbol}/bars`, params);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// ── Option Contracts ──────────────────────────────────────────────────────────
server.tool(
  'get_option_contracts',
  'Search for option contracts by underlying symbol and filters',
  {
    underlying_symbol: z.string().describe('Underlying stock symbol, e.g. SPY'),
    type: z.enum(['call', 'put']).optional().describe('Option type filter'),
    expiration_date_gte: z.string().optional().describe('Min expiration date YYYY-MM-DD'),
    expiration_date_lte: z.string().optional().describe('Max expiration date YYYY-MM-DD'),
    strike_price_gte: z.number().optional().describe('Min strike price'),
    strike_price_lte: z.number().optional().describe('Max strike price'),
    limit: z.number().default(100).describe('Max contracts to return'),
  },
  async ({ underlying_symbol, type, expiration_date_gte, expiration_date_lte, strike_price_gte, strike_price_lte, limit }) => {
    const params: Record<string, string | number> = {
      underlying_symbols: underlying_symbol,
      limit,
    };
    if (type) params['type'] = type;
    if (expiration_date_gte) params['expiration_date_gte'] = expiration_date_gte;
    if (expiration_date_lte) params['expiration_date_lte'] = expiration_date_lte;
    if (strike_price_gte !== undefined) params['strike_price_gte'] = strike_price_gte;
    if (strike_price_lte !== undefined) params['strike_price_lte'] = strike_price_lte;

    const data = await client.get<unknown>('base', '/v2/options/contracts', params);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// ── Option Snapshots ──────────────────────────────────────────────────────────
server.tool(
  'get_option_snapshots',
  'Get real-time quotes and greeks for option symbols',
  {
    symbols: z.array(z.string()).describe('List of OCC option symbols'),
  },
  async ({ symbols }) => {
    const params = { symbols: symbols.join(',') };
    const data = await client.get<unknown>('data', '/v1beta1/options/snapshots', params);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// ── Positions ─────────────────────────────────────────────────────────────────
server.tool('get_positions', 'Get all open positions', {}, async () => {
  const data = await client.get<unknown>('base', '/v2/positions');
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});

server.tool(
  'close_position',
  'Close an open position by symbol',
  {
    symbol: z.string().describe('OCC option symbol or stock symbol to close'),
    qty: z.number().optional().describe('Quantity to close (default: all)'),
    percentage: z.number().optional().describe('Percentage to close (0-100)'),
  },
  async ({ symbol, qty, percentage }) => {
    const params: Record<string, string> = {};
    if (qty) params['qty'] = String(qty);
    if (percentage) params['percentage'] = String(percentage);
    const data = await client.delete<unknown>(`/v2/positions/${encodeURIComponent(symbol)}`, params);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// ── Orders ────────────────────────────────────────────────────────────────────
server.tool(
  'submit_order',
  'Submit a new order to Alpaca',
  {
    symbol: z.string().describe('OCC option symbol or stock symbol'),
    qty: z.string().describe('Number of contracts/shares'),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit', 'stop', 'stop_limit']),
    time_in_force: z.enum(['day', 'gtc', 'ioc', 'fok']).default('day'),
    limit_price: z.string().optional().describe('Limit price (required for limit orders)'),
    position_intent: z.enum(['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close']).optional(),
  },
  async ({ symbol, qty, side, type, time_in_force, limit_price, position_intent }) => {
    const body: Record<string, string> = {
      symbol,
      qty,
      side,
      type,
      time_in_force,
      order_class: 'simple',
    };
    if (limit_price) body['limit_price'] = limit_price;
    if (position_intent) body['position_intent'] = position_intent;

    const data = await client.post<unknown>('/v2/orders', body);
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

server.tool(
  'get_orders',
  'Get orders filtered by status',
  {
    status: z.enum(['open', 'closed', 'all']).default('open'),
    limit: z.number().default(50),
  },
  async ({ status, limit }) => {
    const data = await client.get<unknown>('base', '/v2/orders', { status, limit });
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
