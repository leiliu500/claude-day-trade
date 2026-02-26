import type { OHLCVBar } from '../types/market.js';
import type { PriceStructure } from '../types/indicators.js';

/**
 * Compute a simple ATR over the last N bars using true range average.
 */
function computeSimpleATR(bars: OHLCVBar[], lookback: number): number {
  if (bars.length < 2) return 0;
  const window = bars.slice(-lookback);
  let trSum = 0;
  for (let i = 1; i < window.length; i++) {
    const curr = window[i]!;
    const prev = window[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / (window.length - 1);
}

/**
 * Compute price structure: swing high/low, swing recency, ATR, and
 * direction-aware trigger/invalidation/target levels.
 *
 * @param bars - OHLCV bars array
 * @param lookback - window for swing high/low (default 20)
 * @param direction - signal direction for level derivation (optional)
 */
export function computePriceStructure(
  bars: OHLCVBar[],
  lookback = 20,
  direction: 'bullish' | 'bearish' | 'neutral' = 'neutral'
): PriceStructure {
  const window = bars.slice(-lookback);

  if (window.length === 0) {
    return {
      swingHigh: 0, swingLow: 0, currentPrice: 0,
      priceVsSwingHigh: 0, priceVsSwingLow: 0,
      swingHighBarsAgo: 0, swingLowBarsAgo: 0,
      atrValue: 0, triggerPrice: 0, invalidationLevel: 0, targetLevel: 0, underlyingRR: 0,
    };
  }

  let swingHigh = -Infinity;
  let swingLow = Infinity;
  let swingHighIdx = 0;
  let swingLowIdx = 0;

  for (let i = 0; i < window.length; i++) {
    const b = window[i]!;
    if (b.high > swingHigh) { swingHigh = b.high; swingHighIdx = i; }
    if (b.low < swingLow)   { swingLow = b.low;   swingLowIdx = i; }
  }

  const currentPrice = bars[bars.length - 1]?.close ?? 0;
  const priceVsSwingHigh = swingHigh > 0 ? ((currentPrice - swingHigh) / swingHigh) * 100 : 0;
  const priceVsSwingLow  = swingLow > 0  ? ((currentPrice - swingLow)  / swingLow)  * 100 : 0;

  const swingHighBarsAgo = window.length - 1 - swingHighIdx;
  const swingLowBarsAgo  = window.length - 1 - swingLowIdx;
  const atrValue = computeSimpleATR(bars, lookback);

  // Direction-aware levels
  const triggerPrice = currentPrice;
  let invalidationLevel: number;
  let targetLevel: number;

  if (direction === 'bullish') {
    invalidationLevel = swingLow;
    targetLevel = swingHigh;
  } else if (direction === 'bearish') {
    invalidationLevel = swingHigh;
    targetLevel = swingLow;
  } else {
    // Neutral: pick nearest levels
    invalidationLevel = swingLow;
    targetLevel = swingHigh;
  }

  const risk = triggerPrice - invalidationLevel;
  const reward = targetLevel - triggerPrice;
  const underlyingRR = risk > 0 ? reward / risk : 0;

  return {
    swingHigh, swingLow, currentPrice,
    priceVsSwingHigh, priceVsSwingLow,
    swingHighBarsAgo, swingLowBarsAgo,
    atrValue, triggerPrice, invalidationLevel, targetLevel, underlyingRR,
  };
}
