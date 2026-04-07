/**
 * Volume Profile — computes VPOC, Value Area High/Low from intraday 1-min bars.
 *
 * Divides the day's price range into fixed-size bins, sums volume per bin,
 * then finds the VPOC (highest volume bin) and value area (70% of volume
 * centered around VPOC).
 */

import type { OHLCVBar } from '../types/market.js';
import type { VolumeProfileResult, VolumeProfileBin } from '../types/levels.js';

/**
 * Compute volume profile from intraday bars.
 *
 * @param bars  1-min bars for today's session
 * @param binSize  Price width per bin (default $0.25 for SPY-class tickers)
 * @param valueAreaPct  Fraction of total volume for value area (default 0.70)
 */
export function computeVolumeProfile(
  bars: OHLCVBar[],
  binSize = 0.25,
  valueAreaPct = 0.70,
): VolumeProfileResult {
  const empty: VolumeProfileResult = {
    vpoc: 0, valueAreaHigh: 0, valueAreaLow: 0,
    totalVolume: 0, bins: [],
  };

  if (bars.length < 10) return empty;

  // Find today's price range
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let totalVolume = 0;

  for (const bar of bars) {
    if (bar.high > dayHigh) dayHigh = bar.high;
    if (bar.low < dayLow) dayLow = bar.low;
    totalVolume += bar.volume;
  }

  if (totalVolume === 0 || dayHigh <= dayLow) return empty;

  // Create bins
  const rangeBottom = Math.floor(dayLow / binSize) * binSize;
  const rangeTop = Math.ceil(dayHigh / binSize) * binSize;
  const numBins = Math.round((rangeTop - rangeBottom) / binSize);

  if (numBins < 1 || numBins > 500) return empty;

  const binVolumes = new Float64Array(numBins);

  // Distribute each bar's volume across bins it touches
  for (const bar of bars) {
    const barLow = bar.low;
    const barHigh = bar.high;
    const barVolume = bar.volume;

    const startBin = Math.max(0, Math.floor((barLow - rangeBottom) / binSize));
    const endBin = Math.min(numBins - 1, Math.floor((barHigh - rangeBottom) / binSize));

    if (startBin === endBin) {
      binVolumes[startBin] += barVolume;
    } else {
      // Distribute proportionally across bins
      const barRange = barHigh - barLow;
      if (barRange <= 0) {
        binVolumes[startBin] += barVolume;
        continue;
      }
      for (let b = startBin; b <= endBin; b++) {
        const binBottom = rangeBottom + b * binSize;
        const binTop = binBottom + binSize;
        const overlap = Math.min(barHigh, binTop) - Math.max(barLow, binBottom);
        const fraction = overlap / barRange;
        binVolumes[b] += barVolume * fraction;
      }
    }
  }

  // Build bin array and find VPOC
  const bins: VolumeProfileBin[] = [];
  let vpocBinIdx = 0;
  let vpocVolume = 0;

  for (let i = 0; i < numBins; i++) {
    const priceMin = rangeBottom + i * binSize;
    const priceMax = priceMin + binSize;
    const volume = binVolumes[i]!;
    bins.push({
      priceMin,
      priceMax,
      priceMid: (priceMin + priceMax) / 2,
      volume,
      pctOfTotal: totalVolume > 0 ? volume / totalVolume : 0,
    });
    if (volume > vpocVolume) {
      vpocVolume = volume;
      vpocBinIdx = i;
    }
  }

  const vpoc = bins[vpocBinIdx]!.priceMid;

  // Compute value area: expand outward from VPOC bin until 70% of volume reached
  const targetVolume = totalVolume * valueAreaPct;
  let accumulatedVolume = binVolumes[vpocBinIdx]!;
  let vaLowIdx = vpocBinIdx;
  let vaHighIdx = vpocBinIdx;

  while (accumulatedVolume < targetVolume && (vaLowIdx > 0 || vaHighIdx < numBins - 1)) {
    const canGoLow = vaLowIdx > 0;
    const canGoHigh = vaHighIdx < numBins - 1;

    if (canGoLow && canGoHigh) {
      // Expand toward the side with more volume
      if (binVolumes[vaLowIdx - 1]! >= binVolumes[vaHighIdx + 1]!) {
        vaLowIdx--;
        accumulatedVolume += binVolumes[vaLowIdx]!;
      } else {
        vaHighIdx++;
        accumulatedVolume += binVolumes[vaHighIdx]!;
      }
    } else if (canGoLow) {
      vaLowIdx--;
      accumulatedVolume += binVolumes[vaLowIdx]!;
    } else {
      vaHighIdx++;
      accumulatedVolume += binVolumes[vaHighIdx]!;
    }
  }

  const valueAreaLow = bins[vaLowIdx]!.priceMin;
  const valueAreaHigh = bins[vaHighIdx]!.priceMax;

  return { vpoc, valueAreaHigh, valueAreaLow, totalVolume, bins };
}
