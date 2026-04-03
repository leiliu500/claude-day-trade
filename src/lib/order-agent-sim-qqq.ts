/**
 * order-agent-sim-qqq.ts — QQQ-specific order simulation.
 *
 * Calibrated from live market data (2026-03-24):
 *   QQQ ATM 1DTE call: mid=$4.07, delta=0.49, bid-ask spread=$0.18 (4.4%)
 *   QQQ ATM 1DTE put:  mid=$5.71, delta=-0.51, bid-ask spread=$0.06 (1.1%)
 *   QQQ 5m ATR: $6.64, optionAtr (delta=0.5): $3.32
 *   Premium / optionAtr = 1.2x (vs SPY's 5.0x)
 *
 * No live QQQ trades exist yet for fill-level calibration. Tuned from market
 * structure observations:
 *
 *   1. Lower premium floor (2x vs shared 3x): QQQ options are cheap relative
 *      to underlying moves. ATM premiums run ~1.2-1.5x optionAtr, but the sim
 *      needs a floor above 1x to avoid division-by-zero-like instability.
 *      2x gives premiums in the $1.3-3.0 range, which better reflects the
 *      tighter premium/ATR relationship than the shared 3x.
 *
 *   2. Trailing stop floor (entry*0.87): matches live option-agent behavior.
 *      Same as SPY — this is a structural feature of the order-agent, not
 *      ticker-specific.
 *
 *   3. No bar-0 early exit: QQQ options have wider bid-ask spreads (4-5% on
 *      calls vs SPY's ~1-2%). The live system can't scalp $0.01 from the spread
 *      the way it can on SPY. Sub-minute exits on QQQ would typically be at a
 *      loss (crossing the spread), not a gain.
 */

import {
  type OHLCVBar, type SignalDirection, type SimResult, type SimConfig,
  toPremium, pnlPct, trailFactor, profitFloor, estimateEntryPremium,
} from './order-agent-sim.js';

// QQQ premium floor multiplier: 6x optionAtr.
// QQQ ATM 1DTE options cost $4-6 (calls ~$4.07, puts ~$5.71 on 2026-03-24).
// With optionAtr ~$0.75, 6x gives ~$4.50, matching real market premiums.
// Old 2x produced ~$1.50 premiums → unrealistic 50% losses on normal noise.
const QQQ_PREMIUM_FLOOR_MULT = 6;

