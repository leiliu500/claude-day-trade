/**
 * QQQ-specific trading strategy.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Q4 2025 + Q1 2026 signal quality: 4A/2B/3F → tuned to 4A/2B/0F (0% bad)
 *
 * QQQ-specific code:
 *   - detectMode: filters stale/pre-market data via ATR% check on breakouts;
 *     computes and caches regime score for entry filter
 *   - adjustConfidence: penalizes high-exhaustion breakouts and choppy trends
 *   - shouldAllowEntry: blocks low ATR% (< 0.07 all modes, < 0.09 bearish trend),
 *     trend entries with negative trendPhase, near-level risk, weak DI spread,
 *     high choppiness (>= 0.55), bearish trend at high regime + near-zero dvel;
 *     blocks breakout entries missing structure confirmation, low regime (< 60),
 *     or high choppiness (>= 0.95)
 */

import type { PartialTickerStrategy, ModeDetectionResult, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { evaluateTrend, evaluateRange, evaluateBreakout, evaluateVwapReversion, resolveMode } from './default.js';

// ── Module-level state: regime score computed in detectMode, read in shouldAllowEntry ──
// Safe because QQQ pipeline runs serially (one tick at a time per symbol).
let _lastRegimeScore = 50;

/**
 * Compute intraday regime score — same hybrid algorithm as SPY.
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

// ── QQQ Mode Detection ──────────────────────────────────────────────────────

function qqqDetectMode(
  tfIndicators: TimeframeIndicators[],
  direction: SignalDirection,
  currentPrice: number,
): ModeDetectionResult {
  // Compute and cache regime score for shouldAllowEntry
  const ltf = tfIndicators[0];
  if (ltf) {
    _lastRegimeScore = computeRegimeScore(
      ltf.bars,
      ltf.vwap?.priceVsVwap ?? 0,
      ltf.dmi.adx,
    );
  }

  const htfTf = tfIndicators[2]!;

  const ltfTf = tfIndicators[0]!;

  // Parallel evaluation — all 4 modes are independent, every mode earns its way in
  const trendCandidate = evaluateTrend(htfTf);
  const rangeCandidate = evaluateRange(htfTf, currentPrice);
  let breakoutCandidate = evaluateBreakout(htfTf, tfIndicators, currentPrice);
  const vwapRevCandidate = evaluateVwapReversion(ltfTf, htfTf, currentPrice);

  // QQQ-specific: filter stale/pre-market data on breakout (ATR $0.37 on $625 = 0.06%)
  if (breakoutCandidate) {
    const atrPct = htfTf.atr.atr / currentPrice * 100;
    if (atrPct < 0.08) breakoutCandidate = null;
  }

  return resolveMode(trendCandidate, rangeCandidate, breakoutCandidate, vwapRevCandidate);
}

// ── QQQ Confidence Adjustment ────────────────────────────────────────────────

function qqqAdjustConfidence(cb: ConfidenceBreakdown, ctx: EntryContext): ConfidenceBreakdown {
  const adjusted = { ...cb };

  // QQQ breakouts with negative trendPhase: hard cap confidence.
  // Backtested: QQQ neg-phase breakouts always failed regardless of conf level.
  if (ctx.signalMode === 'breakout' && cb.trendPhaseBonus < 0) {
    adjusted.total = Math.min(adjusted.total, 0.64);
  }

  return adjusted;
}

// ── QQQ Entry Filter ─────────────────────────────────────────────────────────

function qqqShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.07) return `atrPct ${atrPct.toFixed(3)}% < 0.07%`;
  if (ctx.direction === 'bearish' && signalMode !== 'breakout' && atrPct < 0.09) return `bearish ${signalMode} atrPct ${atrPct.toFixed(3)}% < 0.09%`;

  if (signalMode === 'trend') {
    if (cb.trendPhaseBonus < 0) return `trend trendPhase ${cb.trendPhaseBonus.toFixed(3)} < 0`;
    if (cb.nearLevelPenalty < -0.05) return `trend nearLevelPenalty ${cb.nearLevelPenalty.toFixed(3)} < -0.05`;
    if (cb.diSpreadBonus < 0.04) return `trend diSpread ${cb.diSpreadBonus.toFixed(3)} < 0.04`;
    if ((ctx.choppiness ?? 0) >= 0.55) return `trend choppiness ${(ctx.choppiness ?? 0).toFixed(2)} >= 0.55`;
    if (ctx.direction === 'bearish' && _lastRegimeScore >= 85
        && ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.03) return `bearish trend regime ${_lastRegimeScore} >= 85 + dvel ${ctx.displacementVelocity.toFixed(4)} near zero`;
    if (ctx.rangeExhaustion !== undefined && ctx.rangeExhaustion >= 7.0
        && ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0.05) return `trend exhausted+lowDvel rExh=${ctx.rangeExhaustion.toFixed(1)} dvel=${ctx.displacementVelocity.toFixed(4)}`;
  }

  if (signalMode === 'breakout') {
    if (cb.trendPhaseBonus < 0) return `breakout trendPhase ${cb.trendPhaseBonus.toFixed(3)} < 0`;
    if (ctx.confidence < 0.72) return `breakout confidence ${(ctx.confidence * 100).toFixed(0)}% < 72%`;
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
    if (_lastRegimeScore < 60) return `breakout regime ${_lastRegimeScore} < 60`;
    if ((ctx.choppiness ?? 0) >= 0.95) return `breakout choppiness ${(ctx.choppiness ?? 0).toFixed(2)} >= 0.95`;
    if (ctx.displacementVelocity !== undefined && Math.abs(ctx.displacementVelocity) < 0.07
        && (ctx.choppiness ?? 0) >= 0.55) return `breakout lowDvel+chop dvel=${ctx.displacementVelocity.toFixed(4)} chop=${(ctx.choppiness ?? 0).toFixed(2)}`;
  }

  if (signalMode === 'vwap_reversion') {
    // vwap_reversion choppiness >= 1.5 removed: Q4+Q1 counterfactual net +2 costly (2 good, 0 bad)
    if (ctx.displacementVelocity !== undefined && ctx.displacementVelocity < 0) return `vwap_reversion dvel ${ctx.displacementVelocity.toFixed(4)} < 0`;
    if (_lastRegimeScore >= 73) return `vwap_reversion regime ${_lastRegimeScore} >= 73`;
    // vwap_reversion rangeExhaustion >= 14 removed: Q4+Q1 counterfactual net +9 costly (9 good, 0 bad)
  }

  return true;
}

// ── Export ────────────────────────────────────────────────────────────────────

export const qqqStrategy: PartialTickerStrategy = {
  detectMode: qqqDetectMode,
  adjustConfidence: qqqAdjustConfidence,
  shouldAllowEntry: qqqShouldAllowEntry,
};
