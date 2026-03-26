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

function nvdaShouldAllowEntry(ctx: EntryContext): boolean {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.08) return false;

  // Block negative displacement velocity
  if (ctx.displacementVelocity < -0.003) return false;

  // Block early-morning zero-data entries (RangeExh=0, 09:30 open garbage).
  // Mar 9 F-grade: RangeExh=0.0. Good entry Mar 11 at 09:31 had RangeExh=5.2.
  if (ctx.rangeExhaustion < 1.0) return false;

  // Block low-confidence entries (< 80%) for NVDA.
  // 75-80% bracket was 1 good / 7 bad. 80%+ was 7 good / 3 bad.
  // Applied in shouldAllowEntry (not minConfidence) to preserve gate behavior.
  if (ctx.confidence < 0.80) return false;

  if (signalMode === 'trend') {
    if (cb.trendPhaseBonus < 0) return false;
    if (ctx.choppiness >= 0.55) return false;
  }

  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return false;
    if (ctx.regimeScore < 60) return false;
    if (ctx.choppiness >= 0.95) return false;
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
  // NVDA: lower trend exhaustion from 12.0 → 9.0.
  // Jan 13 (Exh=10.9→F). Good trend entries at high exh: Nov 21 (10.3→A), Dec 23 (10.3→A).
  // But those had strength >= 52. Keep 9.0 for safety.
  trendMaxExhaustion: 9.0,

  shouldAllowEntry: nvdaShouldAllowEntry,
  adjustConfidence: nvdaAdjustConfidence,
  simulate: simulateOrderAgentNvda,
};
