import type { OHLCVBar } from '../types/market.js';

export interface EMAResult {
  /** Fast EMA value (default 9-period) */
  emaFast: number;
  /** Slow EMA value (default 21-period) */
  emaSlow: number;
  /** Price is above fast EMA */
  priceAboveFast: boolean;
  /** Price is above slow EMA */
  priceAboveSlow: boolean;
  /** Fast EMA crossed above slow EMA (golden cross — bullish) */
  goldenCross: boolean;
  /** Fast EMA crossed below slow EMA (death cross — bearish) */
  deathCross: boolean;
  /** EMAs are aligned bullish (fast > slow) */
  bullishAlignment: boolean;
  /** EMAs are aligned bearish (fast < slow) */
  bearishAlignment: boolean;
  /** EMA spread as % of price: (fast - slow) / price * 100 */
  spreadPct: number;
}

/**
 * Compute dual EMA crossover — matches ThinkorSwim MovAvgExponential study.
 *
 * TOS EMA formula:
 *   multiplier = 2 / (period + 1)
 *   EMA[0] = SMA(first `period` values)
 *   EMA[i] = (close - EMA[i-1]) * multiplier + EMA[i-1]
 *
 * @param fastPeriod  Fast EMA (default 9)
 * @param slowPeriod  Slow EMA (default 21)
 */
export function computeEMA(
  bars: OHLCVBar[],
  fastPeriod = 9,
  slowPeriod = 21,
): EMAResult {
  const zero: EMAResult = {
    emaFast: 0, emaSlow: 0,
    priceAboveFast: false, priceAboveSlow: false,
    goldenCross: false, deathCross: false,
    bullishAlignment: false, bearishAlignment: false,
    spreadPct: 0,
  };
  if (bars.length < slowPeriod + 1) return zero;

  function calcEma(period: number): number[] {
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += bars[i]!.close;
    let prev = sum / period;
    result.push(prev);

    const mult = 2 / (period + 1);
    for (let i = period; i < bars.length; i++) {
      prev = (bars[i]!.close - prev) * mult + prev;
      result.push(prev);
    }
    return result;
  }

  const fastArr = calcEma(fastPeriod);
  const slowArr = calcEma(slowPeriod);

  // Align: fastArr starts at index fastPeriod-1, slowArr at slowPeriod-1
  // Get last 2 values of each for crossover detection
  const emaFast = fastArr[fastArr.length - 1]!;
  const emaSlow = slowArr[slowArr.length - 1]!;
  const prevFast = fastArr[fastArr.length - 2] ?? emaFast;
  const prevSlow = slowArr[slowArr.length - 2] ?? emaSlow;

  const currentPrice = bars[bars.length - 1]!.close;

  return {
    emaFast,
    emaSlow,
    priceAboveFast: currentPrice > emaFast,
    priceAboveSlow: currentPrice > emaSlow,
    goldenCross: prevFast <= prevSlow && emaFast > emaSlow,
    deathCross: prevFast >= prevSlow && emaFast < emaSlow,
    bullishAlignment: emaFast > emaSlow,
    bearishAlignment: emaFast < emaSlow,
    spreadPct: currentPrice > 0 ? ((emaFast - emaSlow) / currentPrice) * 100 : 0,
  };
}
