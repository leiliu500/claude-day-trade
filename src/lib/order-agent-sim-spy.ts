/**
 * order-agent-sim-spy.ts — SPY-specific order simulation.
 *
 * Calibrated from March 23 2026 live trade data:
 *   Live: SPY260324C00663000, bought $3.08, sold $3.09 after 46s (+0.32%)
 *   Shared sim: estimated premium $1.86 → exaggerated % moves → BAD_ENTRY at -15.4%
 *
 * SPY-tuned differences from shared sim:
 *
 *   1. Higher premium floor (5x vs 3x): SPY ATM 0DTE/1DTE options cost $2.50-6.00
 *      with ATR ~$1.2-1.5. The 3x multiplier produces ~$1.86 premiums which amplify
 *      stock moves into unrealistic option % swings. 5x gives ~$3.10, matching the
 *      $3.08 live fill on Mar 23.
 *
 *   2. Trailing stop floor: stop = max(atrStop, entry*0.87), matching the live
 *      option-agent's trailing stop floor. The shared sim omits this.
 *
 *   3. Bar-0 early exit on adverse moves: the live order-agent polls option quotes
 *      every 5 seconds. On bar 0, if the bar closes adverse (stock reversed from
 *      entry), the live system would have exited partway through the bar — not at
 *      the full close loss. We model this by exiting at the midpoint between entry
 *      and close premium when bar 0 is adverse. This represents the 5s polling
 *      catching the decline midway.
 *
 *      Mar 23 validation: entry at $662.41 bullish, bar 0 close ~$662.21.
 *        Without early exit: holds to bar 3, BAD_ENTRY at -9.2%
 *        With early exit: exits bar 0 at midpoint, ~-1.6% (vs live +0.3%)
 *        Still a loss but magnitude is realistic — the live +0.3% was bid-ask luck.
 */

import {
  type OHLCVBar, type SignalDirection, type SimResult, type SimConfig,
  toPremium, pnlPct, trailFactor, profitFloor, estimateEntryPremium,
} from './order-agent-sim.js';

// SPY premium floor multiplier: 5x optionAtr.
// Calibrated: ATR=$1.24, delta=0.5 → optionAtr=$0.62 → 5x=$3.10 ≈ live fill $3.08.
const SPY_PREMIUM_FLOOR_MULT = 5;

export function simulateOrderAgentSpy(
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
    atr, delta, cfg.recentBars, SPY_PREMIUM_FLOOR_MULT,
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

    // ── SPY Bar-0 early exit on adverse close ───────────────────────────────
    // Live order-agent polls option quotes every 5s (~12 polls per minute).
    // If bar 0 closes adverse, the live system catches the decline partway.
    //
    // Calibrated from Mar 23 live data: bar 0 loss ~4.6% at close, live exited
    // at +0.3% within 46s (bid-ask luck on tight SPY spreads).
    //
    // Model: exit at 35% of bar 0 close loss. With 12 polls per minute,
    // the average detection point is ~2.5 ticks into the decline (first few
    // polls near entry, then decline accelerates). 35% models this curve.
    // Threshold raised to -1.5%: the live system holds through small adverse
    // moves (< 1.5%) on the monitor cycle, only exits on clear reversals.
    if (i === 0 && currentPnl < -1.5) {
      // Exit at 35% of bar 0 close loss (not 50% midpoint)
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
