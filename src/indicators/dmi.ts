import type { OHLCVBar } from '../types/market.js';
import type { DMIResult } from '../types/indicators.js';

/**
 * Compute DMI (Directional Movement Index) + ADX
 * Uses Wilder's smoothing (EMA with alpha = 1/period)
 * skipSessionGaps: when true, uses high-low only for True Range on first bar of a new session
 * to avoid overnight gap contamination (use for intraday timeframes).
 */
export function computeDMI(bars: OHLCVBar[], period = 14, skipSessionGaps = false): DMIResult {
  if (bars.length < period + 1) {
    return { plusDI: 0, minusDI: 0, adx: 0, trend: 'neutral', adxStrength: 'weak', crossedUp: false, crossedDown: false, adxBarsAbove25: 0, adxSlope: 0, diSpreadSlope: 0, growthCrossUp: false, growthCrossDown: false };
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
    const newSession = skipSessionGaps && curr.timestamp.slice(0, 10) !== prev.timestamp.slice(0, 10);

    trueRange[i] = newSession
      ? curr.high - curr.low
      : Math.max(
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

  // ADX = Wilder's smoothing of DX — track history to measure trend maturity
  const adxHistory: number[] = [];
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adxHistory.push(adx);
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + (dxArr[i] ?? 0)) / period;
    adxHistory.push(adx);
  }

  // Count consecutive recent bars where ADX > 25 (trend maturity lookback)
  let adxBarsAbove25 = 0;
  for (let i = adxHistory.length - 1; i >= 0; i--) {
    if ((adxHistory[i] ?? 0) > 25) adxBarsAbove25++;
    else break;
  }

  const plusDI = diPlusArr[diPlusArr.length - 1] ?? 0;
  const minusDI = diMinusArr[diMinusArr.length - 1] ?? 0;
  const prevPlusDI = diPlusArr[diPlusArr.length - 2] ?? 0;
  const prevMinusDI = diMinusArr[diMinusArr.length - 2] ?? 0;

  const trend = plusDI > minusDI ? 'bullish' : minusDI > plusDI ? 'bearish' : 'neutral';
  const adxStrength = adx >= 30 ? 'strong' : adx >= 20 ? 'moderate' : 'weak';
  const crossedUp = plusDI > minusDI && prevPlusDI <= prevMinusDI;
  const crossedDown = minusDI > plusDI && prevMinusDI <= prevPlusDI;

  // Recent cross: DI crossed within the last 2 bars AND still in the crossed state now.
  // Wider window than crossedUp/Down (single-bar) to avoid missing crosses between evaluation cycles.
  const prev2PlusDI = diPlusArr[diPlusArr.length - 3] ?? 0;
  const prev2MinusDI = diMinusArr[diMinusArr.length - 3] ?? 0;
  const recentCrossUp = plusDI > minusDI && (prevPlusDI <= prevMinusDI || prev2PlusDI <= prev2MinusDI);
  const recentCrossDown = minusDI > plusDI && (prevMinusDI <= prevPlusDI || prev2MinusDI <= prev2PlusDI);

  // ADX slope: change over last 3 bars — positive = trend strengthening (growth phase)
  // negative = trend weakening (exhaustion phase)
  const slopeLookback = 3;
  let adxSlope = 0;
  if (adxHistory.length >= slopeLookback + 1) {
    const adxNow = adxHistory[adxHistory.length - 1] ?? 0;
    const adxPrev = adxHistory[adxHistory.length - 1 - slopeLookback] ?? 0;
    adxSlope = adxNow - adxPrev;
  }

  // DI spread slope: change in |DI+ - DI-| over last 3 bars — positive = momentum growing
  let diSpreadSlope = 0;
  if (diPlusArr.length >= slopeLookback + 1) {
    const spreadNow = Math.abs((diPlusArr[diPlusArr.length - 1] ?? 0) - (diMinusArr[diMinusArr.length - 1] ?? 0));
    const spreadPrev = Math.abs((diPlusArr[diPlusArr.length - 1 - slopeLookback] ?? 0) - (diMinusArr[diMinusArr.length - 1 - slopeLookback] ?? 0));
    diSpreadSlope = spreadNow - spreadPrev;
  }

  // Phase-change signals: DI crossed within last 2 bars AND still in crossed state AND ADX is rising.
  // Uses recentCross (2-bar window) instead of single-bar crossedUp/Down to avoid missing
  // phase changes between evaluation cycles.
  const growthCrossUp   = recentCrossUp   && adxSlope > 0;
  const growthCrossDown = recentCrossDown && adxSlope > 0;

  return { plusDI, minusDI, adx, trend, adxStrength, crossedUp, crossedDown, adxBarsAbove25, adxSlope, diSpreadSlope, growthCrossUp, growthCrossDown };
}
