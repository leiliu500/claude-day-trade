/**
 * order-agent-sim-dia.ts — DIA-specific order simulation.
 *
 * Cloned from order-agent-sim-spy.ts on 2026-04-25 as the DIA tuning baseline.
 * DIA (~$425) trades roughly 0.65x SPY's underlying price; ATM 0DTE/1DTE option
 * premium scales similarly. Premium floor multiplier set to 4x (between SPY's
 * 5x and the shared 3x) to reflect DIA's lower absolute price + slightly lower
 * option liquidity vs SPY. Recalibrate from live fills once available.
 */
import {
  type OHLCVBar, type SignalDirection, type SimResult, type SimConfig,
  type PremiumTracePoint,
  toPremiumDynamic, pnlPct, trailFactor, profitFloor, estimateEntryPremium,
} from './order-agent-sim.js';

const DIA_PREMIUM_FLOOR_MULT = 4;
const DIA_DEFAULT_GAMMA = 0.008;
const DIA_DEFAULT_THETA_PER_MIN_PCT = 0.001;

export function simulateOrderAgentDia(
  entryPrice: number,
  direction: SignalDirection,
  atr: number,
  futureBars: OHLCVBar[],
  cfg: SimConfig = {},
): SimResult {
  const entryDelta = cfg.delta ?? 0.40;
  const stopMult = cfg.stopMult ?? 1.0;
  const tpMult = cfg.tpMult ?? 1.6;
  const gamma = cfg.gamma ?? DIA_DEFAULT_GAMMA;
  const trace = cfg.trace ?? false;

  const { entryPremium, recentVolatility, optionAtr } = estimateEntryPremium(
    atr, entryDelta, cfg.recentBars, DIA_PREMIUM_FLOOR_MULT,
  );

  const thetaPerMin = cfg.theta ?? (entryPremium * DIA_DEFAULT_THETA_PER_MIN_PCT);

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
    if (trace && premiumTrace.length > 0) {
      const last = premiumTrace[premiumTrace.length - 1]!;
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

    const { premium: currentPremium, currentDelta: newDelta } = toPremiumDynamic(
      entryPrice, entryPremium, bar.close, direction, entryDelta, gamma, i + 1, thetaPerMin,
    );
    currentDelta = newDelta;
    const currentPnl = pnlPct(currentPremium, entryPremium);

    const bestUnderlyingPrice = direction === 'bullish' ? bar.high : bar.low;
    const worstUnderlyingPrice = direction === 'bullish' ? bar.low : bar.high;
    const { premium: bestPremium } = toPremiumDynamic(
      entryPrice, entryPremium, bestUnderlyingPrice, direction, entryDelta, gamma, i + 1, thetaPerMin,
    );
    const { premium: worstPremium } = toPremiumDynamic(
      entryPrice, entryPremium, worstUnderlyingPrice, direction, entryDelta, gamma, i + 1, thetaPerMin,
    );

    if (trace) {
      premiumTrace.push({
        minute: i + 1, time: bar.timestamp,
        underlying: bar.close, premium: currentPremium,
        pnlPct: currentPnl, delta: currentDelta, stop: currentStop,
      });
    }

    if (i < 3 && peakPnlPct_ < 3) {
      const checkPrice = i === 0 ? currentPremium : worstPremium;
      if (checkPrice <= currentStop) {
        maxDrawdownPct_ = Math.max(maxDrawdownPct_, ((highestPrice - Math.min(worstPremium, currentPremium)) / highestPrice) * 100);
        return mkResult(i, 'STOP', currentStop);
      }
    }

    if (currentPremium < prevPremium) {
      consecutiveDeclines++;
    } else {
      consecutiveDeclines = 0;
    }
    prevPremium = currentPremium;

    if (currentPremium > highestPrice) highestPrice = currentPremium;
    if (currentPnl > peakPnlPct_) peakPnlPct_ = currentPnl;

    const drawdown = ((highestPrice - currentPremium) / highestPrice) * 100;
    if (drawdown > maxDrawdownPct_) maxDrawdownPct_ = drawdown;

    if (bestPremium >= tpTarget) {
      return mkResult(i, 'TP', tpTarget);
    }

    if (consecutiveDeclines >= 9 && currentPnl <= -6) {
      return mkResult(i, 'RAPID_DECLINE', currentPremium);
    }

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

    if (peakPnlPct_ >= 2 && peakPnlPct_ < 3 && currentPnl <= 0.5 && i >= 3) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }
    if (peakPnlPct_ >= 1 && peakPnlPct_ < 2 && currentPnl <= 0.3 && i >= 3) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }

    if (peakPnlPct_ >= 1 && peakPnlPct_ < 3 && currentPnl <= 0 && i >= 3) {
      return mkResult(i, 'PROFIT_REVERSAL', currentPremium);
    }

    if (currentPnl <= -10 && i >= 9) {
      return mkResult(i, 'PRE_EMPTIVE', currentPremium);
    }

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

    const tf = trailFactor(peakPnlPct_);
    const rawTrailingStop = highestPrice * tf;
    const pf = profitFloor(peakPnlPct_, entryPremium);
    const trailingStop = Math.max(rawTrailingStop, pf);
    if (trailingStop > currentStop && (i >= 4 || peakPnlPct_ >= 5)) {
      currentStop = trailingStop;
    }

    if (currentPremium <= currentStop) {
      return mkResult(i, 'STOP', currentStop);
    }
  }

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
