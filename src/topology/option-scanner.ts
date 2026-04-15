/**
 * Option Scanner — fetch comprehensive option chain data for topology analysis.
 *
 * The existing option-agent.ts fetches ATM±10 for a single next-day expiry.
 * Topology analysis needs the full chain: wider strike range, multiple
 * expirations, full greeks + volume + OI.
 *
 * This module fetches chain snapshots independently and converts them
 * into the ChainContract format that topology modules consume.
 */

import { config } from '../config.js';
import type { ChainContract } from './types.js';

interface AlpacaOptionContract {
  id: string;
  symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
}

interface AlpacaOptionSnapshot {
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
  };
  impliedVolatility?: number;
  latestQuote?: {
    ap?: number;
    bp?: number;
    t?: string;
  };
  dailyBar?: {
    v?: number;
  };
  openInterest?: number;
}

function authHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
}

/**
 * Fetch option contracts for a ticker within a strike range and expiry window.
 */
async function fetchContracts(
  ticker: string,
  side: 'call' | 'put',
  expiryStart: string,
  expiryEnd: string,
  strikeMin: number,
  strikeMax: number,
): Promise<AlpacaOptionContract[]> {
  const url = new URL(`${config.ALPACA_BASE_URL}/v2/options/contracts`);
  url.searchParams.set('underlying_symbols', ticker);
  url.searchParams.set('type', side);
  url.searchParams.set('expiration_date_gte', expiryStart);
  url.searchParams.set('expiration_date_lte', expiryEnd);
  url.searchParams.set('strike_price_gte', String(strikeMin));
  url.searchParams.set('strike_price_lte', String(strikeMax));
  url.searchParams.set('limit', '100');

  const res = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];

  const data = (await res.json()) as { option_contracts?: AlpacaOptionContract[] };
  return data.option_contracts ?? [];
}

/**
 * Fetch snapshots (quotes, greeks, volume, OI) for a batch of option symbols.
 * Alpaca limits to ~100 symbols per request, so we batch.
 */
async function fetchSnapshots(
  symbols: string[],
): Promise<Record<string, AlpacaOptionSnapshot>> {
  if (symbols.length === 0) return {};

  const batchSize = 80;
  const results: Record<string, AlpacaOptionSnapshot> = {};

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const url = new URL(`${config.ALPACA_DATA_URL}/v1beta1/options/snapshots`);
    url.searchParams.set('symbols', batch.join(','));
    url.searchParams.set('feed', 'opra');

    try {
      const res = await fetch(url.toString(), {
        headers: authHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { snapshots?: Record<string, AlpacaOptionSnapshot> };
      if (data.snapshots) {
        Object.assign(results, data.snapshots);
      }
    } catch {
      // Skip failed batch
    }
  }

  return results;
}

/**
 * Convert raw Alpaca data into a ChainContract for topology analysis.
 */
function toChainContract(
  raw: AlpacaOptionContract,
  snap: AlpacaOptionSnapshot | undefined,
): ChainContract {
  const bid = snap?.latestQuote?.bp ?? 0;
  const ask = snap?.latestQuote?.ap ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;

  return {
    strike: parseFloat(raw.strike_price),
    expiration: raw.expiration_date,
    side: raw.type,
    volume: snap?.dailyBar?.v ?? 0,
    openInterest: snap?.openInterest ?? 0,
    iv: snap?.impliedVolatility ?? 0,
    delta: snap?.greeks?.delta ?? 0,
    gamma: snap?.greeks?.gamma ?? 0,
    bid,
    ask,
    mid,
  };
}

/**
 * Get upcoming expiration dates for topology analysis.
 * Returns the next 3 business days (0DTE / 1DTE / weekly).
 */
function getExpirationWindow(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  // Start from today (for 0DTE)
  const startStr = start.toISOString().split('T')[0]!;

  // End: 7 calendar days out (covers weekly expiry)
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  const endStr = end.toISOString().split('T')[0]!;

  return { start: startStr, end: endStr };
}

/**
 * Scan the full option chain for a ticker.
 *
 * Fetches calls and puts across a wide strike range and multiple
 * expirations, enriches with snapshot data (greeks, volume, OI, IV),
 * and returns sorted ChainContract arrays ready for topology analysis.
 *
 * @param ticker  Underlying symbol (e.g., SPY, MSFT).
 * @param currentPrice  Current underlying price (for strike range).
 * @param strikeRadius  How far from ATM to scan (default ±30 for SPY-class).
 */
export async function scanOptionChain(
  ticker: string,
  currentPrice: number,
  strikeRadius = 30,
): Promise<{ callChain: ChainContract[]; putChain: ChainContract[] }> {
  const { start, end } = getExpirationWindow();
  const strikeMin = currentPrice - strikeRadius;
  const strikeMax = currentPrice + strikeRadius;

  // Fetch contracts for both sides in parallel
  const [callContracts, putContracts] = await Promise.all([
    fetchContracts(ticker, 'call', start, end, strikeMin, strikeMax),
    fetchContracts(ticker, 'put', start, end, strikeMin, strikeMax),
  ]);

  // Fetch snapshots for all contracts
  const allSymbols = [
    ...callContracts.map(c => c.symbol),
    ...putContracts.map(c => c.symbol),
  ];
  const snapshots = await fetchSnapshots(allSymbols);

  // Convert to ChainContract
  const callChain = callContracts
    .map(c => toChainContract(c, snapshots[c.symbol]))
    .sort((a, b) => a.strike - b.strike);

  const putChain = putContracts
    .map(c => toChainContract(c, snapshots[c.symbol]))
    .sort((a, b) => a.strike - b.strike);

  return { callChain, putChain };
}
