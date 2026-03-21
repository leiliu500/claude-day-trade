/**
 * order-agent-sim.ts — Simulates the order-agent's deterministic exit rules on
 * historical 1-minute bars.  Mirrors every profit-protection and loss-minimization
 * rule from the real order-agent so backtests reflect realistic trade outcomes.
 *
 * Rules replicated from src/agents/order-agent.ts:
 *   1. Initial hard stop (ATR-based or 13% trailing floor)
 *   2. Take-profit target
 *   3. Adaptive trailing stop (87% / 90% / 92% by peak tier)
 *   4. Profit-protection floors (7 tiers: 3% → 40% peak)
 *   5. Profit reversal exit (peak ≥ 1%, current ≤ 0%)
 *   6. Pre-emptive loss exit (-10% after 9+ bars)
 *   7. Small-gain locks (peak 1-5%, fading near 0)
 *   8. Bad entry fast-cuts (never confirmed, immediate adverse, early bleed)
 *   9. Rapid decline (9 consecutive declines + ≤ -6%)
 *  10. Dynamic trailing with time-decay bonus (after 10 min)
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OHLCVBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface SimResult {
  exitPrice: number;       // underlying price at exit
  exitReason: string;      // STOP | TP | PROFIT_REVERSAL | PRE_EMPTIVE | SMALL_GAIN_LOCK | BAD_ENTRY | RAPID_DECLINE | TRAILING_DECAY | CLOSE
  holdMinutes: number;     // how long the position was held
  pnlPct: number;          // simulated P&L % on the option premium
  peakPnlPct: number;      // highest P&L % reached before exit
  maxDrawdownPct: number;  // worst drawdown from peak before exit
}

export interface SimConfig {
  stopMult?: number;    // default 1.0
  tpMult?: number;      // default 1.6
  delta?: number;       // option delta, default 0.50
  recentBars?: OHLCVBar[];  // recent 1m bars before entry for volatility measurement
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Convert underlying bar close to option premium given entry state. */
function toPremium(
  entryPrice: number, entryPremium: number, barClose: number,
  direction: SignalDirection, delta: number,
): number {
  const move = direction === 'bullish' ? barClose - entryPrice : entryPrice - barClose;
  return entryPremium + move * delta;
}

function pnlPct(current: number, entry: number): number {
  return ((current - entry) / entry) * 100;
}

// ── Trailing stop tiers ────────────────────────────────────────────────────────

export function trailFactor(peakPnl: number): number {
  if (peakPnl >= 40) return 0.92;
  if (peakPnl >= 25) return 0.90;
  return 0.87;
}

export function profitFloor(peakPnl: number, entryPremium: number): number {
  if (peakPnl >= 40) return entryPremium * 1.25;
  if (peakPnl >= 30) return entryPremium * 1.18;
  if (peakPnl >= 20) return entryPremium * 1.08;
  if (peakPnl >= 15) return entryPremium * 1.03;
  if (peakPnl >= 10) return entryPremium * 1.0;
  if (peakPnl >= 5)  return entryPremium * 1.015;
  if (peakPnl >= 3)  return entryPremium * 0.995;
  return 0;
}

// ── Main simulation ────────────────────────────────────────────────────────────

