import type { OHLCVBar } from '../types/market.js';

export interface StochasticResult {
  /** %K (fast stochastic, 0-100) */
  k: number;
  /** %D (signal line = SMA of %K, 0-100) */
  d: number;
  /** Previous %K for crossover detection */
  prevK: number;
  /** Previous %D for crossover detection */
  prevD: number;
  /** %K crossed above %D (bullish) */
  crossUp: boolean;
  /** %K crossed below %D (bearish) */
  crossDown: boolean;
  /** In overbought zone (%K > 80) */
  overbought: boolean;
  /** In oversold zone (%K < 20) */
  oversold: boolean;
  /** Bullish: %K crosses above %D while in oversold zone */
  bullishSignal: boolean;
  /** Bearish: %K crosses below %D while in overbought zone */
  bearishSignal: boolean;
}

/**
 * Compute Stochastic Oscillator — matches ThinkorSwim StochasticFull study.
 *
 * TOS formula:
 *   %K = SMA( (close - lowestLow(kPeriod)) / (highestHigh(kPeriod) - lowestLow(kPeriod)) * 100, kSlowing )
 *   %D = SMA(%K, dPeriod)
 *
 * Default TOS: kPeriod=14, kSlowing=1 (Fast Stochastic), dPeriod=3
 * For Full Stochastic: kSlowing=3
 *
 * @param kPeriod  Lookback for highest high / lowest low (default 14)
 * @param dPeriod  SMA period for %D signal line (default 3)
 * @param kSlowing  SMA smoothing for raw %K (default 1 = fast, 3 = full)
 */
export function computeStochastic(
  bars: OHLCVBar[],
  kPeriod = 14,
  dPeriod = 3,
  kSlowing = 1,
): StochasticResult {
  const zero: StochasticResult = {
    k: 50, d: 50, prevK: 50, prevD: 50,
    crossUp: false, crossDown: false,
    overbought: false, oversold: false,
    bullishSignal: false, bearishSignal: false,
  };
  if (bars.length < kPeriod + dPeriod + kSlowing) return zero;

  // Step 1: Compute raw %K for each bar
  const rawK: number[] = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j]!.high);
      ll = Math.min(ll, bars[j]!.low);
    }
    const range = hh - ll;
    rawK.push(range > 0 ? ((bars[i]!.close - ll) / range) * 100 : 50);
  }

  // Step 2: Smooth raw %K with SMA (kSlowing)
  const smoothedK: number[] = [];
  for (let i = kSlowing - 1; i < rawK.length; i++) {
    let sum = 0;
    for (let j = i - kSlowing + 1; j <= i; j++) sum += rawK[j]!;
    smoothedK.push(sum / kSlowing);
  }

  // Step 3: Compute %D = SMA of smoothed %K
  const dValues: number[] = [];
  for (let i = dPeriod - 1; i < smoothedK.length; i++) {
    let sum = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) sum += smoothedK[j]!;
    dValues.push(sum / dPeriod);
  }

  if (smoothedK.length < 2 || dValues.length < 2) return zero;

  const k = smoothedK[smoothedK.length - 1]!;
  const d = dValues[dValues.length - 1]!;
  const prevK = smoothedK[smoothedK.length - 2]!;
  const prevD = dValues[dValues.length - 2]!;

  const crossUp = prevK <= prevD && k > d;
  const crossDown = prevK >= prevD && k < d;
  const overbought = k > 80;
  const oversold = k < 20;

  return {
    k, d, prevK, prevD,
    crossUp, crossDown,
    overbought, oversold,
    bullishSignal: crossUp && (prevK < 20 || k < 30),
    bearishSignal: crossDown && (prevK > 80 || k > 70),
  };
}
