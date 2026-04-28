/**
 * QQQ-specific trading strategy.
 *
 * Built from scratch 2026-04-28 — discarded the prior QQQ tuning chain (filters
 * c10fe8f / 7f6df42 / b2635a5 / 3ced689 / 2bb1b39 + the SPY-cloned baseline
 * from the 2026-04-22 session) and starting fresh from bare baseline. Same
 * playbook as SPY `6c2bb9f`, IWM `eaa89cb`, and DIA `b21bf7b` rebuilds: start
 * with regime score only, mine F-clusters from 15-mo QQQ backtest, add
 * filters incrementally based on what QQQ's data actually shows.
 *
 * QQQ tracks the Nasdaq-100 — fundamental microstructure:
 *   - 100 large-cap tech-heavy constituents
 *   - High absolute price (~$480-520 currently), comparable to SPY
 *   - Tight options spreads, deep open interest (third most-traded ETF)
 *   - Tech-weighted: AAPL/MSFT/NVDA/META/GOOGL drive ~50% of moves
 *   - Typical atrPct 0.10-0.22 (slightly higher than SPY 0.08-0.18)
 *   - More single-name news sensitivity than SPY's broader basket
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { defaultStrategy } from './default.js';

let _lastRegimeScore = 50;

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

function qqqDetectMode(
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

// Filters added incrementally from 15-mo QQQ F-cluster mining.
// Order matches backtest-configs/qqq.ts (single source of truth).
function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  // v1: bullish low-atr (any mode).
  // Bare-baseline mining (n=579 bullish, exp -0.385): bullish at atr < 0.6 is
  // structurally bad. Discrim Δexp +0.252, blocks 135 entries (2A/9B/17C/18D/
  // 89F = 66% F). Same low-atr family as SPY v1 (atr<0.6) and IWM v4 (atr<0.4)
  // — Nasdaq-100 basket low-vol regime is the "drift sideways" pattern that
  // chops up bullish entries.
  if (ctx.direction === 'bullish' && ctx.atr < 0.60) {
    return `bullish low atr ${ctx.atr.toFixed(2)} < 0.60`;
  }

  // v2: bullish afternoon dead-zone (210-300m = 14:00-15:30 ET, any mode).
  // Post-v1 mining surfaced 14:00-15:30 ET as the worst bullish pocket.
  // Slice analysis on n=1127 post-v1:
  //   bullish m[210,240): n=24 exp -1.208 dir-acc collapses (15F = 62%)
  //   bullish m[240,270): n=19 exp -0.842 (11F)
  //   bullish m[270,300): n=20 exp -0.600 (12F)
  //   combined m[210,300): n=63 exp -0.905 (8A/7B/6C/4D/38F = 60% F)
  // Both modes uniformly bad (trend exp -0.90, breakout exp -0.93). QQQ
  // tech basket bullish entries during early-afternoon are the dead zone
  // when systematic flow stalls before EOD positioning.
  if (ctx.direction === 'bullish' && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 210 && ctx.minutesSinceOpen < 300) {
    return `bullish afternoon ${ctx.minutesSinceOpen}m (14:00-15:30 ET)`;
  }

  // v3: bullish post-lunch dead-zone (150-210m = 12:00-13:30 ET, any mode).
  // Post-v2 mining (n=1075 exp -0.101): bullish 12:00-13:30 ET is the second
  // bad pocket adjacent to v2's afternoon block:
  //   bullish m[150,180): n=44 exp -0.682 (20F = 45% F)
  //   bullish m[180,210): n=30 exp -0.467 (15F = 50% F)
  //   combined m[150,210): n=74 exp -0.595 (~35F)
  // Mid-day flow lull on tech basket — same family as SPY v9 (12:00-13:30 ET)
  // but QQQ's worst-pocket window 150-210m matches SPY's window exactly.
  // Combined with v2 (210-300m), the full 12:00-15:30 ET bullish dead zone
  // is now blocked.
  if (ctx.direction === 'bullish' && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 150 && ctx.minutesSinceOpen < 210) {
    return `bullish post-lunch ${ctx.minutesSinceOpen}m (12:00-13:30 ET)`;
  }

  return true;
}

function qqqAdjustConfidence(breakdown: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return breakdown;
}

export const qqqStrategy: PartialTickerStrategy = {
  detectMode: qqqDetectMode,
  shouldAllowEntry: qqqShouldAllowEntry,
  adjustConfidence: qqqAdjustConfidence,
};

export { _lastRegimeScore };
