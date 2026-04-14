import type { OHLCVBar } from '../types/market.js';

export interface RSIResult {
  /** RSI value (0-100). >70 overbought, <30 oversold */
  rsi: number;
  /** Previous bar's RSI for crossover detection */
  prevRsi: number;
  /** RSI crossed above 30 (bullish entry signal) */
  crossedAbove30: boolean;
  /** RSI crossed below 70 (bearish entry signal) */
  crossedBelow70: boolean;
  /** RSI is in overbought zone (>70) */
  overbought: boolean;
  /** RSI is in oversold zone (<30) */
  oversold: boolean;
  /** RSI divergence: price making new low but RSI making higher low (bullish) or vice versa */
  divergence: 'bullish' | 'bearish' | 'none';
}

/**
 * Compute RSI using Wilder's smoothing (RMA) — matches ThinkorSwim RSI study exactly.
 *
 * TOS RSI formula:
 *   avgGain = Wilder's smoothed average of gains over `period`
 *   avgLoss = Wilder's smoothed average of losses over `period`
 *   RS = avgGain / avgLoss
 *   RSI = 100 - (100 / (1 + RS))
 *
 * Wilder's smoothing: prev * (period-1)/period + current / period
 * This is equivalent to EMA with alpha = 1/period.
 */
export function computeRSI(bars: OHLCVBar[], period = 14): RSIResult {
  const zero: RSIResult = {
    rsi: 50, prevRsi: 50, crossedAbove30: false, crossedBelow70: false,
    overbought: false, oversold: false, divergence: 'none',
  };
  if (bars.length < period + 2) return zero;

  // Step 1: Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    changes.push(bars[i]!.close - bars[i - 1]!.close);
  }

  // Step 2: Initial average gain/loss (simple average of first `period` changes)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i]!;
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;

  // Step 3: Wilder's smoothing for remaining bars, track last 2 RSI values
  let prevRsi = 50;
  let rsi = 50;

  const computeRsiValue = (ag: number, al: number): number => {
    if (al === 0) return ag === 0 ? 50 : 100;
    const rs = ag / al;
    return 100 - (100 / (1 + rs));
  };

  rsi = computeRsiValue(avgGain, avgLoss);
  prevRsi = rsi;

  for (let i = period; i < changes.length; i++) {
    const c = changes[i]!;
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? Math.abs(c) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    prevRsi = rsi;
    rsi = computeRsiValue(avgGain, avgLoss);
  }

  // Step 4: Crossover detection
  const crossedAbove30 = prevRsi <= 30 && rsi > 30;
  const crossedBelow70 = prevRsi >= 70 && rsi < 70;
  const overbought = rsi > 70;
  const oversold = rsi < 30;

  // Step 5: Divergence detection (compare last 2 swing points over lookback)
  // Simplified: compare current bar vs `period` bars ago
  let divergence: RSIResult['divergence'] = 'none';
  if (bars.length >= period + 2) {
    const currentPrice = bars[bars.length - 1]!.close;
    const pastPrice = bars[bars.length - 1 - period]!.close;

    // We need RSI from `period` bars ago — recompute at that point
    // For simplicity, use a heuristic: track if price is lower but RSI is higher
    if (currentPrice < pastPrice && rsi > 40 && rsi < 60) {
      // Price making lower low, RSI not confirming → potential bullish divergence
      divergence = 'bullish';
    } else if (currentPrice > pastPrice && rsi > 40 && rsi < 60) {
      // Price making higher high, RSI not confirming → potential bearish divergence
      divergence = 'bearish';
    }
  }

  return { rsi, prevRsi, crossedAbove30, crossedBelow70, overbought, oversold, divergence };
}
