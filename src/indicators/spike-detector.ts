import type { OHLCVBar } from '../types/market.js';

export interface SpikeResult {
  /** Whether a spike was detected on the most recent 1-2 bars */
  detected: boolean;
  /** Direction of the spike */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Magnitude of the move as multiple of ATR (e.g. 2.5 = 2.5x ATR) */
  atrMultiple: number;
  /** Raw price change % of the spike move */
  changePct: number;
  /** Whether volume confirms the spike (current bar volume > 1.5x baseline) */
  volumeConfirmed: boolean;
}

/**
 * Detect price spikes — sudden 1-2 bar moves that exceed normal volatility.
 *
 * A spike is defined as a move where the last 1 or 2 bars' range exceeds
 * a threshold multiple of the recent ATR. This fires immediately on the
 * bar that spikes, with ZERO lag — unlike velocity (5 bars) or DMI (14+).
 *
 * @param bars  OHLCV bars, newest at end
 * @param atrPeriod  Baseline ATR lookback (default 14)
 * @param threshold  ATR multiple to qualify as spike (default 2.0)
 */
export function detectSpike(bars: OHLCVBar[], atrPeriod = 14, threshold = 2.0): SpikeResult {
  const neutral: SpikeResult = { detected: false, direction: 'neutral', atrMultiple: 0, changePct: 0, volumeConfirmed: false };
  const n = bars.length;
  if (n < atrPeriod + 3) return neutral;

  // Compute baseline ATR from bars [0..n-3] — exclude last 2 bars to avoid self-influence
  const baseEnd = n - 2;
  const trValues: number[] = [];
  for (let i = 1; i < baseEnd; i++) {
    const prev = bars[i - 1]!;
    const curr = bars[i]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trValues.push(tr);
  }
  if (trValues.length < atrPeriod) return neutral;

  // Wilder's smoothed ATR on baseline
  let atr = 0;
  for (let i = 0; i < atrPeriod; i++) atr += trValues[i]!;
  atr /= atrPeriod;
  for (let i = atrPeriod; i < trValues.length; i++) {
    atr = (atr * (atrPeriod - 1) + trValues[i]!) / atrPeriod;
  }
  if (atr <= 0) return neutral;

  // Check last 1 bar: close-to-close change
  const last = bars[n - 1]!;
  const prev = bars[n - 2]!;
  const change1 = last.close - prev.close;
  const mult1 = Math.abs(change1) / atr;

  // Check last 2 bars combined: close[n-1] - close[n-3]
  const prev2 = bars[n - 3]!;
  const change2 = last.close - prev2.close;
  const mult2 = Math.abs(change2) / atr;

  // Take whichever is stronger
  const isSingle = mult1 >= mult2;
  const bestMult = isSingle ? mult1 : mult2;
  const bestChange = isSingle ? change1 : change2;

  if (bestMult < threshold) return neutral;

  const basePrice = isSingle ? prev.close : prev2.close;
  const changePct = basePrice > 0 ? (bestChange / basePrice) * 100 : 0;
  const direction = bestChange > 0 ? 'bullish' : 'bearish';

  // Volume confirmation: current bar vs baseline average
  let volSum = 0;
  const volStart = Math.max(0, baseEnd - atrPeriod);
  for (let i = volStart; i < baseEnd; i++) volSum += bars[i]!.volume;
  const avgVol = volSum / (baseEnd - volStart);
  const volumeConfirmed = avgVol > 0 && last.volume > avgVol * 1.5;

  return { detected: true, direction, atrMultiple: bestMult, changePct, volumeConfirmed };
}
