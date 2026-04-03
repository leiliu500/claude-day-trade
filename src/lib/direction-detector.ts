/**
 * direction-detector.ts — Shared direction detection logic.
 *
 * Determines signal direction from DMI votes + override mechanisms:
 *   1. DMI majority vote (LTF period 8, MTF period 10, HTF period 14)
 *   2. Reversal override (LTF opposes + HTF fading + price at extreme)
 *   3. Leading indicator override (velocity/ROC + LTF DMI agree, opposes lagged majority)
 *   4. Volume-confirmed candle override (engulfing + 2x volume surge)
 *   5. Momentum persistence (persists a prior leading override while LTF agrees)
 *
 * Used by both signal-agent.ts (live) and backtest-day.ts (replay).
 */

import { computeDMI } from '../indicators/dmi.js';
import { computePriceVelocity } from '../indicators/price-velocity.js';
import { computeVolumeSurge } from '../indicators/volume-surge.js';
import { detectAllPatterns } from '../indicators/candle-patterns.js';
import type { OHLCVBar } from '../types/market.js';
import type { DMIResult } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

export interface DirectionResult {
  direction: SignalDirection;
  dmiOnly: [DMIResult, DMIResult, DMIResult];
  reversalOverride: boolean;
  leadingSignalOverride: boolean;
}

export interface PersistenceState {
  /** Leading override momentum persistence */
  dir: 'bullish' | 'bearish' | null;
  ts: number;
  /** Direction hysteresis — prevents rapid flip-flop on gradual moves.
   *  After a reversal override, non-override flips are blocked for a cooldown period. */
  confirmedDir?: SignalDirection;
  /** Timestamp when the last reversal override fired — starts the cooldown */
  reversalTs?: number;
}

const PERSIST_MAX_MS = 15 * 60_000;

/**
 * Detect signal direction from multi-timeframe bars.
 *
 * @param ltfBars   LTF bars (e.g. 1m), newest at end
 * @param mtfBars   MTF bars (e.g. 3m)
 * @param htfBars   HTF bars (e.g. 5m)
 * @param skipSessionGaps  true for intraday timeframes (skips overnight gap in TR)
 * @param persistence  mutable state for momentum persistence across ticks
 * @param now  current timestamp in ms (Date.now() for live, simulated for backtest)
 */
