import type { OHLCVBar } from '../types/market.js';
import type { PriorDayLevels, ORBResult } from '../types/indicators.js';

/**
 * Compute Prior Day High/Low/Close from daily bars.
 *
 * Expects daily bars ordered oldest → newest. Uses the second-to-last bar as
 * "prior day" so we get a fully-completed session rather than today's
 * in-progress bar.
 */
export function computePriorDayLevels(
  dailyBars: OHLCVBar[],
  currentPrice: number,
): PriorDayLevels {
  const empty: PriorDayLevels = {
    pdh: 0, pdl: 0, pdc: 0,
    priceVsPDH: 0, priceVsPDL: 0,
    abovePDH: false, belowPDL: false,
    structureBias: 'neutral',
  };

  // Need at least 2 bars: [prior_day, ..., today]
  if (dailyBars.length < 2) return empty;

  // Use second-to-last bar (yesterday's complete session)
  const prior = dailyBars[dailyBars.length - 2]!;
  const pdh = prior.high;
  const pdl = prior.low;
  const pdc = prior.close;

  const priceVsPDH = ((currentPrice - pdh) / pdh) * 100;
  const priceVsPDL = ((currentPrice - pdl) / pdl) * 100;
  const abovePDH = currentPrice > pdh;
  const belowPDL = currentPrice < pdl;

  const structureBias: PriorDayLevels['structureBias'] =
    abovePDH ? 'bullish' :
    belowPDL ? 'bearish' : 'neutral';

  return { pdh, pdl, pdc, priceVsPDH, priceVsPDL, abovePDH, belowPDL, structureBias };
}

/**
 * Compute Opening Range Breakout (ORB) from intraday bars.
 *
 * Opening range = first 30 minutes of regular session (9:30–10:00 ET = 14:30–15:00 UTC).
 * Works with any intraday timeframe (1m, 3m, 5m, 15m).
 *
 * Returns orbFormed=false if the opening range window hasn't closed yet or if
 * no bars fall within the opening window on today's date.
 */
export function computeORB(bars: OHLCVBar[], currentPrice: number): ORBResult {
  const empty: ORBResult = {
    orbHigh: 0, orbLow: 0, orbMidpoint: 0,
    rangeSizePct: 0,
    breakoutDirection: 'none',
    breakoutStrength: 0,
    orbFormed: false,
  };

  if (bars.length === 0) return empty;

  // Determine today's date from the last bar
  const lastTs = bars[bars.length - 1]!.timestamp;
  const todayDate = lastTs.slice(0, 10); // YYYY-MM-DD

  // Opening range window: 14:30–14:59 UTC (9:30–9:59 ET) — inclusive
  // For bars wider than 1m, include any bar whose start time falls within the window.
  const orbBars = bars.filter(bar => {
    if (!bar.timestamp.startsWith(todayDate)) return false;
    const time = bar.timestamp.slice(11, 16); // HH:MM
    return time >= '14:30' && time < '15:00';
  });

  if (orbBars.length === 0) return empty;

  // Check that the ORB window has fully closed.
  // The last bar in orbBars plus its duration must reach 15:00 UTC.
  // We approximate: the last ORB bar must start at 14:55 or earlier only if
  // the current time is at or past 15:00 UTC.
  const currentTime = lastTs.slice(11, 16); // HH:MM of last (most recent) bar
  if (currentTime < '15:00') {
    // Market before 10:00 AM ET — ORB window not yet closed
    return empty;
  }

  const orbHigh = Math.max(...orbBars.map(b => b.high));
  const orbLow  = Math.min(...orbBars.map(b => b.low));
  const orbMidpoint = (orbHigh + orbLow) / 2;
  const rangeSize = orbHigh - orbLow;
  const rangeSizePct = orbLow > 0 ? (rangeSize / orbLow) * 100 : 0;

  // Breakout direction based on where current price is relative to ORB
  let breakoutDirection: ORBResult['breakoutDirection'] = 'none';
  let breakoutStrength = 0;

  if (currentPrice > orbHigh && rangeSize > 0) {
    breakoutDirection = 'bullish';
    breakoutStrength = Math.min(1, (currentPrice - orbHigh) / rangeSize);
  } else if (currentPrice < orbLow && rangeSize > 0) {
    breakoutDirection = 'bearish';
    breakoutStrength = Math.min(1, (orbLow - currentPrice) / rangeSize);
  }

  return {
    orbHigh, orbLow, orbMidpoint, rangeSizePct,
    breakoutDirection, breakoutStrength,
    orbFormed: true,
  };
}
