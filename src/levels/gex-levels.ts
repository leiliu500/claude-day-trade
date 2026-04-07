/**
 * GEX (Gamma Exposure) Levels — computes dealer gamma exposure per strike
 * from the options chain to identify key price levels.
 *
 * Institutional traders watch GEX because market makers must delta-hedge:
 *   - High positive GEX → price tends to pin (dealers sell into rallies, buy dips)
 *   - High negative GEX → price accelerates (dealers amplify moves)
 *   - GEX flip (zero crossing) → transition zone between pin and acceleration
 *
 * Call wall = strike with max call GEX (resistance magnet)
 * Put wall = strike with max put GEX (support magnet)
 * GEX zero = strike where net GEX crosses zero (regime boundary)
 *
 * Formula per strike:
 *   Call GEX = callOI × callGamma × 100 × spot   (positive — dealers are long gamma)
 *   Put GEX  = putOI × putGamma × 100 × spot × -1 (negative — dealers are short gamma)
 *   Net GEX  = Call GEX + Put GEX
 */

import { config } from '../config.js';
import type { PriceLevel } from '../types/levels.js';

// ── Alpaca types (same as option-agent.ts, kept local to avoid circular deps) ──

interface AlpacaOptionContract {
  id: string;
  symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
}

interface AlpacaOptionSnapshot {
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
  impliedVolatility?: number;
  openInterest?: number;
  latestQuote?: { ap?: number; bp?: number };
  dailyBar?: { v?: number };
}

// ── GEX Result ───────────────────────────────────────────────────────────────

export interface GEXStrike {
  strike: number;
  callOI: number;
  putOI: number;
  callGamma: number;
  putGamma: number;
  callGEX: number;      // callOI × gamma × 100 × spot
  putGEX: number;       // putOI × gamma × 100 × spot × -1
  netGEX: number;       // callGEX + putGEX
}

export interface GEXResult {
  strikes: GEXStrike[];
  callWallStrike: number;   // strike with highest call GEX
  putWallStrike: number;    // strike with highest |put GEX|
  gexZeroStrike: number;    // strike where net GEX crosses zero
  totalNetGEX: number;      // sum of all net GEX (positive = pinning regime)
  computedAt: string;
}

// ── Fetch Helpers ────────────────────────────────────────────────────────────

const headers = {
  'APCA-API-KEY-ID': config.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
};

async function fetchContracts(
  ticker: string,
  side: 'call' | 'put',
  expiry: string,
  strikeMin: number,
  strikeMax: number,
): Promise<AlpacaOptionContract[]> {
  const url = new URL(`${config.ALPACA_BASE_URL}/v2/options/contracts`);
  url.searchParams.set('underlying_symbols', ticker);
  url.searchParams.set('type', side);
  url.searchParams.set('expiration_date_gte', expiry);
  url.searchParams.set('expiration_date_lte', expiry);
  url.searchParams.set('strike_price_gte', String(strikeMin));
  url.searchParams.set('strike_price_lte', String(strikeMax));
  url.searchParams.set('limit', '100');

  const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return [];

  const data = (await res.json()) as { option_contracts?: AlpacaOptionContract[] };
  return data.option_contracts ?? [];
}

async function fetchSnapshots(symbols: string[]): Promise<Record<string, AlpacaOptionSnapshot>> {
  if (symbols.length === 0) return {};

  // Alpaca limits snapshot requests; batch in groups of 100
  const result: Record<string, AlpacaOptionSnapshot> = {};

  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    const url = new URL(`${config.ALPACA_DATA_URL}/v1beta1/options/snapshots`);
    url.searchParams.set('symbols', batch.join(','));
    url.searchParams.set('feed', 'opra');

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) continue;

    const data = (await res.json()) as { snapshots?: Record<string, AlpacaOptionSnapshot> };
    if (data.snapshots) Object.assign(result, data.snapshots);
  }

  return result;
}

