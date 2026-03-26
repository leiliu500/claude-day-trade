/**
 * NVDA-specific trading strategy.
 *
 * Initial configuration — no backtest tuning yet.
 * NVDA characteristics:
 *   - High intraday volatility (~1.5-2.5% daily range)
 *   - Clean directional moves on AI/chip news days
 *   - Very liquid weekly options (no 0DTE)
 *   - Low correlation with SPY on stock-specific catalyst days
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY/QQQ/IWM.
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

// ── NVDA Mode Detection ─────────────────────────────────────────────────────

import { defaultStrategy } from './default.js';

function nvdaDetectMode(
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

// ── NVDA Entry Filter ───────────────────────────────────────────────────────

function nvdaShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, breakdown: cb } = ctx;

  // Block stale-data entries
  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.08) return false;

  // Block negative displacement velocity (reverting momentum)
  if (ctx.displacementVelocity !== undefined && ctx.displacementVelocity < -0.003) return false;

  // Block early-morning zero-data entries
  if (ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return false;

  // Block low-confidence entries (< 80%) — 75-80% bracket was 1G/7F.
  if (ctx.confidence < 0.80) return false;

  if (signalMode === 'trend') {
    // Require trendPhase >= 0
    if (cb.trendPhaseBonus < 0) return false;

    // Block high-chop trend entries
    if ((ctx.choppiness ?? 0) >= 0.55) return false;
  }

  if (signalMode === 'breakout') {
    // Require structure confirmation
    if (cb.structureBonus <= 0) return false;

    // Require minimum regime
    if (_lastRegimeScore < 60) return false;

    // Block high-chop breakouts
    if ((ctx.choppiness ?? 0) >= 0.95) return false;

    // Block early-morning breakouts with no intraday range established
    if (ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion < 1.0) return false;
  }

  return true;
}

// ── Export ───────────────────────────────────────────────────────────────────

export const nvdaStrategy: PartialTickerStrategy = {
  detectMode: nvdaDetectMode,
  shouldAllowEntry: nvdaShouldAllowEntry,
};
