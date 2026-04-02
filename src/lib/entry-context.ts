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

  return { displacementVelocity, rangeExhaustion, choppiness };
}
