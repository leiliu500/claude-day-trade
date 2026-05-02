/**
 * IWM backtest configuration — built from scratch via IWM-specific F-mining.
 *
 * Built from scratch 2026-04-28 (NOT a SPY/DIA clone). All filters were
 * derived from 15-mo IWM F-cluster mining, factor orthogonality, time-of-day
 * analysis, and direction × mode breakdowns. See strategies/iwm.ts for the
 * full filter chain (single source of truth — backtest delegates to
 * LIVE_TICKER_CFG).
 */

import type { TickerBacktestConfig, EntryContext } from './types.js';
import type { ConfidenceBreakdown } from '../../types/analysis.js';
import { simulateOrderAgentIwm } from '../../lib/order-agent-sim-iwm.js';

function iwmShouldAllowEntry(ctx: EntryContext): true | string {
  // v1: mid-afternoon dead-zone 14:30-15:15 ET — see strategies/iwm.ts.
  if (ctx.minutesSinceOpen >= 300 && ctx.minutesSinceOpen < 345) {
    return `mid-afternoon dead-zone ${ctx.minutesSinceOpen}m (14:30-15:15 ET)`;
  }
  // v2: midday-deep 12:30-13:30 ET — see strategies/iwm.ts.
  if (ctx.minutesSinceOpen >= 180 && ctx.minutesSinceOpen < 225) {
    return `midday-deep ${ctx.minutesSinceOpen}m (12:30-13:30 ET)`;
  }
  // v3: late-morning chop 11:15-11:30 ET — see strategies/iwm.ts.
  if (ctx.minutesSinceOpen >= 105 && ctx.minutesSinceOpen < 120) {
    return `late-morning chop ${ctx.minutesSinceOpen}m (11:15-11:30 ET)`;
  }
  // v4: bullish-trend low-atr — see strategies/iwm.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend' && ctx.atr < 0.40) {
    return `bullish-trend low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }
  // v5: bearish-trend low-atr — see strategies/iwm.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend' && ctx.atr < 0.40) {
    return `bearish-trend low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }
  // v6+v8: bullish-breakout low-atr <0.45 — see strategies/iwm.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'breakout' && ctx.atr < 0.45) {
    return `bullish-breakout low atr ${ctx.atr.toFixed(2)} < 0.45`;
  }
  // v10: bearish + cpb [0.06, 0.07) — see strategies/iwm.ts.
  if (ctx.direction === 'bearish'
      && ctx.breakdown.candlePatternBonus >= 0.06
      && ctx.breakdown.candlePatternBonus < 0.07) {
    return `bearish cpb ${ctx.breakdown.candlePatternBonus.toFixed(3)} in [0.06, 0.07)`;
  }

  // v9: bullish-trend open-30m carve-out — see strategies/iwm.ts.
  if (ctx.direction === 'bullish' && ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen >= 30 && ctx.minutesSinceOpen < 45
      && !(ctx.atr >= 0.60 && ctx.atr < 0.80)) {
    return `bullish-trend open-30m atr ${ctx.atr.toFixed(2)}`;
  }

  // v7: bearish-breakout low-atr — see strategies/iwm.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout' && ctx.atr < 0.40) {
    return `bearish-breakout low atr ${ctx.atr.toFixed(2)} < 0.40`;
  }
  // v11: bearish-trend anti-predictive conf [0.82, 0.86) — see strategies/iwm.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.confidence >= 0.82 && ctx.confidence < 0.86) {
    return `bearish-trend conf ${ctx.confidence.toFixed(2)} in [0.82, 0.86)`;
  }

  // v12: trend-mode 225-240m direction-asymmetric atr carve-outs — see strategies/iwm.ts.
  if (ctx.signalMode === 'trend'
      && ctx.minutesSinceOpen >= 225 && ctx.minutesSinceOpen < 240) {
    if (ctx.direction === 'bearish' && ctx.atr < 0.60) {
      return `bearish-trend 13:15-13:30 atr ${ctx.atr.toFixed(2)} < 0.60`;
    }
    if (ctx.direction === 'bullish' && ctx.atr >= 0.75 && ctx.atr < 1.00) {
      return `bullish-trend 13:15-13:30 atr ${ctx.atr.toFixed(2)} in [0.75, 1.00)`;
    }
  }

  // v13: bearish-breakout time-of-day F-pockets (10:15-10:30 + 12:15-12:30 ET) — see strategies/iwm.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'breakout') {
    if (ctx.minutesSinceOpen >= 45 && ctx.minutesSinceOpen < 60 && ctx.atr < 0.60) {
      return `bearish-breakout 10:15-10:30 atr ${ctx.atr.toFixed(2)} < 0.60`;
    }
    if (ctx.minutesSinceOpen >= 165 && ctx.minutesSinceOpen < 180) {
      return `bearish-breakout 12:15-12:30 ${ctx.minutesSinceOpen}m`;
    }
  }

  // v14: bearish-trend strength>=80 atr [0.55, 0.85) — see strategies/iwm.ts.
  if (ctx.direction === 'bearish' && ctx.signalMode === 'trend'
      && ctx.strengthScore >= 80 && ctx.atr >= 0.55 && ctx.atr < 0.85) {
    return `bearish-trend strength ${ctx.strengthScore} atr ${ctx.atr.toFixed(2)} in [0.55, 0.85)`;
  }
  return true;
}

function iwmAdjustConfidence(cb: ConfidenceBreakdown, _ctx: EntryContext): ConfidenceBreakdown {
  return cb;
}

export const IWM_CONFIG: Partial<TickerBacktestConfig> = {
  minConfidence: 0.65,
  dailyRiskBudgetPct: 0.05,

  // Entry window: block first 30 min after open + last 30 min before close.
  // Same convention as SPY/QQQ/DIA/TSLA.
  entryWindowStartMin: 30,
  entryWindowEndMin: 360,

  shouldAllowEntry: iwmShouldAllowEntry,
  adjustConfidence: iwmAdjustConfidence,
  simulate: simulateOrderAgentIwm,
};