export function simulateOrderAgentQqq(
  entryPrice: number,
  direction: SignalDirection,
  atr: number,
  futureBars: OHLCVBar[],
  cfg: SimConfig = {},
): SimResult {
  const delta = cfg.delta ?? 0.50;
  const stopMult = cfg.stopMult ?? 1.0;
  const tpMult = cfg.tpMult ?? 1.6;

  const { entryPremium, recentVolatility, optionAtr } = estimateEntryPremium(
    atr, delta, cfg.recentBars, QQQ_PREMIUM_FLOOR_MULT,
  );

  // Initial stop: ATR-based, with trailing stop floor (matches live option-agent)
  const atrStop = entryPremium - stopMult * recentVolatility;
  const trailingFloor = entryPremium * 0.87;
  let currentStop = Math.max(0.01, Math.min(atrStop, trailingFloor));
  const tpTarget = entryPremium + tpMult * optionAtr;

  let highestPrice = entryPremium;
  let peakPnlPct_ = 0;
  let maxDrawdownPct_ = 0;
  let consecutiveDeclines = 0;
  let prevPremium = entryPremium;

  const mkResult = (i: number, reason: string, exitPremium: number): SimResult => {
    const ep = exitPremium;
    const exitPnl = pnlPct(ep, entryPremium);
    return {
      exitPrice: direction === 'bullish'
        ? entryPrice + (ep - entryPremium) / delta
        : entryPrice - (ep - entryPremium) / delta,
      exitReason: reason,
      holdMinutes: i + 1,
      pnlPct: exitPnl,
      peakPnlPct: Math.max(peakPnlPct_, exitPnl),
      maxDrawdownPct: maxDrawdownPct_,
    };
  };

  for (let i = 0; i < futureBars.length; i++) {
    const bar = futureBars[i]!;
    const currentPremium = toPremium(entryPrice, entryPremium, bar.close, direction, delta);
    const currentPnl = pnlPct(currentPremium, entryPremium);

    // Intra-bar extremes for initial stop and TP checks
    const bestUnderlying = direction === 'bullish' ? bar.high - entryPrice : entryPrice - bar.low;
    const worstUnderlying = direction === 'bullish' ? bar.low - entryPrice : entryPrice - bar.high;
    const bestPremium = entryPremium + bestUnderlying * delta;
    const worstPremium = entryPremium + worstUnderlying * delta;

    // ── Bar-0 early exit on adverse close (matches SPY sim) ──
    // Live order-agent polls every 5s. If bar 0 closes adverse beyond -3%,
    // exit at 35% of the close loss (models mid-bar detection).
    if (i === 0 && currentPnl < -3.0) {
      const earlyExitPremium = entryPremium + (currentPremium - entryPremium) * 0.35;
      return mkResult(0, 'EARLY_EXIT', earlyExitPremium);
    }

    // ── Rule 1: Initial hard stop (first 3 bars) ──
    if (i < 3 && peakPnlPct_ < 3) {
      const checkPrice = i === 0 ? currentPremium : worstPremium;
      if (checkPrice <= currentStop) {
        maxDrawdownPct_ = Math.max(maxDrawdownPct_, ((highestPrice - Math.min(worstPremium, currentPremium)) / highestPrice) * 100);
        return mkResult(i, 'STOP', currentStop);
      }
    }

    // Track consecutive declines
    if (currentPremium < prevPremium) {
      consecutiveDeclines++;
    } else {
      consecutiveDeclines = 0;
    }
    prevPremium = currentPremium;

    // Update peak tracking
    if (currentPremium > highestPrice) highestPrice = currentPremium;
    if (currentPnl > peakPnlPct_) peakPnlPct_ = currentPnl;

    // Track drawdown from peak
    const drawdown = ((highestPrice - currentPremium) / highestPrice) * 100;
    if (drawdown > maxDrawdownPct_) maxDrawdownPct_ = drawdown;

    // ── Rule 2: Take-profit hit (intra-bar best) ──
    if (bestPremium >= tpTarget) {
      return mkResult(i, 'TP', tpTarget);
    }

    // ── Rule 9: Rapid decline (9 consecutive declines + ≤ -6%) ──
    if (consecutiveDeclines >= 9 && currentPnl <= -6) {
      return mkResult(i, 'RAPID_DECLINE', currentPremium);
    }

    // ── PROFIT PROTECTION ──

    // ── Rule 10: Dynamic trailing with time-decay bonus (after 10 min) ──
    const timeBonus = i >= 10 ? Math.min((i - 10) * 1, 10) : 0;

    if (peakPnlPct_ >= 15) {
      const retain = Math.min(0.65 + timeBonus / 100, 0.85);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) {
        return mkResult(i, 'TRAILING_DECAY', currentPremium);
      }
    } else if (peakPnlPct_ >= 10) {
      const retain = Math.min(0.60 + timeBonus / 100, 0.80);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) {
        return mkResult(i, 'TRAILING_DECAY', currentPremium);
      }
    } else if (peakPnlPct_ >= 5) {
      const retain = Math.min(0.60 + timeBonus / 100, 0.80);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) {
        return mkResult(i, 'TRAILING_DECAY', currentPremium);
      }
    } else if (peakPnlPct_ >= 3) {
      if (currentPnl <= peakPnlPct_ * 0.55 && currentPnl < peakPnlPct_ && i >= 2) {
        return mkResult(i, 'TRAILING_DECAY', currentPremium);
      }
    }

    // ── Rule 7: Small-gain locks ──
    if (peakPnlPct_ >= 2 && peakPnlPct_ < 3 && currentPnl <= 0.5 && i >= 3) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }
    if (peakPnlPct_ >= 1 && peakPnlPct_ < 2 && currentPnl <= 0.3 && i >= 3) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }

    // ── LOSS DETECTION ──

    // ── Rule 5: Profit reversal (peak ≥ 1%, current ≤ 0%) ──
    if (peakPnlPct_ >= 1 && peakPnlPct_ < 3 && currentPnl <= 0 && i >= 3) {
      return mkResult(i, 'PROFIT_REVERSAL', currentPremium);
    }

    // ── Rule 6: Pre-emptive loss (-10% after 9+ bars) ──
    if (currentPnl <= -10 && i >= 9) {
      return mkResult(i, 'PRE_EMPTIVE', currentPremium);
    }

    // ── Rule 8: Bad entry fast-cuts ──
    if (peakPnlPct_ < 0.3 && currentPnl <= -3 && i >= 3 && i <= 8) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }
    if (peakPnlPct_ < 0.5 && currentPnl <= -5 && consecutiveDeclines >= 3 && i >= 3) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }
    if (peakPnlPct_ < 1 && currentPnl <= -3 && i >= 5) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }
    if (peakPnlPct_ < 1 && currentPnl <= -5 && i >= 4) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }

    // ── Rules 3 & 4: Trailing stop + profit floors ──
    const tf = trailFactor(peakPnlPct_);
    const rawTrailingStop = highestPrice * tf;
    const pf = profitFloor(peakPnlPct_, entryPremium);
    const trailingStop = Math.max(rawTrailingStop, pf);
    if (trailingStop > currentStop && (i >= 4 || peakPnlPct_ >= 5)) {
      currentStop = trailingStop;
    }

    // Trailing stop hit (close price)
    if (currentPremium <= currentStop) {
      return mkResult(i, 'STOP', currentStop);
    }
  }

  // Market close — exit at last bar close
  const lastBar = futureBars[futureBars.length - 1];
  if (!lastBar) {
    return { exitPrice: entryPrice, exitReason: 'CLOSE', holdMinutes: 0, pnlPct: 0, peakPnlPct: 0, maxDrawdownPct: 0 };
  }
  const finalPremium = toPremium(entryPrice, entryPremium, lastBar.close, direction, delta);
  const finalPnl = pnlPct(finalPremium, entryPremium);
  return {
    exitPrice: lastBar.close,
    exitReason: 'CLOSE',
    holdMinutes: futureBars.length,
    pnlPct: finalPnl,
    peakPnlPct: peakPnlPct_,
    maxDrawdownPct: maxDrawdownPct_,
  };
}
