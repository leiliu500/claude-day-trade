/**
 * AAPL backtest configuration — parameters + custom code hooks.
 *
 * Initial config — no backtest tuning yet.
 * Starting with conservative defaults based on NVDA pattern (single stock).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentAapl } from '../../lib/order-agent-sim-aapl.js';

function aaplShouldAllowEntry(ctx: EntryContext): true | string {
  const { signalMode, breakdown: cb } = ctx;

  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.06) return `atrPct ${atrPct.toFixed(3)}% < 0.06%`;

  // Baseline run — minimal filters to see grade distribution
  if (signalMode === 'breakout') {
    if (cb.structureBonus <= 0) return `breakout structureBonus ${cb.structureBonus.toFixed(3)} <= 0`;
  }

  return true;
}

function aaplAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const AAPL_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  minAtrPct: 0.06,
  maxDailyEntries: 4,
  breakoutMaxExhaustion: 10.0,
  breakoutMaxChop: 1.15,
  breakoutMinStrength: 35,
  breakoutStrictTrendPhase: true,
  breakoutMinConfidence: 0,
  breakoutStopMult: 0.7,
  breakoutTpMult: 1.8,
  trendMaxExhaustion: 999,
  trendExhaustedRevertMinExh: 7.0,
  trendStrongSignalMinConf: 0.75,

  shouldAllowEntry: aaplShouldAllowEntry,
  adjustConfidence: aaplAdjustConfidence,
  simulate: simulateOrderAgentAapl,
};