export function simulateOrderAgent(
  entryPrice: number,
  direction: SignalDirection,
  atr: number,
  futureBars: OHLCVBar[],
  cfg: SimConfig = {},
): SimResult {
  const delta = cfg.delta ?? 0.50;
  const stopMult = cfg.stopMult ?? 1.0;
  const tpMult = cfg.tpMult ?? 1.6;

  // Convert underlying to option premium units (same as option-agent)
  const optionAtr = atr * delta;

  // Measure recent 1m volatility: use max bar range from last 10 bars.
  // This captures intra-minute spikes that the 5m ATR misses in choppy conditions.
  let recentVolatility = optionAtr;
  if (cfg.recentBars && cfg.recentBars.length >= 3) {
    const recent = cfg.recentBars.slice(-10);
    const maxRange = Math.max(...recent.map(b => (b.high - b.low) * delta));
    recentVolatility = Math.max(optionAtr, maxRange);
  }

  // Premium floor: at least 3x the larger of ATR or recent volatility
  const entryPremium = Math.max(recentVolatility * 3, optionAtr * 3, 1.0);

  // Initial stop: ATR-based, using the volatility-adjusted premium
  const atrStop = entryPremium - stopMult * recentVolatility;
  let currentStop = Math.max(0.01, atrStop);
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

    // ── Rule 1: Initial hard stop (first 3 bars) ──
    // Bar 0 (entry bar): use close only — intra-bar noise on entry is expected.
    // Bars 1-2: use intra-bar worst to catch genuine breakdowns.
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

    // Update peak tracking using close price
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

    // ── Rule 5: Profit reversal (peak ≥ 1%, current ≤ 0%) ──
    if (peakPnlPct_ >= 1 && currentPnl <= 0 && (i >= 3 || peakPnlPct_ >= 5)) {
      return mkResult(i, 'PROFIT_REVERSAL', currentPremium);
    }

    // ── Rule 6: Pre-emptive loss (-10% after 9+ bars) ──
    if (currentPnl <= -10 && i >= 9) {
      return mkResult(i, 'PRE_EMPTIVE', currentPremium);
    }

    // ── Rule 8: Bad entry fast-cuts ──
    // Never confirmed: peak < 0.3%, current ≤ -3%, bars 3-8
    if (peakPnlPct_ < 0.3 && currentPnl <= -3 && i >= 3 && i <= 8) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }
    // Immediate adverse: peak < 0.5%, current ≤ -5%, 3+ consecutive declines, 3+ bars
    if (peakPnlPct_ < 0.5 && currentPnl <= -5 && consecutiveDeclines >= 3 && i >= 3) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }
    // Bad entry cut: peak < 1%, current ≤ -3%, 5+ bars
    if (peakPnlPct_ < 1 && currentPnl <= -3 && i >= 5) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }
    // Early bleed: peak < 1%, current ≤ -5%, 4+ bars
    if (peakPnlPct_ < 1 && currentPnl <= -5 && i >= 4) {
      return mkResult(i, 'BAD_ENTRY', currentPremium);
    }

    // ── Rule 7: Small-gain locks ──
    // Peak 3-5%: exit if faded to ≤ 0.5% after 4+ bars
    if (peakPnlPct_ >= 3 && peakPnlPct_ < 5 && currentPnl <= 0.5 && i >= 4) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }
    // Peak 2-3%: exit if faded to ≤ 0.5% after 4+ bars
    if (peakPnlPct_ >= 2 && peakPnlPct_ < 3 && currentPnl <= 0.5 && i >= 4) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }
    // Peak 1-2%: exit if faded to ≤ 0.4% after 4+ bars
    if (peakPnlPct_ >= 1 && peakPnlPct_ < 2 && currentPnl <= 0.4 && i >= 4) {
      return mkResult(i, 'SMALL_GAIN_LOCK', currentPremium);
    }

    // ── Rule 10: Dynamic trailing with time-decay bonus (after 10 min) ──
    // Adds +1% per minute after 10 min hold, capped at +10% (20 min)
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
      const retain = Math.min(0.65 + timeBonus / 100, 0.80);
      if (currentPnl <= peakPnlPct_ * retain && currentPnl < peakPnlPct_) {
        return mkResult(i, 'TRAILING_DECAY', currentPremium);
      }
    }

    // ── Rules 3 & 4: Trailing stop + profit floors ──
    // Grace period: don't tighten the trailing stop in the first 4 bars unless
    // we already have meaningful profit (peak >= 5%). This prevents the 0.87
    // trailing factor from choking entries during initial chop.
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
