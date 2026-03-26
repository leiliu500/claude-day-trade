import type { OHLCVBar } from '../types/market.js';

export interface PriceVelocityResult {
  /** Rate of change over `period` bars: (close - close[period]) / close[period] * 100 */
  roc: number;
  /** Short-term ROC (3 bars) — captures the most recent burst of momentum */
  rocShort: number;
  /** Acceleration: rocShort - roc (positive = momentum building, negative = fading) */
  acceleration: number;
  /** Price velocity: average absolute bar-to-bar change over last 5 bars, as % of price.
   *  High velocity = fast price movement (leading signal for trend starts) */
  velocity: number;
  /** Directional velocity: signed average bar-to-bar change over last 5 bars, as % of price.
   *  Positive = moving up, negative = moving down. Unlike DMI, this has ZERO lag. */
  directionalVelocity: number;
}

/**
 * Compute price velocity / Rate of Change — a LEADING indicator with no smoothing.
 * Unlike DMI (14-period Wilder's smoothing), this reacts instantly to price movement.
 *
 * @param bars  OHLCV bars, newest at end
 * @param period  Lookback for the main ROC (default 8)
 */
export function computePriceVelocity(bars: OHLCVBar[], period = 8): PriceVelocityResult {
  const n = bars.length;
  const zero: PriceVelocityResult = { roc: 0, rocShort: 0, acceleration: 0, velocity: 0, directionalVelocity: 0 };
  if (n < period + 1) return zero;

  const lastClose = bars[n - 1]!.close;
  const prevClose = bars[n - 1 - period]!.close;
  const roc = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;

  // Short-term ROC: 3 bars
  const shortPeriod = 3;
  const shortPrevClose = bars[n - 1 - shortPeriod]?.close ?? lastClose;
  const rocShort = shortPrevClose > 0 ? ((lastClose - shortPrevClose) / shortPrevClose) * 100 : 0;

  const acceleration = rocShort - (roc * shortPeriod / period); // normalized acceleration

  // Velocity: avg absolute bar-to-bar change over last 5 bars
  const velBars = Math.min(5, n - 1);
  let absSum = 0;
  let dirSum = 0;
  for (let i = n - velBars; i < n; i++) {
    const curr = bars[i]!.close;
    const prev = bars[i - 1]!.close;
    if (prev > 0) {
      const change = ((curr - prev) / prev) * 100;
      absSum += Math.abs(change);
      dirSum += change;
    }
  }
  const velocity = absSum / velBars;
  const directionalVelocity = dirSum / velBars;

  return { roc, rocShort, acceleration, velocity, directionalVelocity };
}
