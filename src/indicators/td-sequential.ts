import type { OHLCVBar } from '../types/market.js';
import type { TDResult, TDSetup, TDCountdown } from '../types/indicators.js';

/**
 * TD Sequential / DeMark Setup & Countdown
 *
 * Setup: 9 consecutive bars where close > close[4] (sell setup) or close < close[4] (buy setup)
 * Countdown: 13 bars where close >= high[2] (sell) or close <= low[2] (buy)
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
  let setupCompleted = false;
  let setupCompletionIdx = -1;

  for (let i = 4; i < n; i++) {
    const curr = bars[i]!;
    const ref = bars[i - 4]!;

    if (curr.close < ref.close) {
      if (setupDir === 'buy') {
        setupCount++;
      } else {
        setupDir = 'buy';
        setupCount = 1;
        setupCompleted = false;
        setupCompletionIdx = -1;
      }
    } else if (curr.close > ref.close) {
      if (setupDir === 'sell') {
        setupCount++;
      } else {
        setupDir = 'sell';
        setupCount = 1;
        setupCompleted = false;
        setupCompletionIdx = -1;
      }
    } else {
      setupDir = 'none';
      setupCount = 0;
      setupCompleted = false;
      setupCompletionIdx = -1;
    }

    if (setupCount === 9 && !setupCompleted) {
      setupCompleted = true;
      setupCompletionIdx = i;
    }
  }

  const setup: TDSetup = {
    direction: setupCount > 0 ? setupDir : 'none',
    count: Math.min(setupCount, 9),
    completed: setupCompleted,
  };

  // ── Countdown Phase ────────────────────────────────────────────────────────
  // Countdown begins after setup completion and counts all qualifying bars
  // Buy countdown:  close <= low[2]
  // Sell countdown: close >= high[2]
  let cdCount = 0;
  let cdDir: 'buy' | 'sell' | 'none' = 'none';
  let cdCompleted = false;

  if (setupCompleted && setupCompletionIdx >= 0) {
    cdDir = setup.direction;
    for (let i = setupCompletionIdx + 1; i < n; i++) {
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
