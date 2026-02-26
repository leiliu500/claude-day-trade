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

  // Compute setup: run from the end backwards to find the current active setup
  for (let i = 4; i < n; i++) {
    const curr = bars[i]!;
    const ref = bars[i - 4]!;

    if (curr.close < ref.close) {
      // Bullish setup bar (price declining — potential buy setup)
      if (setupDir === 'buy') {
        setupCount++;
      } else {
        setupDir = 'buy';
        setupCount = 1;
      }
    } else if (curr.close > ref.close) {
      // Bearish setup bar (price rising — potential sell setup)
      if (setupDir === 'sell') {
        setupCount++;
      } else {
        setupDir = 'sell';
        setupCount = 1;
      }
    } else {
      // Equality — reset setup
      setupDir = 'none';
      setupCount = 0;
    }

    if (setupCount >= 9) {
      setupCompleted = true;
      // Don't break — check if we reset after completion
      if (setupCount === 9) {
        setupCompleted = true;
      }
    }
  }

  const setup: TDSetup = {
    direction: setupCount > 0 ? setupDir : 'none',
    count: Math.min(setupCount, 9),
    completed: setupCompleted || setupCount >= 9,
  };

  // ── Countdown Phase ────────────────────────────────────────────────────────
  // Countdown begins after a setup is complete and counts qualifying bars
  // Simplified: find completed setups and count from there
  let cdCount = 0;
  let cdDir: 'buy' | 'sell' | 'none' = 'none';
  let cdCompleted = false;

  // Find if there's a completed setup to base countdown on
  if (setup.completed) {
    cdDir = setup.direction;
    // Count qualifying countdown bars after setup completion
    // For buy countdown: close <= low[2]
    // For sell countdown: close >= high[2]
    const startIdx = Math.max(0, n - 14);  // look back up to 14 bars
    for (let i = startIdx + 2; i < n; i++) {
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
