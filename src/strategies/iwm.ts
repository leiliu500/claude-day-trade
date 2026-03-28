/**
 * IWM-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline: 5A/1B/6C/10F → tuned to 4A/1B/4C/0F (0% bad)
 *
 * IWM-specific filters:
 *   - Block negative displacement velocity (< -0.003)
 *   - Block trend entries with high exhaustion + low dvel
 *   - Block breakout entries at high regime (>= 75)
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY/QQQ.
 * Candle-based (choppiness, displacement velocity, trend strength) + ADX anchor + VWAP distance.
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

  // A. Choppiness
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

  // B. Displacement velocity
  const dayOpen = todayBars[0]!.open;
  let velocityComponent = 0;
  if (dayOpen > 0 && todayBars.length >= 10) {
    const recent5 = todayBars.slice(-5);
    const prior5 = todayBars.slice(-10, -5);
    const avgRecent = recent5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    const avgPrior = prior5.reduce((s, b) => s + Math.abs(b.close - dayOpen) / dayOpen * 100, 0) / 5;
    velocityComponent = Math.min(10, Math.max(-10, (avgRecent - avgPrior) * 15));
  }

  // C. Trend strength
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

  // D. ADX anchor
  const adxComponent = adx >= 20 ? Math.min(15, (adx - 20) * 1.0) : 0;

  // E. VWAP distance
  const vwapComponent = Math.min(10, Math.abs(vwapPriceVs) / 0.20 * 10);

  return Math.round(Math.max(0, Math.min(100,
    50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
  )));
}

// ── IWM Mode Detection ──────────────────────────────────────────────────────

import { defaultStrategy } from './default.js';

function iwmDetectMode(
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

  // Delegate to default mode detection
  return defaultStrategy.detectMode(tfIndicators, direction, currentPrice);
}

// ── IWM Entry Filter ────────────────────────────────────────────────────────

function iwmShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.08) return `atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  if (signalMode === 'breakout' && atrPct < 0.13) return `breakout atrPct ${atrPct.toFixed(3)}% < 0.13%`;

  if (ctx.displacementVelocity !== undefined && ctx.displacementVelocity < -0.003) return `dvel ${ctx.displacementVelocity.toFixed(4)} < -0.003`;

  if (signalMode === 'trend') {
    if (cb.trendPhaseBonus < 0) return `trend trendPhase ${cb.trendPhaseBonus.toFixed(3)} < 0`;
    if ((ctx.choppiness ?? 0) >= 0.55) return `trend choppiness ${(ctx.choppiness ?? 0).toFixed(2)} >= 0.55`;
    if (ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 7.0
        && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.10) return `trend exhausted+lowDvel rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)}`;
  }

  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
    if (_lastRegimeScore < 60) return `breakout regime ${_lastRegimeScore} < 60`;
    if ((ctx.choppiness ?? 0) >= 0.95) return `breakout choppiness ${(ctx.choppiness ?? 0).toFixed(2)} >= 0.95`;
    if (_lastRegimeScore >= 75) return `breakout regime ${_lastRegimeScore} >= 75`;
    if (ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.06
        && ctx.displacementVelocity >= 0) return `breakout lowDvel ${ctx.displacementVelocity.toFixed(4)} < 0.06`;
  }

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const iwmStrategy: PartialTickerStrategy = {
  detectMode: iwmDetectMode,
  shouldAllowEntry: iwmShouldAllowEntry,
};
