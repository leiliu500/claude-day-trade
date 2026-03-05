import type { OHLCVBar } from '../types/market.js';
import type { VWAPResult } from '../types/indicators.js';

/**
 * Cumulative VWAP with standard deviation bands — matches ThinkorSwim VWAP study.
 *
 * Resets at the start of each calendar day (ThinkorSwim DAY timeFrame default).
 * Uses bar.vwap if provided by Alpaca, otherwise falls back to typical price (H+L+C)/3.
 *
 * Matches ThinkorSwim formulas exactly:
 *   price     = Σ(vol × vwap) / Σvol
 *   deviation = sqrt( max( Σ(vol × vwap²)/Σvol − price², 0 ) )
 *   upperBand = price + numDevUp * deviation   (numDevUp = +2.0)
 *   lowerBand = price + numDevDn * deviation   (numDevDn = −2.0)
 */
export function computeVWAP(
  bars: OHLCVBar[],
  numDevUp = 2.0,
  numDevDn = -2.0,
): VWAPResult {
  if (bars.length === 0) {
    return { vwap: 0, upperBand: 0, lowerBand: 0, deviation: 0, priceVsVwap: 0 };
  }

  // Extract YYYY-MM-DD from ISO timestamp for day-boundary detection
  const getDay = (ts: string) => ts.slice(0, 10);

  let volumeSum = 0;
  let volumeVwapSum = 0;
  let volumeVwap2Sum = 0;
  let currentDay = getDay(bars[0]!.timestamp);

  for (const bar of bars) {
    const day = getDay(bar.timestamp);
    if (day !== currentDay) {
      // New calendar day — reset accumulators (matches ThinkorSwim isPeriodRolled)
      volumeSum = 0;
      volumeVwapSum = 0;
      volumeVwap2Sum = 0;
      currentDay = day;
    }

    // Use Alpaca's per-bar VWAP if available, else typical price
    const price = bar.vwap ?? (bar.high + bar.low + bar.close) / 3;
    volumeSum += bar.volume;
    volumeVwapSum += bar.volume * price;
    volumeVwap2Sum += bar.volume * price * price;
  }

  if (volumeSum === 0) {
    const lastClose = bars[bars.length - 1]!.close;
    return { vwap: lastClose, upperBand: lastClose, lowerBand: lastClose, deviation: 0, priceVsVwap: 0 };
  }

  const vwap = volumeVwapSum / volumeSum;
  const deviation = Math.sqrt(Math.max(volumeVwap2Sum / volumeSum - vwap * vwap, 0));
  const upperBand = vwap + numDevUp * deviation;
  const lowerBand = vwap + numDevDn * deviation;
  const currentPrice = bars[bars.length - 1]!.close;
  const priceVsVwap = ((currentPrice - vwap) / vwap) * 100;

  return { vwap, upperBand, lowerBand, deviation, priceVsVwap };
}
