import type { OHLCVBar } from '../types/market.js';
import type { OBVResult } from '../types/indicators.js';

/**
 * On-Balance Volume Modified (OBVM) — matches ThinkorSwim OnBalanceVolumeModified study.
 *
 * TOS OBVM formula:
 *   1. Compute raw OBV (classic Granville cumulative volume)
 *   2. Apply moving average smoothing (EMA by default) → OBVM line
 *   3. Apply moving average to OBVM → Signal line
 *   4. Crossover of OBVM and Signal generates buy/sell signals
 *
 * TOS ThinkScript equivalent:
 *   def obv = reference OnBalanceVolume();
 *   plot OBVM = MovingAverage(averageType, obv, length);
 *   plot Signal = MovingAverage(averageType, OBVM, signalLength);
 *
 * @param bars     OHLCV bars, newest at end
 * @param length   EMA period for smoothing raw OBV (TOS default)
 * @param signalLength  EMA period for signal line (TOS default)
 * @param trendLookback  Bars to compare for trend direction (kept from original for scoring)
 */
export function computeOBV(
  bars: OHLCVBar[],
  length = 7,
  signalLength = 10,
  trendLookback = 14,
): OBVResult {
  if (bars.length < 2) {
    return {
      value: 0, obvm: 0, signal: 0,
      trend: 'neutral', divergence: 'none',
      crossUp: false, crossDown: false,
      obvmAboveSignal: false,
    };
  }

  // ── Step 1: Raw OBV (classic Granville) ─────────────────────────────────
  const obvArr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const curr = bars[i]!;
    const prevObv = obvArr[obvArr.length - 1]!;
    if (curr.close > prev.close) {
      obvArr.push(prevObv + curr.volume);
    } else if (curr.close < prev.close) {
      obvArr.push(prevObv - curr.volume);
    } else {
      obvArr.push(prevObv);
    }
  }

  // ── Step 2: OBVM = EMA(OBV, length) — matches TOS default EMA smoothing ─
  // EMA multiplier: 2 / (period + 1)
  const obvmArr = computeEMAarray(obvArr, length);

  // ── Step 3: Signal = EMA(OBVM, signalLength) ────────────────────────────
  const signalArr = computeEMAarray(obvmArr, signalLength);

  // Current values
  const currentObv = obvArr[obvArr.length - 1]!;
  const obvm = obvmArr[obvmArr.length - 1] ?? 0;
  const signal = signalArr[signalArr.length - 1] ?? 0;
  const prevObvm = obvmArr[obvmArr.length - 2] ?? obvm;
  const prevSignal = signalArr[signalArr.length - 2] ?? signal;

  // ── Crossover detection (OBVM vs Signal — the "SIGNALS" plot in TOS) ────
  const crossUp = prevObvm <= prevSignal && obvm > signal;
  const crossDown = prevObvm >= prevSignal && obvm < signal;
  const obvmAboveSignal = obvm > signal;

  // ── Trend: OBVM direction over lookback window ──────────────────────────
  const lookback = Math.min(trendLookback, obvmArr.length - 1);
  const pastObvm = obvmArr[obvmArr.length - 1 - lookback] ?? obvm;
  const obvmRising = obvm > pastObvm;
  const obvmFalling = obvm < pastObvm;
  const trend: OBVResult['trend'] = obvmRising ? 'bullish' : obvmFalling ? 'bearish' : 'neutral';

  // ── Divergence: OBVM vs price moving in opposite directions ─────────────
  const currentPrice = bars[bars.length - 1]!.close;
  const pastPrice = bars[bars.length - 1 - lookback]?.close ?? currentPrice;
  const priceRising = currentPrice > pastPrice;
  const priceFalling = currentPrice < pastPrice;

  let divergence: OBVResult['divergence'] = 'none';
  if (priceFalling && obvmRising) {
    divergence = 'bullish'; // accumulation beneath price weakness
  } else if (priceRising && obvmFalling) {
    divergence = 'bearish'; // distribution beneath price strength
  }

  return {
    value: currentObv,
    obvm,
    signal,
    trend,
    divergence,
    crossUp,
    crossDown,
    obvmAboveSignal,
  };
}

/**
 * Compute EMA over an array of numbers.
 * EMA multiplier: 2 / (period + 1) — matches TOS MovingAverage(AverageType.EXPONENTIAL)
 * Initial value: SMA of first `period` values.
 */
function computeEMAarray(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  if (data.length < period) {
    // Not enough data — return SMA of available data as single value
    const sum = data.reduce((a, b) => a + b, 0);
    return [sum / data.length];
  }

  const result: number[] = [];
  // SMA for initialization
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i]!;
  let ema = sum / period;
  result.push(ema);

  const mult = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    ema = (data[i]! - ema) * mult + ema;
    result.push(ema);
  }

  return result;
}
