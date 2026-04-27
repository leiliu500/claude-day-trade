/**
 * DIA-specific trading strategy.
 *
 * Built from scratch 2026-04-27 (NOT a SPY clone). DIA tracks 30 large-cap
 * blue-chip Dow components — different microstructure from SPY's broad-500
 * basket. Even though both are large-cap ETFs, DIA's narrower constituent set
 * + price-weighted index produce different intraday signal distributions:
 *   - Heavier concentration in industrials/financials/healthcare vs SPY's
 *     tech-heavy weighting
 *   - Lower absolute price (~$425 vs ~$560) means similar atrPct% maps to
 *     smaller absolute moves — entry filters tuned in dollar terms drift
 *   - Slightly lower options liquidity than SPY, wider effective spreads
 *   - 30-stock basket reacts more linearly to broad macro / Fed headlines
 *     than SPY's tech-influenced moves
 *
 * Approach: start with no entry filters (only the structural regime score
 * computation), mine F-clusters from 15-mo backtest data, then add filters
 * incrementally based on what DIA's data actually shows. SPY's filter set is
 * intentionally NOT cloned — prior DIA tuning session (2026-04-25/26 commits
 * 57659fa..41fef00) tried that approach and produced 4 reverts + 1 marginal
 * merge before being discarded.
 */

import type { PartialTickerStrategy, EntryContext } from './strategy.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalDirection } from '../types/signal.js';
import { defaultStrategy } from './default.js';

// ── Module-level state ──────────────────────────────────────────────────────
let _lastRegimeScore = 50;

// ── Regime score ────────────────────────────────────────────────────────────
// Same hybrid algorithm as SPY/QQQ/IWM/TSLA — kept identical because regime is
// a structural breadth signal, not ticker-specific.
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

