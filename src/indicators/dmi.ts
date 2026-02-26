import type { OHLCVBar } from '../types/market.js';
import type { DMIResult } from '../types/indicators.js';

/**
 * Compute DMI (Directional Movement Index) + ADX
 * Uses Wilder's smoothing (EMA with alpha = 1/period)
 */
export function computeDMI(bars: OHLCVBar[], period = 14): DMIResult {
  if (bars.length < period + 1) {
    return { plusDI: 0, minusDI: 0, adx: 0, trend: 'neutral', adxStrength: 'weak', crossedUp: false, crossedDown: false };
  }

  const n = bars.length;
  const trueRange: number[] = new Array(n).fill(0);
  const dmPlus: number[] = new Array(n).fill(0);
  const dmMinus: number[] = new Array(n).fill(0);

  // Step 1: Compute TR, DM+, DM- for each bar
  for (let i = 1; i < n; i++) {
    const prev = bars[i - 1]!;
    const curr = bars[i]!;
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    trueRange[i] = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );

    if (upMove > downMove && upMove > 0) {
      dmPlus[i] = upMove;
    } else {
      dmPlus[i] = 0;
    }

    if (downMove > upMove && downMove > 0) {
      dmMinus[i] = downMove;
    } else {
      dmMinus[i] = 0;
    }
  }

  // Step 2: Wilder's smoothing (RMA) for first period
  let smoothTR = trueRange.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothDMPlus = dmPlus.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothDMMinus = dmMinus.slice(1, period + 1).reduce((a, b) => a + b, 0);

  // Compute DI+ / DI- for the first valid bar
  const diPlusArr: number[] = [];
  const diMinusArr: number[] = [];

  diPlusArr.push(smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0);
  diMinusArr.push(smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0);

  // Step 3: Continue Wilder's smoothing for remaining bars
  for (let i = period + 1; i < n; i++) {
    smoothTR = smoothTR - smoothTR / period + (trueRange[i] ?? 0);
    smoothDMPlus = smoothDMPlus - smoothDMPlus / period + (dmPlus[i] ?? 0);
    smoothDMMinus = smoothDMMinus - smoothDMMinus / period + (dmMinus[i] ?? 0);

    diPlusArr.push(smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0);
    diMinusArr.push(smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0);
  }

  // Step 4: Compute DX and ADX (Wilder's smoothed DX)
  const dxArr: number[] = diPlusArr.map((dp, i) => {
    const dm = diMinusArr[i] ?? 0;
    const sum = dp + dm;
    return sum > 0 ? (Math.abs(dp - dm) / sum) * 100 : 0;
  });

  // ADX = Wilder's smoothing of DX
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + (dxArr[i] ?? 0)) / period;
  }

  const plusDI = diPlusArr[diPlusArr.length - 1] ?? 0;
  const minusDI = diMinusArr[diMinusArr.length - 1] ?? 0;
  const prevPlusDI = diPlusArr[diPlusArr.length - 2] ?? 0;
  const prevMinusDI = diMinusArr[diMinusArr.length - 2] ?? 0;

  const trend = plusDI > minusDI ? 'bullish' : minusDI > plusDI ? 'bearish' : 'neutral';
  const adxStrength = adx >= 30 ? 'strong' : adx >= 20 ? 'moderate' : 'weak';
  const crossedUp = plusDI > minusDI && prevPlusDI <= prevMinusDI;
  const crossedDown = minusDI > plusDI && prevMinusDI <= prevPlusDI;

  return { plusDI, minusDI, adx, trend, adxStrength, crossedUp, crossedDown };
}
