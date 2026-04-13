/**
 * direction-detector.ts — Price-action based direction detection.
 *
 * Determines signal direction from 3 non-lagging voters (2-of-3 consensus):
 *   1. Swing structure: higher highs + higher lows = bullish (comparing recent vs earlier halves)
 *   2. VWAP position: HTF+MTF both above VWAP = bullish
 *   3. Price velocity: LTF directional velocity > threshold = bullish
 *
 * No DMI is used for direction decisions. DMI fields are populated from
 * pre-computed TimeframeIndicators for backward compatibility only.
 *
 * Used by both signal-agent.ts (live) and backtest-day.ts (replay).
 */

import type { TimeframeIndicators } from '../types/indicators.js';
import type { DMIResult } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

export interface DirectionResult {
  direction: SignalDirection;
  dmiOnly: [DMIResult, DMIResult, DMIResult];
  reversalOverride: boolean;
  leadingSignalOverride: boolean;
}

export interface PersistenceState {
  /** Leading override momentum persistence (legacy — unused) */
  dir: 'bullish' | 'bearish' | null;
  ts: number;
  /** Direction hysteresis (legacy — unused) */
  confirmedDir?: SignalDirection;
  reversalTs?: number;
}

/**
 * Detect signal direction from pre-computed timeframe indicators.
 *
 * Uses 3 non-lagging voters with 2-of-3 consensus:
 *   1. Swing structure (HTF bars split into halves)
 *   2. VWAP position (HTF + MTF)
 *   3. Price velocity (LTF)
 *
 * @param tfIndicators  [LTF, MTF, HTF] pre-computed TimeframeIndicators
 * @param _skipSessionGaps  legacy param (ignored)
 * @param _persistence  legacy param (ignored)
 * @param _now  legacy param (ignored)
 */
export function detectDirection(
  tfIndicators: TimeframeIndicators[],
  _skipSessionGaps: boolean,
  _persistence: PersistenceState,
  _now: number,
): DirectionResult {
  const [ltf, mtf, htf] = tfIndicators;

  // ── Voter 1: Swing Structure (HTF bars, today only, 12-bar lookback) ────────
  // Uses HTF (5-min) bars, 12-bar lookback (~60 min) for stability.
  // Filter to today's session bars to avoid prior-day contamination.
  // Split into two halves, compare swing H/L.
  let swingVote: SignalDirection = 'neutral';
  if (htf) {
    const lastBar = htf.bars[htf.bars.length - 1];
    const todayDate = lastBar?.timestamp.slice(0, 10) ?? '';
    const todayBars = htf.bars.filter(b => b.timestamp.startsWith(todayDate));
    const bars = todayBars.length >= 6 ? todayBars.slice(-12) : htf.bars.slice(-12);
    const mid = Math.floor(bars.length / 2);
    if (mid >= 3) {
      const firstHalf = bars.slice(0, mid);
      const secondHalf = bars.slice(mid);

      let fh = -Infinity, fl = Infinity;
      for (const b of firstHalf) {
        if (b.high > fh) fh = b.high;
        if (b.low < fl) fl = b.low;
      }
      let sh = -Infinity, sl = Infinity;
      for (const b of secondHalf) {
        if (b.high > sh) sh = b.high;
        if (b.low < sl) sl = b.low;
      }

      const higherHigh = sh > fh;
      const higherLow = sl > fl;
      const lowerHigh = sh < fh;
      const lowerLow = sl < fl;

      if (higherHigh && higherLow) swingVote = 'bullish';
      else if (lowerHigh && lowerLow) swingVote = 'bearish';
      else if (higherHigh && !lowerLow) swingVote = 'bullish';
      else if (lowerLow && !higherHigh) swingVote = 'bearish';
    }
  }

  // ── Voter 2: VWAP Position (HTF + MTF + LTF) ───────────────────────────────
  // Majority above VWAP = bullish, majority below = bearish.
  // Uses all 3 TFs to avoid deadlock when one is exactly at VWAP.
  let vwapVote: SignalDirection = 'neutral';
  {
    let above = 0, below = 0;
    for (const tf of [ltf, mtf, htf]) {
      if (!tf) continue;
      if (tf.vwap.priceVsVwap > 0.05) above++;
      else if (tf.vwap.priceVsVwap < -0.05) below++;
    }
    if (above >= 2) vwapVote = 'bullish';
    else if (below >= 2) vwapVote = 'bearish';
  }

  // ── Voter 3: Price Velocity (LTF) ─────────────────────────────────────────
  // Directional velocity > ±0.015 = bullish/bearish.
  let velocityVote: SignalDirection = 'neutral';
  if (ltf) {
    const dv = ltf.priceVelocity.directionalVelocity;
    if (dv > 0.015) velocityVote = 'bullish';
    else if (dv < -0.015) velocityVote = 'bearish';
  }

  // ── 2-of-3 Consensus ─────────────────────────────────────────────────────
  const votes = [swingVote, vwapVote, velocityVote];
  const bullish = votes.filter(v => v === 'bullish').length;
  const bearish = votes.filter(v => v === 'bearish').length;

  let direction: SignalDirection;
  if (bullish >= 2) direction = 'bullish';
  else if (bearish >= 2) direction = 'bearish';
  else direction = 'neutral';

  // Populate dmiOnly from pre-computed TF indicators for backward compat
  const dmiOnly: [DMIResult, DMIResult, DMIResult] = [
    ltf?.dmi ?? emptyDmi(),
    mtf?.dmi ?? emptyDmi(),
    htf?.dmi ?? emptyDmi(),
  ];

  return {
    direction,
    dmiOnly,
    reversalOverride: false,
    leadingSignalOverride: false,
  };
}

function emptyDmi(): DMIResult {
  return {
    plusDI: 0, minusDI: 0, adx: 0,
    trend: 'neutral', adxStrength: 'weak',
    crossedUp: false, crossedDown: false,
    recentCrossUp: false, recentCrossDown: false,
    adxBarsAbove25: 0, adxSlope: 0, diSpreadSlope: 0,
    growthCrossUp: false, growthCrossDown: false,
  };
}
