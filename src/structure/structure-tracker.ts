/**
 * Structure Tracker — orchestrates swing detection, structure classification,
 * failed breakout detection, and volume profile assessment.
 *
 * Produces a StructureAnalysis that tells the level interaction detector
 * whether the current price action supports a bounce or break at a level.
 */

import type { OHLCVBar } from '../types/market.js';
import type { PriceLevel, StructureAnalysis, StructureState, SwingPoint, FailedBreakout } from '../types/levels.js';
import { detectSwingPoints, classifyStructure } from './swing-detector.js';

/**
 * Analyze current price structure from 1-min bars.
 *
 * @param bars       Today's 1-min bars (regular session only)
 * @param levels     Current price levels (for failed breakout detection)
 * @param atr        Current ATR value (for thresholds)
 */
export function analyzeStructure(
  bars: OHLCVBar[],
  levels: PriceLevel[],
  atr: number,
): StructureAnalysis {
  const empty: StructureAnalysis = {
    state: 'undetermined',
    swingPoints: [],
    higherHighs: false,
    higherLows: false,
    lowerHighs: false,
    lowerLows: false,
    volumeProfile: 'neutral',
  };

  if (bars.length < 15) return empty;

  // Detect swing points (3-bar left, 2-bar right confirmation)
  const swingPoints = detectSwingPoints(bars, 3, 2, 20);
  const { higherHighs, higherLows, lowerHighs, lowerLows } = classifyStructure(swingPoints);

  // Classify state
  let state: StructureState = 'undetermined';
  if (higherHighs && higherLows) {
    state = 'uptrend';
  } else if (lowerHighs && lowerLows) {
    state = 'downtrend';
  } else if (swingPoints.length >= 4) {
    // If we have enough swings but no clear trend → range
    state = 'range';
  }

  // Find last swing high and low
  const swingHighs = swingPoints.filter(s => s.type === 'high');
  const swingLows = swingPoints.filter(s => s.type === 'low');
  const lastSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1] : undefined;
  const lastSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1] : undefined;

  // Detect failed breakout
  const failedBreakout = detectFailedBreakout(bars, levels, atr);

  // Volume confirmation: compare volume on directional bars vs counter-bars
  const volumeProfile = assessVolumeConfirmation(bars, state);

  return {
    state,
    swingPoints,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    lastSwingHigh,
    lastSwingLow,
    failedBreakout: failedBreakout ?? undefined,
    volumeProfile,
  };
}

/**
 * Detect failed breakout: price broke through a level then reclaimed it
 * within N bars.
 *
 * This is the highest-probability setup in day trading.
 */
function detectFailedBreakout(
  bars: OHLCVBar[],
  levels: PriceLevel[],
  atr: number,
): FailedBreakout | null {
  if (bars.length < 5) return null;

  const recentBars = bars.slice(-10); // look at last 10 bars
  const currentPrice = recentBars[recentBars.length - 1]!.close;
  const breakThreshold = atr * 0.10; // must break by at least 0.10 ATR

  for (const level of levels) {
    if (level.freshness !== 'tested' && level.freshness !== 'broken') continue;

    // Check for bullish failed breakout (broke below, then reclaimed above)
    let brokeBelow = false;
    let reclaimedAbove = false;
    let breakBar = -1;

    for (let i = 0; i < recentBars.length; i++) {
      const bar = recentBars[i]!;
      if (bar.low < level.price - breakThreshold) {
        brokeBelow = true;
        breakBar = i;
      }
      if (brokeBelow && i > breakBar && bar.close > level.price + breakThreshold) {
        reclaimedAbove = true;
      }
    }

    if (brokeBelow && reclaimedAbove && currentPrice > level.price) {
      return {
        level,
        direction: 'bearish_fail', // broke down and failed → bullish setup
        detectedBarIndex: bars.length - 1,
        timestamp: recentBars[recentBars.length - 1]!.timestamp,
      };
    }

    // Check for bearish failed breakout (broke above, then reclaimed below)
    let brokeAbove = false;
    let reclaimedBelow = false;
    breakBar = -1;

    for (let i = 0; i < recentBars.length; i++) {
      const bar = recentBars[i]!;
      if (bar.high > level.price + breakThreshold) {
        brokeAbove = true;
        breakBar = i;
      }
      if (brokeAbove && i > breakBar && bar.close < level.price - breakThreshold) {
        reclaimedBelow = true;
      }
    }

    if (brokeAbove && reclaimedBelow && currentPrice < level.price) {
      return {
        level,
        direction: 'bullish_fail', // broke up and failed → bearish setup
        detectedBarIndex: bars.length - 1,
        timestamp: recentBars[recentBars.length - 1]!.timestamp,
      };
    }
  }

  return null;
}

/**
 * Assess whether volume is confirming or diverging from the structural trend.
 *
 * In an uptrend, volume should expand on up-bars and contract on down-bars.
 * The reverse for a downtrend. In a range, look for volume on breakout bars.
 */
function assessVolumeConfirmation(
  bars: OHLCVBar[],
  state: StructureState,
): StructureAnalysis['volumeProfile'] {
  if (bars.length < 20) return 'neutral';

  const recent = bars.slice(-20);
  let upVolume = 0;
  let downVolume = 0;
  let upCount = 0;
  let downCount = 0;

  for (const bar of recent) {
    if (bar.close > bar.open) {
      upVolume += bar.volume;
      upCount++;
    } else if (bar.close < bar.open) {
      downVolume += bar.volume;
      downCount++;
    }
  }

  const avgUpVol = upCount > 0 ? upVolume / upCount : 0;
  const avgDownVol = downCount > 0 ? downVolume / downCount : 0;

  if (avgUpVol === 0 && avgDownVol === 0) return 'neutral';

  const ratio = avgUpVol / (avgDownVol || 1);

  if (state === 'uptrend') {
    if (ratio > 1.3) return 'expanding_with_trend';
    if (ratio < 0.7) return 'expanding_against';
    return 'neutral';
  }
  if (state === 'downtrend') {
    if (ratio < 0.7) return 'expanding_with_trend';
    if (ratio > 1.3) return 'expanding_against';
    return 'neutral';
  }

  // Range or undetermined
  const totalAvg = (avgUpVol + avgDownVol) / 2;
  const olderBars = bars.slice(-40, -20);
  if (olderBars.length > 0) {
    const olderAvgVol = olderBars.reduce((s, b) => s + b.volume, 0) / olderBars.length;
    if (totalAvg < olderAvgVol * 0.7) return 'contracting';
  }

  return 'neutral';
}
