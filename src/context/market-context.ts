/**
 * Market Context Engine — determines day type, gap analysis, and volatility
 * regime from market data.
 *
 * This provides the "environment" layer: is today a trend day, rotational
 * day, or reversal day? The answer changes what setups are valid.
 *
 *   - Trend day: trade breakouts and pullbacks to levels in trend direction
 *   - Rotational day: trade level rejections (range-bound, fade extremes)
 *   - Reversal day: early trend fades, watch for failed breakouts
 *   - Undetermined: first 30 min, rely on levels alone
 */

import type { OHLCVBar } from '../types/market.js';
import type { MarketContext, DayType, VolatilityRegime, GapAnalysis, BreadthData, GEXData } from '../types/levels.js';
import type { ORBResult } from '../types/indicators.js';

/**
 * Compute market context from today's bars and reference data.
 *
 * @param todayBars1m     Today's 1-min regular-session bars
 * @param priorDayClose   Yesterday's closing price
 * @param avgDailyATRPct  Multi-day average daily ATR as % of price (from daily bars)
 * @param orb             Opening range result
 * @param marketOpenUTC   UTC hour:minute of market open (default "14:30")
 */
export function computeMarketContext(
  todayBars1m: OHLCVBar[],
  priorDayClose: number,
  avgDailyATRPct: number,
  orb: ORBResult,
  marketOpenUTC = '14:30',
  breadth?: BreadthData,
  gex?: GEXData,
): MarketContext {
  const defaultCtx: MarketContext = {
    dayType: 'undetermined',
    gap: { gapPct: 0, gapFilled: false, gapDirection: 'flat' },
    volatilityRegime: 'normal',
    realizedVolATR: 0,
    avgVolATR: avgDailyATRPct,
    minutesSinceOpen: 0,
    orbFormed: false,
    orbBreakoutSustained: false,
  };

  if (todayBars1m.length < 5 || priorDayClose <= 0) return defaultCtx;

  // Minutes since market open
  const lastBar = todayBars1m[todayBars1m.length - 1]!;
  const minutesSinceOpen = computeMinutesSinceOpen(lastBar.timestamp, marketOpenUTC);

  // Gap analysis
  const todayOpen = todayBars1m[0]!.open;
  const gap = computeGapAnalysis(todayOpen, priorDayClose, todayBars1m);

  // Volatility regime
  const { realizedVolATR, volatilityRegime } = computeVolatilityRegime(todayBars1m, avgDailyATRPct);

  // ORB breakout sustained check
  const orbBreakoutSustained = checkORBBreakoutSustained(todayBars1m, orb);

  // Day type detection (needs at least 30 minutes of data)
  const dayType = detectDayType(todayBars1m, orb, gap, orbBreakoutSustained, minutesSinceOpen);

  return {
    dayType,
    gap,
    volatilityRegime,
    realizedVolATR,
    avgVolATR: avgDailyATRPct,
    minutesSinceOpen,
    orbFormed: orb.orbFormed,
    orbBreakoutSustained,
    breadth,
    gex,
  };
}

// ── Gap Analysis ─────────────────────────────────────────────────────────────

function computeGapAnalysis(
  todayOpen: number,
  priorDayClose: number,
  todayBars: OHLCVBar[],
): GapAnalysis {
  const gapPct = ((todayOpen - priorDayClose) / priorDayClose) * 100;
  const gapDirection: GapAnalysis['gapDirection'] =
    gapPct > 0.10 ? 'up' : gapPct < -0.10 ? 'down' : 'flat';

  // Check if gap has been filled (price returned to prior close)
  let gapFilled = false;
  for (const bar of todayBars) {
    if (gapDirection === 'up' && bar.low <= priorDayClose) { gapFilled = true; break; }
    if (gapDirection === 'down' && bar.high >= priorDayClose) { gapFilled = true; break; }
  }

  return { gapPct, gapFilled, gapDirection };
}

// ── Volatility Regime ────────────────────────────────────────────────────────

function computeVolatilityRegime(
  todayBars: OHLCVBar[],
  avgDailyATRPct: number,
): { realizedVolATR: number; volatilityRegime: VolatilityRegime } {
  // Compute today's realized range as % of price
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  for (const bar of todayBars) {
    if (bar.high > dayHigh) dayHigh = bar.high;
    if (bar.low < dayLow) dayLow = bar.low;
  }
  const currentPrice = todayBars[todayBars.length - 1]!.close;
  const realizedVolATR = currentPrice > 0 ? ((dayHigh - dayLow) / currentPrice) * 100 : 0;

  // Compare to multi-day average
  let volatilityRegime: VolatilityRegime = 'normal';
  if (avgDailyATRPct > 0) {
    const ratio = realizedVolATR / avgDailyATRPct;
    if (ratio < 0.5) volatilityRegime = 'low';
    else if (ratio > 2.0) volatilityRegime = 'extreme';
    else if (ratio > 1.3) volatilityRegime = 'high';
  }

  return { realizedVolATR, volatilityRegime };
}

// ── ORB Breakout Sustained ───────────────────────────────────────────────────