function getNextBusinessDay(): string {
  const d = new Date();
  const day = d.getUTCDay();
  if (day === 6) d.setDate(d.getDate() + 2);      // Sat → Mon
  else if (day === 0) d.setDate(d.getDate() + 1);  // Sun → Mon
  // For 0DTE: use today if market is open, otherwise next business day
  return d.toISOString().slice(0, 10);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute GEX levels for a ticker.
 *
 * Fetches the full near-ATM options chain for the nearest expiry,
 * computes gamma exposure per strike, and identifies key levels.
 *
 * @param ticker       Underlying ticker (e.g. 'SPY')
 * @param spotPrice    Current spot price
 * @param strikeRange  Number of strikes above/below ATM to fetch (default 30)
 * @param expiry       Expiration date (default: next business day for 0DTE)
 */
export async function computeGEXLevels(
  ticker: string,
  spotPrice: number,
  strikeRange = 30,
  expiry?: string,
): Promise<GEXResult | null> {
  const targetExpiry = expiry ?? getNextBusinessDay();

  // Strike step: SPY/QQQ = $1, IWM = $1, NVDA = $1, AAPL = $2.50
  const step = spotPrice > 300 ? 1 : spotPrice > 100 ? 1 : 0.5;
  const atm = Math.round(spotPrice / step) * step;
  const strikeMin = atm - strikeRange * step;
  const strikeMax = atm + strikeRange * step;

  try {
    // Fetch call + put contracts in parallel
    const [calls, puts] = await Promise.all([
      fetchContracts(ticker, 'call', targetExpiry, strikeMin, strikeMax),
      fetchContracts(ticker, 'put', targetExpiry, strikeMin, strikeMax),
    ]);

    if (calls.length === 0 && puts.length === 0) return null;

    // Fetch snapshots for all contracts (OI + greeks)
    const allSymbols = [...calls, ...puts].map(c => c.symbol);
    const snapshots = await fetchSnapshots(allSymbols);

    // Build per-strike GEX map
    const strikeMap = new Map<number, { callOI: number; putOI: number; callGamma: number; putGamma: number }>();

    for (const contract of calls) {
      const strike = parseFloat(contract.strike_price);
      const snap = snapshots[contract.symbol];
      const oi = snap?.openInterest ?? 0;
      const gamma = snap?.greeks?.gamma ?? 0;

      const existing = strikeMap.get(strike) ?? { callOI: 0, putOI: 0, callGamma: 0, putGamma: 0 };
      existing.callOI += oi;
      existing.callGamma = gamma; // gamma is per-contract, not cumulative
      strikeMap.set(strike, existing);
    }

    for (const contract of puts) {
      const strike = parseFloat(contract.strike_price);
      const snap = snapshots[contract.symbol];
      const oi = snap?.openInterest ?? 0;
      const gamma = snap?.greeks?.gamma ?? 0;

      const existing = strikeMap.get(strike) ?? { callOI: 0, putOI: 0, callGamma: 0, putGamma: 0 };
      existing.putOI += oi;
      existing.putGamma = gamma;
      strikeMap.set(strike, existing);
    }

    // Compute GEX per strike
    const gexStrikes: GEXStrike[] = [];
    let maxCallGEX = 0, callWallStrike = atm;
    let maxPutGEX = 0, putWallStrike = atm;
    let totalNetGEX = 0;

    for (const [strike, data] of strikeMap) {
      // Dealers are long call gamma (buy low, sell high) → positive
      // Dealers are short put gamma (sell low, buy high) → negative
      const callGEX = data.callOI * data.callGamma * 100 * spotPrice;
      const putGEX = data.putOI * data.putGamma * 100 * spotPrice * -1;
      const netGEX = callGEX + putGEX;

      gexStrikes.push({
        strike,
        callOI: data.callOI,
        putOI: data.putOI,
        callGamma: data.callGamma,
        putGamma: data.putGamma,
        callGEX,
        putGEX,
        netGEX,
      });

      totalNetGEX += netGEX;

      if (callGEX > maxCallGEX) {
        maxCallGEX = callGEX;
        callWallStrike = strike;
      }
      if (Math.abs(putGEX) > maxPutGEX) {
        maxPutGEX = Math.abs(putGEX);
        putWallStrike = strike;
      }
    }

    // Sort by strike for zero-crossing detection
    gexStrikes.sort((a, b) => a.strike - b.strike);

    // Find GEX zero crossing (where net GEX changes sign)
    let gexZeroStrike = atm;
    for (let i = 1; i < gexStrikes.length; i++) {
      const prev = gexStrikes[i - 1]!;
      const curr = gexStrikes[i]!;
      if (prev.netGEX * curr.netGEX < 0) {
        // Sign change — interpolate
        const ratio = Math.abs(prev.netGEX) / (Math.abs(prev.netGEX) + Math.abs(curr.netGEX));
        gexZeroStrike = prev.strike + ratio * (curr.strike - prev.strike);
        break;
      }
    }

    return {
      strikes: gexStrikes,
      callWallStrike,
      putWallStrike,
      gexZeroStrike: Math.round(gexZeroStrike * 100) / 100,
      totalNetGEX,
      computedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[GEX] Failed to compute GEX for ${ticker}:`, err);
    return null;
  }
}

/**
 * Convert GEX result into PriceLevel array for the level engine.
 */
export function gexToPriceLevels(gex: GEXResult): PriceLevel[] {
  const levels: PriceLevel[] = [];

  if (gex.callWallStrike > 0) {
    levels.push({
      price: gex.callWallStrike,
      type: 'gex_call_wall',
      label: `GEX Call Wall $${gex.callWallStrike}`,
      strength: 2, // will be boosted by confluence merging
      freshness: 'fresh',
      touchCount: 0,
      source: 'premarket',
    });
  }

  if (gex.putWallStrike > 0) {
    levels.push({
      price: gex.putWallStrike,
      type: 'gex_put_wall',
      label: `GEX Put Wall $${gex.putWallStrike}`,
      strength: 2,
      freshness: 'fresh',
      touchCount: 0,
      source: 'premarket',
    });
  }

  if (gex.gexZeroStrike > 0) {
    levels.push({
      price: gex.gexZeroStrike,
      type: 'gex_zero',
      label: `GEX Zero $${gex.gexZeroStrike.toFixed(2)}`,
      strength: 1, // zero line is informational, not a hard level
      freshness: 'fresh',
      touchCount: 0,
      source: 'premarket',
    });
  }

  return levels;
}
