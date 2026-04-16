/**
 * entry-context.ts — Shared entry context computation.
 *
 * Extracted from analysis-agent.ts to be reusable by both the live pipeline
 * and the backtest. Computes displacementVelocity, rangeExhaustion, and
 * choppiness from LTF bars.
 *
 * IMPORTANT: This is the single source of truth for these metrics.
 * Do NOT reimplement them elsewhere.
 */

export interface EntryMetrics {
  displacementVelocity: number;
  rangeExhaustion: number;
  choppiness: number;
  /** True when last 10+ bars form a tight consolidation that the current bar breaks out of. */
  trendConsolidationBreakout: boolean;
}

/**
 * Compute entry metrics from today's LTF bars.
 *
 * @param todayBars — Regular-session 1-min bars for today, sorted by time ascending.
 *                    Must be filtered to today only before calling.
 * @param htfAtr — HTF (5m) ATR value for range exhaustion normalization.
 * @returns Entry metrics, or undefined if insufficient data.
 */
export function computeEntryMetrics(
  todayBars: ReadonlyArray<{ timestamp: string; open: number; high: number; low: number; close: number }>,
  htfAtr: number,
): EntryMetrics | undefined {
  if (todayBars.length < 10) return undefined;

  // ── Displacement velocity ──
  // Rate of change in price displacement from day open.
  // Positive = accelerating away from open (trending), negative = reverting.
  let displacementVelocity = 0;
  const dayOpen = todayBars[0]!.open;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    displacementVelocity = avgRecent - avgPrior;
  }

  // ── Range exhaustion ──
  // Fraction of expected daily range already consumed: (dayHigh - dayLow) / HTF ATR.
  let rangeExhaustion = 0;
  if (htfAtr > 0 && todayBars.length >= 20) {
    let dayHigh = -Infinity, dayLow = Infinity;
    for (const b of todayBars) {
      if (b.high > dayHigh) dayHigh = b.high;
      if (b.low < dayLow) dayLow = b.low;
    }
    rangeExhaustion = (dayHigh - dayLow) / htfAtr;
  }

  // ── Choppiness ──
  // Direction flip frequency in last 30 bars.
  // 0 = perfectly smooth, >1 = choppy (more flips than expected at random).
  let choppiness = 0;
  if (todayBars.length >= 15) {
    const recent = todayBars.slice(-30);
    let flips = 0;
    let prevDir: string | null = null;
    for (const bar of recent) {
      const dir = bar.close >= bar.open ? 'up' : 'down';
      if (prevDir && dir !== prevDir) flips++;
      prevDir = dir;
    }
    choppiness = flips / Math.max(1, recent.length / 4);
  }

  // ── Trend consolidation breakout ──
  // Detects "bull flag" / "bear flag": tight range for 10+ bars, then price breaks out.
  // Look at bars [-15..-2] for the consolidation range, then check if bar [-1]
  // (current) breaks above/below that range.
  let trendConsolidationBreakout = false;
  if (todayBars.length >= 15) {
    const consolBars = todayBars.slice(-15, -1); // 14 bars for range
    const currentBar = todayBars[todayBars.length - 1]!;
    let consolHigh = -Infinity, consolLow = Infinity;
    for (const b of consolBars) {
      if (b.high > consolHigh) consolHigh = b.high;
      if (b.low < consolLow) consolLow = b.low;
    }
    const consolRange = consolHigh - consolLow;
    const consolRangePct = currentBar.close > 0 ? (consolRange / currentBar.close) * 100 : 999;
    // Tight consolidation: range < 0.4% of price (~$2.80 for SPY at $700)
    // Apr 16 SPY 10:45-11:00: $0.46 range on $700 = 0.066% — well under threshold
    if (consolRangePct < 0.40) {
      const brokeBullish = currentBar.close > consolHigh;
      const brokeBearish = currentBar.close < consolLow;
      trendConsolidationBreakout = brokeBullish || brokeBearish;
    }
  }

  return { displacementVelocity, rangeExhaustion, choppiness, trendConsolidationBreakout };
}
