import type { OHLCVBar } from '../types/market.js';

export interface MACDResult {
  /** MACD line = EMA(fast) - EMA(slow) */
  macd: number;
  /** Signal line = EMA(signalPeriod) of MACD */
  signal: number;
  /** Histogram = MACD - Signal */
  histogram: number;
  /** Previous histogram value for crossover detection */
  prevHistogram: number;
  /** Histogram crossed from negative to positive (bullish) */
  histogramCrossUp: boolean;
  /** Histogram crossed from positive to negative (bearish) */
  histogramCrossDown: boolean;
  /** MACD line crossed above signal line (bullish) */
  macdCrossUp: boolean;
  /** MACD line crossed below signal line (bearish) */
  macdCrossDown: boolean;
  /** Histogram is increasing (momentum building) */
  histogramIncreasing: boolean;
}

/**
 * Compute MACD — matches ThinkorSwim MACD study exactly.
 *
 * TOS MACD formula:
 *   MACD Line = EMA(close, fastPeriod) - EMA(close, slowPeriod)
 *   Signal Line = EMA(MACD Line, signalPeriod)
 *   Histogram = MACD Line - Signal Line
 *
 * EMA multiplier: 2 / (period + 1)
 *
 * @param fastPeriod  Fast EMA period (default 12)
 * @param slowPeriod  Slow EMA period (default 26)
 * @param signalPeriod  Signal line EMA period (default 9)
 */
export function computeMACD(
  bars: OHLCVBar[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MACDResult {
  const zero: MACDResult = {
    macd: 0, signal: 0, histogram: 0, prevHistogram: 0,
    histogramCrossUp: false, histogramCrossDown: false,
    macdCrossUp: false, macdCrossDown: false,
    histogramIncreasing: false,
  };
  if (bars.length < slowPeriod + signalPeriod) return zero;

  const closes = bars.map(b => b.close);

  // Compute EMA helper
  function ema(data: number[], period: number): number[] {
    const result: number[] = [];
    // First value: SMA of first `period` values
    let sum = 0;
    for (let i = 0; i < period && i < data.length; i++) {
      sum += data[i]!;
    }
    let prev = sum / period;
    result.push(prev);

    const multiplier = 2 / (period + 1);
    for (let i = period; i < data.length; i++) {
      prev = (data[i]! - prev) * multiplier + prev;
      result.push(prev);
    }
    return result;
  }

  // Fast EMA and Slow EMA of closes
  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  // MACD line: align fast and slow EMA arrays
  // fastEma[0] corresponds to bar index fastPeriod-1
  // slowEma[0] corresponds to bar index slowPeriod-1
  // Offset: slowPeriod - fastPeriod
  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    const fastVal = fastEma[i + offset];
    const slowVal = slowEma[i];
    if (fastVal !== undefined && slowVal !== undefined) {
      macdLine.push(fastVal - slowVal);
    }
  }

  if (macdLine.length < signalPeriod + 1) return zero;

  // Signal line: EMA of MACD line
  const signalLine = ema(macdLine, signalPeriod);

  // Histogram: MACD - Signal, aligned
  const sigOffset = signalPeriod - 1;
  const histograms: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    const macdVal = macdLine[i + sigOffset];
    const sigVal = signalLine[i];
    if (macdVal !== undefined && sigVal !== undefined) {
      histograms.push(macdVal - sigVal);
    }
  }

  if (histograms.length < 2) return zero;

  const macd = macdLine[macdLine.length - 1]!;
  const signal = signalLine[signalLine.length - 1]!;
  const histogram = histograms[histograms.length - 1]!;
  const prevHistogram = histograms[histograms.length - 2]!;
  const prevMacd = macdLine[macdLine.length - 2] ?? 0;
  const prevSignal = signalLine[signalLine.length - 2] ?? 0;

  return {
    macd,
    signal,
    histogram,
    prevHistogram,
    histogramCrossUp: prevHistogram <= 0 && histogram > 0,
    histogramCrossDown: prevHistogram >= 0 && histogram < 0,
    macdCrossUp: prevMacd <= prevSignal && macd > signal,
    macdCrossDown: prevMacd >= prevSignal && macd < signal,
    histogramIncreasing: histogram > prevHistogram,
  };
}
