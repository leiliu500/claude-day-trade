/**
 * TSLA backtest configuration — minimal initial setup.
 *
 * Initial config 2026-04-27: NOT a SPY/IWM/DIA clone. TSLA filters will be
 * built from data via mining the 15-mo F-cluster distribution. This file
 * starts with only the essential per-ticker baseline:
 *   - minConfidence 0.65 (system standard)
 *   - minAtrPct 0.20 (TSLA dead-zone floor — well below typical 1-3% intraday)
 *   - sim: simulateOrderAgentTsla
 *
 * The shouldAllowEntry hook is delegated to strategies/tsla.ts (single source
 * of truth — same pattern as IWM/DIA where strategy.ts owns the filter list).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentTsla } from '../../lib/order-agent-sim-tsla.js';

function tslaShouldAllowEntry(ctx: EntryContext): true | string {
  const atrPct = ctx.currentPrice > 0 ? (ctx.atr / ctx.currentPrice) * 100 : 0;
  if (atrPct < 0.20) return `atrPct ${atrPct.toFixed(3)}% < 0.20% (dead zone)`;
  return true;
}

function tslaAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const TSLA_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  minAtrPct: 0.20,
  dailyRiskBudgetPct: 0.05,
  // TSLA-appropriate breakout/trend params — start with NVDA-style (single stock,
  // high-vol baseline). Will tune from F-cluster mining.
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

  shouldAllowEntry: tslaShouldAllowEntry,
  adjustConfidence: tslaAdjustConfidence,
  simulate: simulateOrderAgentTsla,
};
