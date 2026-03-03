import type { OHLCVBar } from '../types/market.js';
import type { TDResult, TDSetup, TDCountdown } from '../types/indicators.js';

/**
 * TD Sequential / DeMark Setup & Countdown
 *
 * Setup: 9 consecutive bars where close > close[4] (sell setup) or close < close[4] (buy setup)
 * Countdown: 13 bars where close >= high[2] (sell) or close <= low[2] (buy)
 *
 * Fix 1: countdown starts at the 9th setup bar (inclusive per DeMark rules), not bar 10.
 * Fix 2: neutral bars (close === close[4]) reset the active setup count but do NOT invalidate
 *         a previously completed setup — the countdown survives until a full opposite 9-bar
 *         setup completes.
 */
export function computeTD(bars: OHLCVBar[]): TDResult {
  const n = bars.length;

  if (n < 5) {
    return {
      setup: { direction: 'none', count: 0, completed: false },
      countdown: { direction: 'none', count: 0, completed: false },
    };
  }

  // ── Setup Phase ────────────────────────────────────────────────────────────
  let setupCount = 0;
  let setupDir: 'buy' | 'sell' | 'none' = 'none';

  // Tracks the most-recently COMPLETED setup (count first reached 9).
  // Only overwritten when a new 9-bar setup completes — neutral bars and
  // mid-sequence direction flips leave this intact.
  let completedSetupDir: 'buy' | 'sell' | 'none' = 'none';
  let completedSetupIdx = -1;

  for (let i = 4; i < n; i++) {
    const curr = bars[i]!;
    const ref = bars[i - 4]!;

    if (curr.close < ref.close) {
      if (setupDir !== 'buy') { setupDir = 'buy'; setupCount = 0; }
      setupCount++;
    } else if (curr.close > ref.close) {
      if (setupDir !== 'sell') { setupDir = 'sell'; setupCount = 0; }
      setupCount++;
    } else {
      // Neutral bar: reset active setup tracking but leave completed state intact
      setupDir = 'none';
      setupCount = 0;
    }

    // Lock in the 9th bar exactly — do not overwrite for bars 10, 11, …
    if (setupCount === 9) {
      completedSetupDir = setupDir;
      completedSetupIdx = i;
    }
  }

  const setup: TDSetup = {
    direction: setupCount > 0 ? setupDir : 'none',
    count: Math.min(setupCount, 9),
    completed: completedSetupIdx >= 0,
  };

  // ── Countdown Phase ────────────────────────────────────────────────────────
  // Countdown begins ON the 9th setup bar (inclusive) and counts all qualifying bars.
  // Buy countdown:  close <= low[2]
  // Sell countdown: close >= high[2]
  let cdCount = 0;
  let cdDir: 'buy' | 'sell' | 'none' = 'none';
  let cdCompleted = false;

  if (completedSetupIdx >= 0) {
    cdDir = completedSetupDir;
    for (let i = completedSetupIdx; i < n; i++) {
      const curr = bars[i]!;
      const ref2 = bars[i - 2]!;

      if (cdDir === 'buy' && curr.close <= ref2.low) {
        cdCount++;
      } else if (cdDir === 'sell' && curr.close >= ref2.high) {
        cdCount++;
      }

      if (cdCount >= 13) {
        cdCompleted = true;
        break;
      }
    }
  }

  const countdown: TDCountdown = {
    direction: cdDir,
    count: Math.min(cdCount, 13),
    completed: cdCompleted,
  };

  return { setup, countdown };
}
