/**
 * order-agent-sim-tsla.ts — TSLA-specific order simulation.
 *
 * TSLA weekly options have very high premiums due to elevated IV. Uses
 * 4x premium floor (vs 3x default) — TSLA ATM weeklies are routinely $5-15
 * even on Friday, reflecting persistent IV elevation. Cloned from NVDA pattern
 * (single-stock high-vol).
 */

import {
  type OHLCVBar, type SignalDirection, type SimResult, type SimConfig,
  toPremium, pnlPct, trailFactor, profitFloor, estimateEntryPremium,
} from './order-agent-sim.js';

const TSLA_PREMIUM_FLOOR_MULT = 4;

export function simulateOrderAgentTsla(
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
    atr, delta, cfg.recentBars, TSLA_PREMIUM_FLOOR_MULT,
  );

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

    const bestUnderlying = direction === 'bullish' ? bar.high - entryPrice : entryPrice - bar.low;
    const worstUnderlying = direction === 'bullish' ? bar.low - entryPrice : entryPrice - bar.high;
    const bestPremium = entryPremium + bestUnderlying * delta;
    const worstPremium = entryPremium + worstUnderlying * delta;

    if (i < 3 && peakPnlPct_ < 3) {
      const checkPrice = i === 0 ? currentPremium : worstPremium;
      if (checkPrice <= currentStop) {
        maxDrawdownPct_ = Math.max(maxDrawdownPct_, ((highestPrice - Math.min(worstPremium, currentPremium)) / highestPrice) * 100);
        return mkResult(i, 'STOP', currentStop);
      }
    }

    if (currentPremium < prevPremium) consecutiveDeclines++;
    else consecutiveDeclines = 0;
    prevPremium = currentPremium;

    if (currentPremium > highestPrice) highestPrice = currentPremium;
    if (currentPnl > peakPnlPct_) peakPnlPct_ = currentPnl;

    const drawdown = ((highestPrice - currentPremium) / highestPrice) * 100;
    if (drawdown > maxDrawdownPct_) maxDrawdownPct_ = drawdown;

    if (bestPremium >= tpTarget) return mkResult(i, 'TP', tpTarget);
    if (consecutiveDeclines >= 9 && currentPnl <= -6) return mkResult(i, 'RAPID_DECLINE', currentPremium);

    const timeBonus = i >= 10 ? Math.min((i - 10) * 1, 10) : 0;
    if (peakPnlPct_ >= 15) {
      const retain = Math.min(0.65 + timeBonus / 100, 0.85);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) return mkResult(i, 'TRAILING_DECAY', currentPremium);
    } else if (peakPnlPct_ >= 10) {
      const retain = Math.min(0.60 + timeBonus / 100, 0.80);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) return mkResult(i, 'TRAILING_DECAY', currentPremium);
    } else if (peakPnlPct_ >= 5) {
      const retain = Math.min(0.60 + timeBonus / 100, 0.80);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) return mkResult(i, 'TRAILING_DECAY', currentPremium);
    } else if (peakPnlPct_ >= 3) {
      if (currentPnl <= peakPnlPct_ * 0.55 && currentPnl < peakPnlPct_ && i >= 2) return mkResult(i, 'TRAILING_DECAY', currentPremium);
    }

    if (peakPnlPct_ >= 2 && peakPnlPct_ < 3 && currentPnl <= 0.5 && i >= 3) return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    if (peakPnlPct_ >= 1 && peakPnlPct_ < 2 && currentPnl <= 0.3 && i >= 3) return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    if (peakPnlPct_ >= 1 && peakPnlPct_ < 3 && currentPnl <= 0 && i >= 3) return mkResult(i, 'PROFIT_REVERSAL', currentPremium);
    if (currentPnl <= -10 && i >= 9) return mkResult(i, 'PRE_EMPTIVE', currentPremium);
    if (peakPnlPct_ < 0.3 && currentPnl <= -3 && i >= 3 && i <= 8) return mkResult(i, 'BAD_ENTRY', currentPremium);
    if (peakPnlPct_ < 0.5 && currentPnl <= -5 && consecutiveDeclines >= 3 && i >= 3) return mkResult(i, 'BAD_ENTRY', currentPremium);
    if (peakPnlPct_ < 1 && currentPnl <= -3 && i >= 5) return mkResult(i, 'BAD_ENTRY', currentPremium);
    if (peakPnlPct_ < 1 && currentPnl <= -5 && i >= 4) return mkResult(i, 'BAD_ENTRY', currentPremium);

    const tf = trailFactor(peakPnlPct_);
    const rawTrailingStop = highestPrice * tf;
    const pf = profitFloor(peakPnlPct_, entryPremium);
    const trailingStop = Math.max(rawTrailingStop, pf);
    if (trailingStop > currentStop && (i >= 4 || peakPnlPct_ >= 5)) currentStop = trailingStop;
    if (currentPremium <= currentStop) return mkResult(i, 'STOP', currentStop);
  }

  const lastBar = futureBars[futureBars.length - 1];
  if (!lastBar) return { exitPrice: entryPrice, exitReason: 'CLOSE', holdMinutes: 0, pnlPct: 0, peakPnlPct: 0, maxDrawdownPct: 0 };
  const finalPremium = toPremium(entryPrice, entryPremium, lastBar.close, direction, delta);
  const finalPnl = pnlPct(finalPremium, entryPremium);
  return { exitPrice: lastBar.close, exitReason: 'CLOSE', holdMinutes: futureBars.length, pnlPct: finalPnl, peakPnlPct: peakPnlPct_, maxDrawdownPct: maxDrawdownPct_ };
}
