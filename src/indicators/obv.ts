import type { OHLCVBar } from '../types/market.js';
import type { OBVResult } from '../types/indicators.js';

/**
 * On-Balance Volume (OBV)
 *
 * Classic Granville OBV: running cumulative sum where each bar adds its volume
 * if close > prev.close, subtracts if close < prev.close, leaves unchanged on ties.
 *
 * Trend is determined by comparing current OBV to OBV `period` bars ago.
 *
 * Divergence:
 *   - Bullish: price making lower lows but OBV rising → accumulation under weakness
 *   - Bearish: price making higher highs but OBV falling → distribution under strength
 */
export function computeOBV(bars: OHLCVBar[], period = 14): OBVResult {
  if (bars.length < 2) {
    return { value: 0, trend: 'neutral', divergence: 'none' };
  }

  // Build the full OBV series
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

  const currentObv = obvArr[obvArr.length - 1]!;
  const lookback = Math.min(period, obvArr.length - 1);
  const pastObv = obvArr[obvArr.length - 1 - lookback]!;

  // OBV trend over the lookback window
  const obvRising = currentObv > pastObv;
  const obvFalling = currentObv < pastObv;
  const trend = obvRising ? 'bullish' : obvFalling ? 'bearish' : 'neutral';

  // Price trend over the same window
  const currentPrice = bars[bars.length - 1]!.close;
  const pastPrice = bars[bars.length - 1 - lookback]!.close;
  const priceRising = currentPrice > pastPrice;
  const priceFalling = currentPrice < pastPrice;

  // Divergence: OBV and price moving in opposite directions
  let divergence: 'bullish' | 'bearish' | 'none' = 'none';
  if (priceFalling && obvRising) {
    divergence = 'bullish'; // accumulation beneath price weakness
  } else if (priceRising && obvFalling) {
    divergence = 'bearish'; // distribution beneath price strength
  }

  return { value: currentObv, trend, divergence };
}
