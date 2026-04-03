/**
 * AAPL-specific trading strategy.
 *
 * Initial config — no backtest tuning yet.
 *
 * AAPL characteristics:
 *   - Very liquid options, tight spreads (2nd most liquid single-stock)
 *   - Lower ATR% than NVDA — smoother, steadier moves
 *   - Tends to trend cleanly with institutional flow
 *
 * AAPL-specific filters:
 *   - atrPct < 0.06% (AAPL moves less than NVDA; lower floor)
 *   - First 30 min blocked (opening volatility)
 *   - trend choppiness >= 0.65 (AAPL trends cleaner than NVDA)
 *   - trend regime >= 90 + negative momentum (overextended)
 *   - breakout structureBonus <= 0
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY/QQQ/IWM/NVDA.
 */
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayBars = bars.filter(b => {
    if (!b.timestamp.startsWith(todayStr)) return false;
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const mins = h * 60 + m;
    return mins >= 810 && mins < 1200; // 13:30–20:00 UTC
  });
  if (todayBars.length < 20) return 50;

  const recent30 = todayBars.slice(-30);
  let flips = 0;
  let prevDir: 'up' | 'down' | null = null;
  for (const bar of recent30) {
    const dir = bar.close >= bar.open ? 'up' : 'down';
    if (prevDir && dir !== prevDir) flips++;
    prevDir = dir;
  }
  const expectedFlips = Math.max(1, recent30.length / 4);
  const choppiness = Math.max(0, Math.min(4, flips / expectedFlips));
  const choppinessComponent = (1 - choppiness) * 15;

  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

  const last10 = todayBars.slice(-10);
  let consecUp = 0, consecDown = 0, maxConsecUp = 0, maxConsecDown = 0;
  for (let i = 1; i < last10.length; i++) {
    if (last10[i]!.close > last10[i - 1]!.close) {
      consecUp++; consecDown = 0;
      if (consecUp > maxConsecUp) maxConsecUp = consecUp;
    } else {
      consecDown++; consecUp = 0;
      if (consecDown > maxConsecDown) maxConsecDown = consecDown;
    }
  }
  const trendStrComponent = Math.min(10, Math.max(maxConsecUp, maxConsecDown) * 2.5);
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

// ── AAPL Mode Detection ─────────────────────────────────────────────────────

import { defaultStrategy } from './default.js';

function aaplDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ReturnType<typeof defaultStrategy.detectMode> {
  const ltf = tfIndicators[0];
  if (ltf) {
    _lastRegimeScore = computeRegimeScore(
      ltf.bars,
      ltf.vwap?.priceVsVwap ?? 0,
      ltf.dmi.adx,
    );
  }
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── AAPL Entry Filter ───────────────────────────────────────────────────────

function aaplShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.06) return `atrPct ${atrPct.toFixed(3)}% < 0.06%`;

  if (signalMode === 'trend') {
    // AAPL trend entries with very weak DI spread — lowered 0.070 → 0.040 to avoid blocking all entries.
    // diSpreadBonus range is roughly -0.15 to +0.15; 0.070 is quite restrictive.
    if (cb.diSpreadBonus <= 0.040) return `trend diSpreadBonus ${cb.diSpreadBonus.toFixed(3)} <= 0.040`;
  }

  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
  }

  return true;
}

// ── Export ───────────────────────────────────────────────────────────────────

export const aaplStrategy: PartialTickerStrategy = {
  detectMode: aaplDetectMode,
  shouldAllowEntry: aaplShouldAllowEntry,
};
