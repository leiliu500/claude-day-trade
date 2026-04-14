import type { OHLCVBar } from '../types/market.js';

export interface BollingerResult {
  /** Middle band (20-period SMA) */
  middle: number;
  /** Upper band (middle + numDev * σ) */
  upper: number;
  /** Lower band (middle - numDev * σ) */
  lower: number;
  /** Band width as % of middle: (upper - lower) / middle * 100 */
  bandwidthPct: number;
  /** %B: (price - lower) / (upper - lower). 0=at lower, 1=at upper, >1=above upper */
  percentB: number;
  /** Squeeze: bandwidth is below 20-bar average bandwidth (volatility contraction) */
  squeeze: boolean;
  /** Price is above upper band (overbought / breakout) */
  aboveUpper: boolean;
  /** Price is below lower band (oversold / breakdown) */
  belowLower: boolean;
}

/**
 * Compute Bollinger Bands — matches ThinkorSwim BollingerBands study exactly.
 *
 * TOS formula:
 *   Middle = SMA(close, period)
 *   StdDev = population standard deviation of close over `period`
 *   Upper = Middle + numDev * StdDev
 *   Lower = Middle - numDev * StdDev
 *
 * @param period  SMA period (default 20)
 * @param numDev  Standard deviation multiplier (default 2.0)
 */
export function computeBollinger(
  bars: OHLCVBar[],
  period = 20,
  numDev = 2.0,
): BollingerResult {
  const zero: BollingerResult = {
    middle: 0, upper: 0, lower: 0,
    bandwidthPct: 0, percentB: 0.5,
    squeeze: false, aboveUpper: false, belowLower: false,
  };
  if (bars.length < period) return zero;

  // Compute SMA and StdDev over last `period` bars
  const window = bars.slice(-period);
  let sum = 0;
  for (const b of window) sum += b.close;
  const middle = sum / period;

  let variance = 0;
  for (const b of window) {
    const diff = b.close - middle;
    variance += diff * diff;
  }
  // TOS uses population stddev (divides by N, not N-1)
  const stdDev = Math.sqrt(variance / period);

  const upper = middle + numDev * stdDev;
  const lower = middle - numDev * stdDev;
  const bandwidthPct = middle > 0 ? ((upper - lower) / middle) * 100 : 0;

  const currentPrice = bars[bars.length - 1]!.close;
  const bandRange = upper - lower;
  const percentB = bandRange > 0 ? (currentPrice - lower) / bandRange : 0.5;

  // Squeeze detection: compare current bandwidth to average bandwidth over last 20 periods
  let squeeze = false;
  if (bars.length >= period * 2) {
    // Compute bandwidth for each of last 20 periods
    let bwSum = 0;
    for (let offset = 0; offset < period; offset++) {
      const w = bars.slice(-(period + offset + 1), -(offset + 1));
      if (w.length < period) continue;
      let s = 0;
      for (const b of w) s += b.close;
      const m = s / period;
      let v = 0;
      for (const b of w) { const d = b.close - m; v += d * d; }
      const sd = Math.sqrt(v / period);
      bwSum += m > 0 ? ((m + numDev * sd) - (m - numDev * sd)) / m * 100 : 0;
    }
    const avgBandwidth = bwSum / period;
    squeeze = bandwidthPct < avgBandwidth * 0.75; // bandwidth 25%+ below average
  }

  return {
    middle, upper, lower,
    bandwidthPct, percentB,
    squeeze,
    aboveUpper: currentPrice > upper,
    belowLower: currentPrice < lower,
  };
}
