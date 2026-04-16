/**
 * order-agent-sim-spy.ts — SPY-specific order simulation with dynamic delta.
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
 *   3. Dynamic delta simulation: delta shifts with underlying move via gamma.
 *      Entry delta configurable (0.30–0.50), gamma models delta acceleration.
 *      Theta decay erodes premium over hold time.
 */

import {
  type OHLCVBar, type SignalDirection, type SimResult, type SimConfig,
  type PremiumTracePoint,
  toPremiumDynamic, pnlPct, trailFactor, profitFloor, estimateEntryPremium,
} from './order-agent-sim.js';

// SPY premium floor multiplier: 5x optionAtr.
// Calibrated: ATR=$1.24, delta=0.5 → optionAtr=$0.62 → 5x=$3.10 ≈ live fill $3.08.
const SPY_PREMIUM_FLOOR_MULT = 5;

// Default gamma for SPY 0DTE/1DTE options (~0.008 delta per $1 move)
const SPY_DEFAULT_GAMMA = 0.008;

// Default theta: ~0.10% of premium per minute for 0DTE SPY options
// (roughly $3 option loses ~$0.003/min = ~$0.18/hour during trading hours)
const SPY_DEFAULT_THETA_PER_MIN_PCT = 0.001;

export function simulateOrderAgentSpy(
  entryPrice: number,
  direction: SignalDirection,
  atr: number,
  futureBars: OHLCVBar[],
  cfg: SimConfig = {},
): SimResult {
  const entryDelta = cfg.delta ?? 0.40;  // default OTM delta for SPY
  const stopMult = cfg.stopMult ?? 1.0;
  const tpMult = cfg.tpMult ?? 1.6;
  const gamma = cfg.gamma ?? SPY_DEFAULT_GAMMA;
  const trace = cfg.trace ?? false;

  const { entryPremium, recentVolatility, optionAtr } = estimateEntryPremium(
    atr, entryDelta, cfg.recentBars, SPY_PREMIUM_FLOOR_MULT,
  );

  // Theta: absolute $ per minute decay
  const thetaPerMin = cfg.theta ?? (entryPremium * SPY_DEFAULT_THETA_PER_MIN_PCT);

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
  let currentDelta = entryDelta;

  // Premium trace for visualization
  const premiumTrace: PremiumTracePoint[] = [];
  if (trace && futureBars.length > 0) {
    premiumTrace.push({
      minute: 0, time: futureBars[0]!.timestamp,
      underlying: entryPrice, premium: entryPremium,
      pnlPct: 0, delta: entryDelta, stop: currentStop, isEntry: true,
    });
  }

  const mkResult = (i: number, reason: string, exitPremium: number): SimResult => {
    const ep = exitPremium;
    const exitPnl = pnlPct(ep, entryPremium);
    // Mark exit on trace
    if (trace && premiumTrace.length > 0) {
      const last = premiumTrace[premiumTrace.length - 1]!;
      // If exit bar matches last trace bar, mark it; otherwise add exit point
      if (last.minute === i + 1 || last.minute === i) {
        last.isExit = true;
        last.premium = ep;
        last.pnlPct = exitPnl;
      } else {
        premiumTrace.push({
          minute: i + 1,
          time: i < futureBars.length ? futureBars[i]!.timestamp : last.time,
          underlying: i < futureBars.length ? futureBars[i]!.close : last.underlying,
          premium: ep, pnlPct: exitPnl, delta: currentDelta,
          stop: currentStop, isExit: true,
        });
      }
    }
    return {
      exitPrice: direction === 'bullish'
        ? entryPrice + (ep - entryPremium) / entryDelta
        : entryPrice - (ep - entryPremium) / entryDelta,
      exitReason: reason,
      holdMinutes: i + 1,
      pnlPct: exitPnl,
      peakPnlPct: Math.max(peakPnlPct_, exitPnl),
      maxDrawdownPct: maxDrawdownPct_,
      entryDelta,
      entryPremium,
      exitPremium: ep,
      tpPremium: tpTarget,
      stopPremium: currentStop,
      premiumTrace: trace ? premiumTrace : undefined,
    };
  };

  for (let i = 0; i < futureBars.length; i++) {
    const bar = futureBars[i]!;

    // Dynamic delta premium calculation
    const { premium: currentPremium, currentDelta: newDelta } = toPremiumDynamic(
      entryPrice, entryPremium, bar.close, direction, entryDelta, gamma, i + 1, thetaPerMin,
    );
    currentDelta = newDelta;
    const currentPnl = pnlPct(currentPremium, entryPremium);

    // Intra-bar extremes using dynamic delta
    const bestUnderlyingPrice = direction === 'bullish' ? bar.high : bar.low;
    const worstUnderlyingPrice = direction === 'bullish' ? bar.low : bar.high;
    const { premium: bestPremium } = toPremiumDynamic(
      entryPrice, entryPremium, bestUnderlyingPrice, direction, entryDelta, gamma, i + 1, thetaPerMin,
    );
    const { premium: worstPremium } = toPremiumDynamic(
      entryPrice, entryPremium, worstUnderlyingPrice, direction, entryDelta, gamma, i + 1, thetaPerMin,
    );

    // Record trace point
    if (trace) {
      premiumTrace.push({
        minute: i + 1, time: bar.timestamp,
        underlying: bar.close, premium: currentPremium,
        pnlPct: currentPnl, delta: currentDelta, stop: currentStop,
      });
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
  const { premium: finalPremium } = toPremiumDynamic(
    entryPrice, entryPremium, lastBar.close, direction, entryDelta, gamma, futureBars.length, thetaPerMin,
  );
  const finalPnl = pnlPct(finalPremium, entryPremium);
  return {
    exitPrice: lastBar.close,
    exitReason: 'CLOSE',
    holdMinutes: futureBars.length,
    pnlPct: finalPnl,
    peakPnlPct: peakPnlPct_,
    maxDrawdownPct: maxDrawdownPct_,
    entryDelta,
    entryPremium,
    exitPremium: finalPremium,
    tpPremium: tpTarget,
    stopPremium: currentStop,
    premiumTrace: trace ? premiumTrace : undefined,
  };
}
