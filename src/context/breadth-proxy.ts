/**
 * Breadth Proxy — estimates market breadth using sector ETF correlation.
 *
 * Institutional traders watch NYSE TICK, ADD, and VOLD for breadth.
 * Since these aren't available via Alpaca, we proxy breadth by comparing
 * SPY's recent returns against sector ETFs (XLF, XLK, XLE, XLV, XLI).
 *
 * Interpretation:
 *   - All sectors moving with SPY → broad participation, strong signal
 *   - Sectors diverging → narrow leadership, weaker/fragile signal
 *   - Specific sector divergence → rotation, potential reversal
 *
 * This module also computes a simple cumulative delta proxy from
 * volume-weighted price direction (up-volume vs down-volume) which
 * approximates institutional buying/selling pressure.
 */

import { config } from '../config.js';
import { AlpacaStreamManager } from '../lib/alpaca-stream.js';
import type { OHLCVBar } from '../types/market.js';

// ── Sector ETFs to track ─────────────────────────────────────────────────────

export const SECTOR_ETFS = ['XLF', 'XLK', 'XLE', 'XLV', 'XLI'] as const;
export type SectorETF = typeof SECTOR_ETFS[number];

// ── Breadth Result ───────────────────────────────────────────────────────────

export interface BreadthResult {
  /** -1 to +1: how aligned sectors are with SPY. +1 = all moving together. */
  sectorAlignment: number;

  /** Sectors that are diverging from SPY (moving opposite direction). */
  divergingSectors: SectorETF[];

  /** Sectors confirmed moving with SPY. */
  confirmingSectors: SectorETF[];

  /** Per-sector correlation over the lookback window. */
  sectorCorrelations: Record<SectorETF, number>;

  /** Cumulative delta proxy: positive = net buying pressure, negative = net selling. */
  cumulativeDeltaProxy: number;

  /** Recent delta trend: is buying/selling pressure increasing or decreasing? */
  deltaTrend: 'increasing' | 'decreasing' | 'flat';

  /** How many sectors had data for computation. */
  sectorsAvailable: number;
}

// ── Computation ──────────────────────────────────────────────────────────────

/**
 * Compute breadth proxy from SPY and sector ETF bars.
 *
 * Requires sector ETFs to be subscribed on the stream. If bars are not
 * available for a sector, it is excluded from the calculation.
 *
 * @param spyBars    SPY 1-min bars (last ~60)
 * @param lookback   Number of bars to compare (default 30 = last 30 min)
 */
export function computeBreadthProxy(
  spyBars: OHLCVBar[],
  sectorBarsMap: Partial<Record<SectorETF, OHLCVBar[]>>,
  lookback = 30,
): BreadthResult {
  const empty: BreadthResult = {
    sectorAlignment: 0,
    divergingSectors: [],
    confirmingSectors: [],
    sectorCorrelations: { XLF: 0, XLK: 0, XLE: 0, XLV: 0, XLI: 0 },
    cumulativeDeltaProxy: 0,
    deltaTrend: 'flat',
    sectorsAvailable: 0,
  };

  if (spyBars.length < lookback + 1) return empty;

  // Compute SPY returns over lookback window
  const spyRecent = spyBars.slice(-lookback - 1);
  const spyReturns = computeReturns(spyRecent);

  const correlations: Record<string, number> = {};
  const diverging: SectorETF[] = [];
  const confirming: SectorETF[] = [];
  let alignmentSum = 0;
  let sectorsAvailable = 0;

  for (const sector of SECTOR_ETFS) {
    const sectorBars = sectorBarsMap[sector];
    if (!sectorBars || sectorBars.length < lookback + 1) {
      correlations[sector] = 0;
      continue;
    }

    const sectorRecent = sectorBars.slice(-lookback - 1);
    const sectorReturns = computeReturns(sectorRecent);

    // Compute Pearson correlation between SPY returns and sector returns
    const corr = pearsonCorrelation(spyReturns, sectorReturns);
    correlations[sector] = corr;
    sectorsAvailable++;

    if (corr > 0.3) {
      confirming.push(sector);
      alignmentSum += corr;
    } else if (corr < -0.1) {
      diverging.push(sector);
      alignmentSum += corr;
    } else {
      alignmentSum += corr;
    }
  }

  const sectorAlignment = sectorsAvailable > 0
    ? Math.max(-1, Math.min(1, alignmentSum / sectorsAvailable))
    : 0;

  // Cumulative delta proxy from SPY volume
  const { cumulativeDelta, deltaTrend } = computeDeltaProxy(spyBars, lookback);

  return {
    sectorAlignment,
    divergingSectors: diverging,
    confirmingSectors: confirming,
    sectorCorrelations: correlations as Record<SectorETF, number>,
    cumulativeDeltaProxy: cumulativeDelta,
    deltaTrend,
    sectorsAvailable,
  };
}

