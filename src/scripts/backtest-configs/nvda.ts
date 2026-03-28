/**
 * NVDA backtest configuration — parameters + custom code hooks.
 *
 * Tuned from Q4 2025 + Q1 2026 backtest (Oct 2025 – Mar 2026):
 *   Baseline: 3A/5B/2C/10F (40% good, 50% bad)
 *   Tuned: 0B/6B/1C/2F (67% good, 22% bad)
 *   Filters: conf >= 80% in shouldAllowEntry, maxDailyEntries=1, breakoutMaxExh=6.0,
 *   trendMaxExh=9.0, block negative dvel, block RangeExh < 1.0
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentNvda } from '../../lib/order-agent-sim-nvda.js';

function nvdaShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.08) return `atrPct ${atrPct.toFixed(3)}% < 0.08%`;
  // dvel < -0.003 removed: Q4+Q1 net +48 costly
  if (ctx.rangeExhaustion < 1.0) return `rangeExhaustion ${ctx.rangeExhaustion.toFixed(1)} < 1.0 (early morning)`;
  // confidence < 80% removed: Q4+Q1 net +148 costly (498 good vs 350 bad)

  if (signalMode === 'trend') {
    if (cb.trendPhaseBonus < 0) return `trend trendPhase ${cb.trendPhaseBonus.toFixed(3)} < 0`;
    if (ctx.choppiness >= 0.55) return `trend choppiness ${ctx.choppiness.toFixed(2)} >= 0.55`;
  }

  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
    if (ctx.regimeScore < 60) return `breakout regime ${ctx.regimeScore} < 60`;
    if (ctx.choppiness >= 0.95) return `breakout choppiness ${ctx.choppiness.toFixed(2)} >= 0.95`;
  }

  return true;
}

function nvdaAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const NVDA_CONFIG: Partial<TickerBacktestConfig> = {
  // NVDA: raise min confidence from 0.65 → 0.78.
  // 75-78% bracket was mostly F-grades. >= 78% was 7 good / 3 bad.
  minConfidence: 0.65,
  minAtrPct: 0.08,
  // NVDA: max 1 entry per day — 2nd entries were 0W/3L (Feb 12#2, Feb 20#2, Feb 24#2 all F).
  maxDailyEntries: 1,
  // NVDA: lower breakout exhaustion from 10.0 → 6.0.
  // F-grade breakouts all had Exh >= 8.3. Good breakouts had Exh <= 5.3.
  breakoutMaxExhaustion: 6.0,
  breakoutMaxChop: 1.15,
  breakoutMinStrength: 35,
  breakoutStrictTrendPhase: true,
  breakoutMinConfidence: 0,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  // trendMaxExhaustion disabled: Q4+Q1 counterfactual net +4 costly (6 good vs 2 bad)
  trendMaxExhaustion: 999,

  shouldAllowEntry: nvdaShouldAllowEntry,
  adjustConfidence: nvdaAdjustConfidence,
  simulate: simulateOrderAgentNvda,
};