function checkORBBreakoutSustained(todayBars: OHLCVBar[], orb: ORBResult): boolean {
  if (!orb.orbFormed || orb.breakoutDirection === 'none') return false;

  // Find bars after ORB formation (after 15:00 UTC / 10:00 ET)
  const postORBBars = todayBars.filter(b => b.timestamp.slice(11, 16) >= '15:00');
  if (postORBBars.length < 5) return false;

  // Check if last 5 bars are all on the breakout side
  const last5 = postORBBars.slice(-5);
  if (orb.breakoutDirection === 'bullish') {
    return last5.every(b => b.close > orb.orbHigh);
  } else {
    return last5.every(b => b.close < orb.orbLow);
  }
}

// ── Day Type Detection ───────────────────────────────────────────────────────

function detectDayType(
  todayBars: OHLCVBar[],
  orb: ORBResult,
  gap: GapAnalysis,
  orbBreakoutSustained: boolean,
  minutesSinceOpen: number,
): DayType {
  // Need at least 30 minutes of data
  if (minutesSinceOpen < 30 || !orb.orbFormed) return 'undetermined';

  const currentPrice = todayBars[todayBars.length - 1]!.close;
  const todayOpen = todayBars[0]!.open;
  const postORBBars = todayBars.filter(b => b.timestamp.slice(11, 16) >= '15:00');
  if (postORBBars.length === 0) return 'undetermined';

  // ── Trend day detection ─────────────────────────────────────────────────
  // Method 1: ORB breakout sustained + never returned to midpoint
  if (orbBreakoutSustained) {
    const midpoint = orb.orbMidpoint;
    const touchedMidpoint = postORBBars.some(b =>
      (orb.breakoutDirection === 'bullish' && b.low <= midpoint) ||
      (orb.breakoutDirection === 'bearish' && b.high >= midpoint)
    );
    if (!touchedMidpoint) {
      return orb.breakoutDirection === 'bullish' ? 'trend_up' : 'trend_down';
    }
  }

  // Method 2: Directional price movement — current price significantly above/below open
  // This catches trending days where the ORB wasn't clean but direction is clear.
  const changeFromOpen = (currentPrice - todayOpen) / todayOpen * 100;
  if (minutesSinceOpen >= 60) {
    // Track how many bars are above/below the day's midpoint (open+current)/2
    const dayMid = (todayOpen + currentPrice) / 2;
    const barsAboveMid = postORBBars.filter(b => b.close > dayMid).length;
    const barsBelowMid = postORBBars.filter(b => b.close < dayMid).length;
    const totalPostORB = postORBBars.length;
    const dominanceRatio = Math.max(barsAboveMid, barsBelowMid) / totalPostORB;

    // >70% of bars on one side + meaningful price change = trend day
    if (dominanceRatio > 0.70 && Math.abs(changeFromOpen) > 0.30) {
      return changeFromOpen > 0 ? 'trend_up' : 'trend_down';
    }
  }

  // ── Reversal day ─────────────────────────────────────────────────────────
  // Gap fills + price reverses beyond open
  if (gap.gapFilled && Math.abs(gap.gapPct) > 0.20) {
    const reversedFromGap =
      (gap.gapDirection === 'up' && currentPrice < todayOpen) ||
      (gap.gapDirection === 'down' && currentPrice > todayOpen);
    if (reversedFromGap) return 'reversal';
  }

  // Also detect intraday reversal: price moved significantly one way then reversed
  // Strict: only when price reversed >70% of a large (>0.8%) range AND crossed the open
  if (minutesSinceOpen >= 120) {
    let dayHigh = -Infinity, dayLow = Infinity;
    for (const b of todayBars) {
      if (b.high > dayHigh) dayHigh = b.high;
      if (b.low < dayLow) dayLow = b.low;
    }
    const dayRange = dayHigh - dayLow;
    const dayRangePct = dayRange / currentPrice * 100;
    if (dayRange > 0 && dayRangePct > 0.80) {
      const fromHigh = (dayHigh - currentPrice) / dayRange;
      const fromLow = (currentPrice - dayLow) / dayRange;
      // Must have crossed the open (true reversal, not just a retracement)
      const crossedOpen = (todayOpen > currentPrice && dayHigh > todayOpen) ||
                          (todayOpen < currentPrice && dayLow < todayOpen);
      if (crossedOpen && (fromHigh > 0.70 || fromLow > 0.70)) return 'reversal';
    }
  }

  // ── Rotational day ───────────────────────────────────────────────────────
  // Price stays within expanded ORB range. Relaxed: 80% of bars (not all) stay in range.
  if (minutesSinceOpen >= 45) {
    const orbRange = orb.orbHigh - orb.orbLow;
    if (orbRange > 0) {
      const expandedHigh = orb.orbHigh + orbRange * 0.75;
      const expandedLow = orb.orbLow - orbRange * 0.75;
      const barsInRange = postORBBars.filter(b =>
        b.high <= expandedHigh && b.low >= expandedLow
      ).length;
      if (barsInRange / postORBBars.length >= 0.80) return 'rotational';
    }
  }

  // ── Fallback: use price change to guess ──────────────────────────────────
  // Small intraday change with no clear trend = rotational
  if (minutesSinceOpen >= 60 && Math.abs(changeFromOpen) < 0.20) return 'rotational';

  return 'undetermined';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeMinutesSinceOpen(timestamp: string, marketOpenUTC: string): number {
  const [openH, openM] = marketOpenUTC.split(':').map(Number);
  const timeStr = timestamp.slice(11, 16);
  const [curH, curM] = timeStr.split(':').map(Number);

  const openMinutes = openH! * 60 + openM!;
  const curMinutes = curH! * 60 + curM!;

  return Math.max(0, curMinutes - openMinutes);
}