/**
 * Fetch sector ETF bars from the stream cache.
 *
 * Returns whatever is available — if a sector isn't subscribed or cache
 * is empty, it's simply excluded.
 */
export function fetchSectorBarsFromStream(
  minBars = 30,
): Partial<Record<SectorETF, OHLCVBar[]>> {
  const stream = AlpacaStreamManager.getInstance();
  const result: Partial<Record<SectorETF, OHLCVBar[]>> = {};

  for (const sector of SECTOR_ETFS) {
    const bars = stream.getBars(sector, '1m', minBars);
    if (bars && bars.length >= minBars) {
      result[sector] = bars;
    }
  }

  return result;
}

/**
 * Ensure sector ETFs are subscribed on the data stream.
 * Should be called once at startup (in index.ts) alongside the trading tickers.
 */
export function subscribeSectorETFs(): void {
  const stream = AlpacaStreamManager.getInstance();
  stream.connect([...SECTOR_ETFS]);
  console.log(`[BreadthProxy] Subscribed sector ETFs: ${SECTOR_ETFS.join(', ')}`);
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/** Compute bar-over-bar returns from OHLCV bars. */
function computeReturns(bars: OHLCVBar[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    const curr = bars[i]!.close;
    returns.push(prev > 0 ? (curr - prev) / prev : 0);
  }
  return returns;
}

/** Pearson correlation coefficient between two equal-length arrays. */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
    sumXY += x[i]! * y[i]!;
    sumX2 += x[i]! * x[i]!;
    sumY2 += y[i]! * y[i]!;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Compute cumulative delta proxy from volume-weighted direction.
 *
 * For each bar:
 *   - If close > open (up bar): delta += volume
 *   - If close < open (down bar): delta -= volume
 *   - Proportional split based on close position in range
 *
 * This approximates institutional order flow without L2 data.
 */
function computeDeltaProxy(
  bars: OHLCVBar[],
  lookback: number,
): { cumulativeDelta: number; deltaTrend: 'increasing' | 'decreasing' | 'flat' } {
  const recent = bars.slice(-lookback);
  if (recent.length < 10) return { cumulativeDelta: 0, deltaTrend: 'flat' };

  let cumDelta = 0;
  const deltaHistory: number[] = [];

  for (const bar of recent) {
    const range = bar.high - bar.low;
    if (range === 0) continue;

    // Position of close within the bar's range: 0 (at low) to 1 (at high)
    const closePosition = (bar.close - bar.low) / range;
    // Buy volume = closePosition * volume, sell volume = (1 - closePosition) * volume
    const barDelta = bar.volume * (2 * closePosition - 1);
    cumDelta += barDelta;
    deltaHistory.push(barDelta);
  }

  // Normalize cumulative delta to a -1..+1 scale based on total volume
  const totalVol = recent.reduce((s, b) => s + b.volume, 0);
  const normalizedDelta = totalVol > 0 ? cumDelta / totalVol : 0;

  // Delta trend: compare recent half vs earlier half
  let deltaTrend: 'increasing' | 'decreasing' | 'flat' = 'flat';
  if (deltaHistory.length >= 10) {
    const mid = Math.floor(deltaHistory.length / 2);
    const firstHalf = deltaHistory.slice(0, mid).reduce((s, d) => s + d, 0);
    const secondHalf = deltaHistory.slice(mid).reduce((s, d) => s + d, 0);
    const diff = secondHalf - firstHalf;
    const threshold = totalVol * 0.02;
    if (diff > threshold) deltaTrend = 'increasing';
    else if (diff < -threshold) deltaTrend = 'decreasing';
  }

  return { cumulativeDelta: normalizedDelta, deltaTrend };
}