export function detectDirection(
  ltfBars: OHLCVBar[],
  mtfBars: OHLCVBar[],
  htfBars: OHLCVBar[],
  skipSessionGaps: boolean,
  persistence: PersistenceState,
  now: number,
): DirectionResult {
  // ── DMI majority vote ──────────────────────────────────────────────────────
  // LTF period 8, MTF period 10 (reduced from 14 — 30 min Wilder's smoothing
  // on 3m bars vs 42 min), HTF period 14.
  const dmiOnly: [DMIResult, DMIResult, DMIResult] = [
    computeDMI(ltfBars, 8, skipSessionGaps),
    computeDMI(mtfBars, 10, skipSessionGaps),
    computeDMI(htfBars, 14, skipSessionGaps),
  ];
  const directionVotes = dmiOnly.map(d => d.trend);
  const bullishVotes = directionVotes.filter(v => v === 'bullish').length;
  const bearishVotes = directionVotes.filter(v => v === 'bearish').length;
  let direction: SignalDirection =
    bullishVotes > bearishVotes ? 'bullish' :
    bearishVotes > bullishVotes ? 'bearish' : 'neutral';

  // ── Extended ROC (20-bar net displacement on LTF, intraday only) ─────────
  // Catches gradual moves too slow for the 5-bar velocity threshold (±0.05%).
  // Must use only today's session bars to avoid overnight gap contamination.
  const lastBar = ltfBars[ltfBars.length - 1];
  const todayDate = lastBar?.timestamp.slice(0, 10) ?? '';
  const todayBarsForRoc = ltfBars.filter(b => b.timestamp.startsWith(todayDate));
  const rocLookback = 20;
  const rocLen = todayBarsForRoc.length;
  const extRoc = rocLen > rocLookback
    ? ((todayBarsForRoc[rocLen - 1]!.close - todayBarsForRoc[rocLen - 1 - rocLookback]!.close)
       / todayBarsForRoc[rocLen - 1 - rocLookback]!.close) * 100
    : 0;

  // ── Reversal override ──────────────────────────────────────────────────────
  // When LTF/velocity/ROC opposes majority, HTF momentum is fading, and price
  // is at range extreme → the LTF is leading a direction change.
  let reversalOverride = false;
  const [ltfDmi, mtfDmi, htfDmi] = dmiOnly;
  if (direction !== 'neutral' && ltfDmi && htfDmi) {
    const ltfOpposesDir = direction === 'bullish' ? ltfDmi.trend === 'bearish'
                                                   : ltfDmi.trend === 'bullish';
    const htfFading = htfDmi.diSpreadSlope < -2;
    const htfBarsForRange = htfBars.slice(-20);
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (const b of htfBarsForRange) {
      if (b.high > rangeHigh) rangeHigh = b.high;
      if (b.low < rangeLow) rangeLow = b.low;
    }
    const rangeSize = rangeHigh - rangeLow;
    const lastPrice = htfBarsForRange[htfBarsForRange.length - 1]?.close ?? 0;
    const rangePos = rangeSize > 0 ? (lastPrice - rangeLow) / rangeSize : 0.5;
    const atExtreme = direction === 'bullish' ? rangePos >= 0.75 : rangePos <= 0.25;

    const velForReversal = computePriceVelocity(ltfBars);
    const velOpposesDir = (direction === 'bullish' && velForReversal.directionalVelocity < -0.05)
                       || (direction === 'bearish' && velForReversal.directionalVelocity > 0.05);
    const rocOpposesDir = (direction === 'bullish' && extRoc < -0.06)
                       || (direction === 'bearish' && extRoc > 0.06);
    if ((ltfOpposesDir || velOpposesDir || rocOpposesDir) && htfFading && atExtreme) {
      direction = direction === 'bullish' ? 'bearish' : 'bullish';
      reversalOverride = true;
    }
  }

  // ── Leading indicator direction override ────────────────────────────────────
  let leadingSignalOverride = false;

  // Price velocity / extended ROC direction vote.
  // Falls back to extended ROC (±0.10% over 20 bars) for gradual moves where
  // per-bar velocity never reaches the ±0.05% threshold.
  const ltfVelocity = computePriceVelocity(ltfBars);
  const velFromVelocity =
    ltfVelocity.directionalVelocity > 0.035 ? 'bullish' as const :
    ltfVelocity.directionalVelocity < -0.035 ? 'bearish' as const : null;
  const velFromRoc = !velFromVelocity
    ? (extRoc > 0.07 ? 'bullish' as const :
       extRoc < -0.07 ? 'bearish' as const : null)
    : null;
  const velDir: 'bullish' | 'bearish' | 'neutral' = velFromVelocity ?? velFromRoc ?? 'neutral';

  if (velDir !== 'neutral' && !reversalOverride) {
    const ltfAgrees = ltfDmi?.trend === velDir;
    const velocityOpposesDir = velDir !== direction;
    const accelerating = ltfVelocity.acceleration > 0.01;

    // ROC-triggered: velocity agrees in sign + HTF fading replaces ltfAgrees + accelerating
    const rocTriggered = velFromRoc != null;
    const velSignAgrees = (velDir === 'bearish' && ltfVelocity.directionalVelocity < 0)
                       || (velDir === 'bullish' && ltfVelocity.directionalVelocity > 0);

    // Don't let LTF+velocity override when HTF+MTF already agree AND their direction
    // is strengthening. When HTF DI spread is fading (diSpreadSlope < -1), the old
    // direction is weakening → LTF is probably leading a reversal, not lagging.
    const htfMtfAgreeOnDir = mtfDmi?.trend === direction && htfDmi?.trend === direction;
    const htfDirectionFading = htfDmi != null && htfDmi.diSpreadSlope < 0;
    const guardBlocks = htfMtfAgreeOnDir && !htfDirectionFading;

    // Standard path: velocity + LTF DMI agree + accelerating
    // ROC path: extended ROC + velocity sign agrees + HTF fading
    const velocityFlip = ltfAgrees && velocityOpposesDir && accelerating && !guardBlocks;
    const rocFlip = rocTriggered && velocityOpposesDir && velSignAgrees && htfDirectionFading;
    if ((velocityFlip || rocFlip) && direction !== 'neutral') {
      direction = velDir;
      leadingSignalOverride = true;
      persistence.dir = velDir;
      persistence.ts = now;
    } else if (ltfAgrees && velDir === direction && accelerating) {
      // LTF DMI + velocity CONFIRM the existing direction with acceleration
      leadingSignalOverride = true;
      if (direction === 'bullish' || direction === 'bearish') {
        persistence.dir = direction;
        persistence.ts = now;
      }
    }
  }

  // ── Volume-confirmed candle pattern direction override ──────────────────────
  if (!reversalOverride && !leadingSignalOverride) {
    const ltfPatterns = detectAllPatterns(ltfBars);
    const ltfVolume = computeVolumeSurge(ltfBars);
    const hasVolumeSurge = ltfVolume.recentVolumeRatio > 2.0;

    if (hasVolumeSurge) {
      const bullishEngulf = ltfPatterns.bullishEngulfing.present;
      const bearishEngulf = ltfPatterns.bearishEngulfing.present;

      if (bullishEngulf && direction !== 'bullish') {
        direction = 'bullish';
        leadingSignalOverride = true;
      } else if (bearishEngulf && direction !== 'bearish') {
        direction = 'bearish';
        leadingSignalOverride = true;
      } else if ((bullishEngulf && direction === 'bullish') || (bearishEngulf && direction === 'bearish')) {
        leadingSignalOverride = true;
      }
    }
  }

  // ── Momentum persistence ───────────────────────────────────────────────────
  if (!leadingSignalOverride && !reversalOverride && persistence.dir) {
    const htfMtfOppose = mtfDmi?.trend && htfDmi?.trend
      && mtfDmi.trend !== persistence.dir && htfDmi.trend !== persistence.dir;
    if (now - persistence.ts > PERSIST_MAX_MS || htfMtfOppose) {
      persistence.dir = null;
    } else if (ltfDmi?.trend === persistence.dir) {
      if (persistence.dir !== direction) direction = persistence.dir;
      leadingSignalOverride = true;
    } else {
      persistence.dir = null;
    }
  }

  // ── Direction hysteresis (reversal cooldown) ─────────────────────────────
  // During gradual reversals, LTF DMI oscillates on micro-bounces causing
  // direction to flip-flop every 1-2 bars. This prevents confidence from
  // building in the new direction.
  //
  // Fix: after a reversal override fires (strong evidence: LTF + HTF fading +
  // range extreme), block non-override direction flips for 10 minutes.
  // Only another override or a 2-of-3 DMI flip to the SAME direction as the
  // reversal can end the cooldown early.
  const REVERSAL_COOLDOWN_MS = 10 * 60_000;

  if (reversalOverride) {
    // Reversal override fired — lock in this direction
    persistence.confirmedDir = direction;
    persistence.reversalTs = now;
  } else if (persistence.reversalTs && now - persistence.reversalTs < REVERSAL_COOLDOWN_MS) {
    // Inside reversal cooldown — block flips back to old direction
    if (direction !== persistence.confirmedDir) {
      // DMI wants to flip back — hold the reversal direction unless a fresh
      // leading override fires (velocity/ROC confirmed the new direction)
      const freshLeading = leadingSignalOverride && persistence.ts === now;
      if (!freshLeading) {
        direction = persistence.confirmedDir!;
        // Protect from mode evaluator overriding direction back to old
        leadingSignalOverride = true;
      } else {
        persistence.confirmedDir = direction;
      }
    }
  } else {
    // No active cooldown — accept direction as-is
    persistence.confirmedDir = direction;
  }

  return { direction, dmiOnly, reversalOverride, leadingSignalOverride };
}