// ── DIA Mode Detection ──────────────────────────────────────────────────────
function diaDetectMode(
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

// ── DIA Entry Filter ────────────────────────────────────────────────────────
// Filters added 2026-04-27 from 15-mo F-cluster mining + time-of-day analysis.
// Order matches backtest-configs/dia.ts (single source of truth).
function diaShouldAllowEntry(ctx: EntryContext): true | string {
  // Open window — first 30 min (9:30-10:00 ET). Backtest enforces this via
  // entryWindowStartMin/EndMin in DIA_CONFIG; explicit filter ensures live
  // pipeline agrees. 15-mo bucket: n=202, exp -0.762, F-rate 60%.
  if (ctx.minutesSinceOpen !== undefined && ctx.minutesSinceOpen < 30) {
    return `open window ${ctx.minutesSinceOpen}m < 30 (first 30 min)`;
  }

  // EOD window — last 30 min (15:30-16:00 ET). 15-mo bucket: n=27, exp -1.319,
  // F-rate 74% (highest of any time bucket).
  if (ctx.minutesSinceOpen !== undefined && ctx.minutesSinceOpen >= 360) {
    return `EOD window ${ctx.minutesSinceOpen}m >= 360 (last 30 min)`;
  }

  // Midday-deep window — 12:30-13:00 ET. 15-mo: n=80, exp -1.038, F-rate 56%.
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 180 && ctx.minutesSinceOpen < 210) {
    return `midday-deep ${ctx.minutesSinceOpen}m (12:30-13:00 ET)`;
  }

  // Mid-afternoon window — 14:00-15:30 ET. 15-mo baseline: 14:00 n=51 exp -0.961,
  // 14:30 n=42 exp -1.048, 15:00 n=41 exp -0.780. Combined n=134, exp -0.943,
  // F-rate 53%. Pre-Fed-headline waiting / lower-volume regime on Dow basket.
  if (ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 270 && ctx.minutesSinceOpen < 360) {
    return `mid-afternoon ${ctx.minutesSinceOpen}m (14:00-15:30 ET)`;
  }

  // F-cluster filter: absolute ATR < 0.35 (DIA at ~$425 → ~0.08% atrPct).
  // Mined 2026-04-27 progressively from baseline → v1 (+time blocks) → v2
  // (+bullish-breakout block). v2 mining showed F-density concentrated below
  // 0.35: 51 entries at [0.30, 0.32) are 1A/6B/3C/1D/40F (78% F), 50 entries
  // at [0.32, 0.35) are 7A/2B/8C/7D/26F (52% F). Below 0.30: 6A/4B/17C/12D/104F
  // from baseline mining. Total <0.35 catches ~140 F entries with modest AB cost.
  if (ctx.atr < 0.35) {
    return `atr ${ctx.atr.toFixed(2)} < 0.35 (dead zone)`;
  }

  // Bullish breakout block — direction × mode mining 2026-04-27:
  // BULLISH/BREAKOUT n=144, exp -0.736, F-rate 49%. Bad in 14/16 monthly buckets
  // (only 2025-04 +0.143 and 2026-03 +0.444 positive). DIA Dow basket is
  // structurally bad at bullish breakout signals — without SPY's tuned breakout
  // filter chain, every confidence band ≤ 80% loses badly. Bearish breakouts
  // (exp -0.531) are kept since they match bearish-trend (no directional bias).
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout') {
    return `bullish breakout (15-mo exp -0.736)`;
  }

  // Bearish 10:30-11:00 ET window — time × direction mining 2026-04-27:
  // n=68, exp -0.779, F-rate 53%. Significant cluster of bearish entries that
  // fail in the late-morning bounce window. Same direction in earlier (10:00-10:30
  // exp -0.275) and later (11:00-11:30 exp -0.516) windows is materially better.
  if (ctx.direction === 'bearish' && ctx.minutesSinceOpen !== undefined
      && ctx.minutesSinceOpen >= 60 && ctx.minutesSinceOpen < 90) {
    return `bearish 10:30-11:00 ET window ${ctx.minutesSinceOpen}m`;
  }

  // Bearish breakout low-atr cluster — bearish-breakout subgroup mining 2026-04-27:
  // bearish-breakout overall n=101, exp -0.504. Splitting on atr=0.50: high-atr
  // (n=53) +0.094 vs low-atr (n=48) -0.979 — 1.07-point spread on same dir/mode.
  // Worst-month forensics: bad months (2025-05/07/08) have median atr=0.44 vs
  // good months 0.57; the bearish-breakout-low-atr pool is over-represented in
  // bad months. This filter removes the F-cluster while preserving high-atr
  // bearish breakouts that are net-positive.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout' && ctx.atr < 0.50) {
    return `bearish breakout low-atr ${ctx.atr.toFixed(2)} < 0.50`;
  }

  // Bearish trend weak-conditions — sub-cut mining of v6 bearish-trend (n=287
  // exp -0.314). Two disjoint F-clusters with similar magnitude:
  //   atr<0.40 only (no regime<50): n=29 exp -0.690 (4A/5B/3C/1D/16F)
  //   regime<50 only (no atr<0.40): n=27 exp -0.815 (1A/4B/7C/2D/13F)
  //   both:                          n=8  exp -2.000 (all F)
  // Combined OR: 64 entries blocked, every disjoint piece is independently
  // negative enough to justify the union. Bearish thrust without volatility OR
  // without supportive breadth fails systematically on Dow components.
  if (ctx.direction === 'bearish' && ctx.signalMode !== 'breakout'
      && (ctx.atr < 0.40 || _lastRegimeScore < 50)) {
    return `bearish trend weak (atr=${ctx.atr.toFixed(2)} regime=${_lastRegimeScore})`;
  }

  // Bullish trend low-atr — sub-cut mining of v7 bullish-trend (n=385 exp -0.153).
  // atr<0.40 cluster: n=50 exp -0.900 with 0A/10B/8C/9D/23F. Striking absence
  // of A-grades — 0/50 reach grade A in this volatility band. The 10B loss is
  // real (≥-10 score) but 23*-2=-46F savings dominate. Sub-cuts (regime/rangeExh
  // /chop) all stay below -0.5 — no meaningful "rescue pool" within the cluster.
  if (ctx.direction === 'bullish' && ctx.signalMode !== 'breakout' && ctx.atr < 0.40) {
    return `bullish trend low-atr ${ctx.atr.toFixed(2)} < 0.40 (no-A zone)`;
  }

  // Bullish trend exhausted+choppy — v9 compound mining of bullish-trend (n=383
  // exp -0.075 after adjustConfidence). rangeExh>=7.0 & chop>=2.0: n=55 exp
  // -0.636 (8A/6B/11C/3D/27F). The "trend" signal is unreliable when the
  // intraday range is already largely consumed AND the price action is flipping
  // direction frequently — classic late-day bull trap pattern on Dow components.
  if (ctx.direction === 'bullish' && ctx.signalMode !== 'breakout'
      && ctx.rangeExhaustion !== undefined && ctx.choppiness !== undefined
      && ctx.rangeExhaustion >= 7.0 && ctx.choppiness >= 2.0) {
    return `bullish trend exhausted+choppy rExh=${ctx.rangeExhaustion.toFixed(1)} chop=${ctx.choppiness.toFixed(2)}`;
  }

  return true;
}

// ── DIA Confidence Adjustment ───────────────────────────────────────────────
// Regime-gated zeroing of perverse-signed moveExhaustionPenalty. v8 factor
// analysis on 642 confirmed entries:
//   tpb<=0 (n=181, AB=76 F=62): mex AB mean=-0.0250 F=-0.0134 Δmean(F-AB)=+0.0116
//   tpb>0  (n=461, AB=195 F=163): mex AB=-0.0647 F=-0.0562 Δmean=+0.0085
// AB entries get MORE move-exhaustion penalty than F entries — the penalty is
// inversely correlated with eventual outcome quality. The perversity is
// strongest in the tpb<=0 regime (no/weak trend continuation), where Δmean
// +0.0116 is well above the +0.007 minimum-viable threshold per memory.
// Zeroing redistributes confidence from F-bias to AB-bias by removing a
// penalty that hits AB harder.
function diaAdjustConfidence(breakdown: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  if (breakdown.trendPhaseBonus <= 0 && breakdown.moveExhaustionPenalty !== 0) {
    const bd = { ...breakdown };
    bd.total -= bd.moveExhaustionPenalty;
    bd.moveExhaustionPenalty = 0;
    bd.total = Math.max(0, Math.min(1, bd.total));
    return bd;
  }
  return breakdown;
}

// ── Export ───────────────────────────────────────────────────────────────────
export const diaStrategy: PartialTickerStrategy = {
  detectMode: diaDetectMode,
  shouldAllowEntry: diaShouldAllowEntry,
  adjustConfidence: diaAdjustConfidence,
};

export { _lastRegimeScore };
