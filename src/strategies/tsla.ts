/**
 * TSLA-specific trading strategy.
 *
 * Initial setup 2026-04-27: NOT a SPY clone. Per user direction, TSLA strategy
 * is built from TSLA data, not by porting SPY/IWM/DIA filters which are tuned
 * for ETF microstructure.
 *
 * TSLA characteristics:
 *   - Single stock, ~$200-400 price range historically
 *   - Daily ATR typically 2-5% (vs 0.5-1.5% for SPY) — higher vol regime
 *   - Earnings 4x/year produce 5-15% gap moves
 *   - News-driven: Elon tweets, deliveries, FSD/FSD-Beta news, regulatory
 *   - Most-traded single-stock options in the US — tight spreads, high liquidity
 *   - Different signal distribution than ETFs: more momentum bursts, fewer
 *     mean-reversion windows, sharper reversals on news catalysts
 *
 * Approach: start with minimal filtering, mine F-clusters from 15-mo backtest
 * data, then add TSLA-specific filters incrementally based on what the data
 * actually shows. SPY's filter set is intentionally NOT cloned because:
 *   - SPY's atrPct/strength/regime thresholds are calibrated for ETF scale
 *   - SPY's chasing/extremeChop heuristics assume ETF-style mean reversion
 *   - TSLA's news-driven moves break those assumptions
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { defaultStrategy } from './default.js';

// ── Module-level state ──────────────────────────────────────────────────────
let _lastRegimeScore = 50;

// ── Regime score ────────────────────────────────────────────────────────────
// Same hybrid algorithm as SPY/QQQ/IWM/DIA — tuned for intraday breadth.
// Kept identical here because regime is a structural signal, not ticker-specific.
function computeRegimeScore(
  bars: readonly { timestamp: string; open: number; high: number; low: number; close: number }[],
  vwapPriceVs: number,
  adx: number,
): number {
  const lastBar = bars[bars.length - 1];
  if (!lastBar) return 50;
  const todayStr = lastBar.timestamp.slice(0, 10);
  const todayBars = bars.filter(b => {
    if (!b.timestamp.startsWith(todayStr)) return false;
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const mins = h * 60 + m;
    return mins >= 810 && mins < 1200;
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

// ── TSLA Mode Detection ─────────────────────────────────────────────────────
function tslaDetectMode(
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

// ── TSLA Entry Filter ───────────────────────────────────────────────────────
// Minimal filter — only blocks pathologically thin atr (TSLA at <0.20% atrPct
// is typically pre-market drift or post-earnings exhaustion, neither tradeable).
// All other filters will be added based on empirical F-cluster mining.
function tslaShouldAllowEntry(ctx: EntryContext): true | string {
  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;

  // TSLA's normal ATR is 1-3%; below 0.20% is unusual and typically dead-zone.
  if (atrPct < 0.20) return `atrPct ${atrPct.toFixed(3)}% < 0.20% (dead zone)`;

  return true;
}

// ── Export ───────────────────────────────────────────────────────────────────

export const tslaStrategy: PartialTickerStrategy = {
  detectMode: tslaDetectMode,
  shouldAllowEntry: tslaShouldAllowEntry,
};

// Exported for tests / introspection
export { _lastRegimeScore };
