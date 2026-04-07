/**
 * Swing Detector — identifies swing highs/lows using pivot patterns.
 *
 * A swing high requires the bar's high to be higher than both its left and
 * right neighbors (configurable lookback). A swing low requires the bar's
 * low to be lower than both neighbors.
 *
 * This is more robust than the existing price-structure.ts which simply
 * takes max/min over N bars — that approach always puts the swing at the
 * edge of the window rather than at the actual pivot.
 */

import type { OHLCVBar } from '../types/market.js';
import type { SwingPoint } from '../types/levels.js';

/**
 * Detect swing highs and lows using N-bar pivot pattern.
 *
 * A swing high at bar i requires:
 *   bar[i].high > bar[i-j].high for all j in 1..leftBars
 *   bar[i].high > bar[i+j].high for all j in 1..rightBars
 *
 * The rightBars requirement means the most recent `rightBars` bars
 * cannot be swing points (need future confirmation).
 *
 * @param bars      OHLCV bars (chronological order)
 * @param leftBars  Number of bars to the left that must be lower/higher (default 3)
 * @param rightBars Number of bars to the right for confirmation (default 2)
 * @param maxSwings Maximum number of swing points to return (default 20)
 */
export function detectSwingPoints(
  bars: OHLCVBar[],
  leftBars = 3,
  rightBars = 2,
  maxSwings = 20,
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const minIndex = leftBars;
  const maxIndex = bars.length - 1 - rightBars;

  if (maxIndex < minIndex) return [];

  for (let i = minIndex; i <= maxIndex; i++) {
    const bar = bars[i]!;

    // Check swing high
    let isSwingHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (bars[i - j]!.high >= bar.high) { isSwingHigh = false; break; }
    }
    if (isSwingHigh) {
      for (let j = 1; j <= rightBars; j++) {
        if (bars[i + j]!.high >= bar.high) { isSwingHigh = false; break; }
      }
    }

    // Check swing low
    let isSwingLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (bars[i - j]!.low <= bar.low) { isSwingLow = false; break; }
    }
    if (isSwingLow) {
      for (let j = 1; j <= rightBars; j++) {
        if (bars[i + j]!.low <= bar.low) { isSwingLow = false; break; }
      }
    }

    if (isSwingHigh) {
      swings.push({
        price: bar.high,
        barIndex: i,
        timestamp: bar.timestamp,
        type: 'high',
      });
    }
    if (isSwingLow) {
      swings.push({
        price: bar.low,
        barIndex: i,
        timestamp: bar.timestamp,
        type: 'low',
      });
    }
  }

  // Return most recent swings
  return swings.slice(-maxSwings);
}

/**
 * Classify trend structure from swing points.
 *
 * Returns whether the most recent swings form:
 *   - Higher highs + higher lows (uptrend)
 *   - Lower highs + lower lows (downtrend)
 *   - Mixed (range)
 */
export function classifyStructure(swings: SwingPoint[]): {
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
} {
  const recentHighs = swings.filter(s => s.type === 'high').slice(-3);
  const recentLows = swings.filter(s => s.type === 'low').slice(-3);

  let higherHighs = false;
  let lowerHighs = false;
  let higherLows = false;
  let lowerLows = false;

  if (recentHighs.length >= 2) {
    const last = recentHighs[recentHighs.length - 1]!;
    const prev = recentHighs[recentHighs.length - 2]!;
    higherHighs = last.price > prev.price;
    lowerHighs = last.price < prev.price;
  }

  if (recentLows.length >= 2) {
    const last = recentLows[recentLows.length - 1]!;
    const prev = recentLows[recentLows.length - 2]!;
    higherLows = last.price > prev.price;
    lowerLows = last.price < prev.price;
  }

  return { higherHighs, higherLows, lowerHighs, lowerLows };
}
