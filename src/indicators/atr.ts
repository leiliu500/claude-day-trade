import type { OHLCVBar } from '../types/market.js';
import type { ATRResult } from '../types/indicators.js';

/**
 * Compute ATR (Average True Range) using Wilder's smoothing
 */
export function computeATR(bars: OHLCVBar[], period = 14): ATRResult {
  if (bars.length < period + 1) {
    const lastClose = bars[bars.length - 1]?.close ?? 1;
    return { atr: 0, atrPct: 0 };
  }

  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const curr = bars[i]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trValues.push(tr);
  }

  // First ATR: simple average of first `period` TRs
  let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Subsequent ATRs: Wilder's smoothing
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + (trValues[i] ?? 0)) / period;
  }

  const lastClose = bars[bars.length - 1]?.close ?? 1;
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

  return { atr, atrPct };
}
