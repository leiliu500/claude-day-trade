import type { OHLCVBar } from '../types/market.js';

export interface VolumeSurgeResult {
  /** Current bar volume / average volume over lookback period.
   *  > 2.0 = volume surge (institutional activity), > 1.5 = elevated, < 0.5 = dry */
  volumeRatio: number;
  /** Average of last 3 bars' volume ratios — smooths single-bar spikes */
  recentVolumeRatio: number;
  /** Whether the surge aligns with price direction (true = volume confirms the move) */
  surgeConfirmsDirection: boolean;
  /** Volume trend: is volume increasing or decreasing over recent bars */
  volumeTrend: 'increasing' | 'decreasing' | 'flat';
}

/**
 * Detect volume surges — a LEADING indicator for institutional activity.
 * Large volume spikes often precede or coincide with the start of significant moves,
 * appearing before DMI/ADX can react.
 *
 * @param bars  OHLCV bars, newest at end
 * @param lookback  Baseline period for average volume (default 20)
 */
export function computeVolumeSurge(bars: OHLCVBar[], lookback = 20): VolumeSurgeResult {
  const zero: VolumeSurgeResult = { volumeRatio: 1, recentVolumeRatio: 1, surgeConfirmsDirection: false, volumeTrend: 'flat' };
  const n = bars.length;
  if (n < lookback + 1) return zero;

  // Baseline: average volume over lookback period (excluding last 3 bars to avoid self-influence)
  const baselineEnd = n - 3;
  const baselineStart = Math.max(0, baselineEnd - lookback);
  let baselineSum = 0;
  let baselineCount = 0;
  for (let i = baselineStart; i < baselineEnd; i++) {
    baselineSum += bars[i]!.volume;
    baselineCount++;
  }
  const avgVolume = baselineCount > 0 ? baselineSum / baselineCount : 1;
  if (avgVolume <= 0) return zero;

  // Current bar volume ratio
  const lastBar = bars[n - 1]!;
  const volumeRatio = lastBar.volume / avgVolume;

  // Recent 3-bar average volume ratio
  let recentSum = 0;
  for (let i = n - 3; i < n; i++) {
    recentSum += bars[i]!.volume / avgVolume;
  }
  const recentVolumeRatio = recentSum / 3;

  // Does the volume surge confirm price direction?
  const priceChange = lastBar.close - lastBar.open;
  const surgeConfirmsDirection = volumeRatio > 1.5 && Math.abs(priceChange) > 0;

  // Volume trend: compare last 3 bars avg vs prior 3 bars avg
  let prior3Sum = 0;
  let recent3Sum = 0;
  for (let i = n - 6; i < n - 3; i++) {
    if (i >= 0) prior3Sum += bars[i]!.volume;
  }
  for (let i = n - 3; i < n; i++) {
    recent3Sum += bars[i]!.volume;
  }
  const volumeTrend: VolumeSurgeResult['volumeTrend'] =
    recent3Sum > prior3Sum * 1.3 ? 'increasing' :
    recent3Sum < prior3Sum * 0.7 ? 'decreasing' : 'flat';

  return { volumeRatio, recentVolumeRatio, surgeConfirmsDirection, volumeTrend };
}
