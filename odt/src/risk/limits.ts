import type { OptionOrder } from "../types.js";
import type { AccountState } from "./account.js";
import { countOpenForSymbol } from "./account.js";
import { config } from "../config.js";

export interface SizeResult {
  qty: number;
  perContractRisk: number;
  reason: string;
}

function perContractRiskFor(order: OptionOrder, longOptionStopPct: number): number {
  if (order.kind === "debit_vertical") {
    const widthDollars = Math.abs(order.long.strike - order.short.strike);
    const maxLossPerContract = Math.max(order.limitDebit, 0.05) * 100;
    return Math.min(maxLossPerContract, widthDollars * 100);
  }
  return Math.max(order.limitDebit, 0.05) * 100 * longOptionStopPct;
}

export function sizeOrder(
  order: OptionOrder,
  state: AccountState,
  opts?: { longOptionStopPct?: number },
): SizeResult {
  const stopPct = opts?.longOptionStopPct ?? config.strategy.longOptionPremiumStopPct;
  const perContractRisk = perContractRiskFor(order, stopPct);
  const perTradeBudget = state.equity * config.risk.maxRiskPerTradePct;
  const qtyByTrade = Math.floor(perTradeBudget / perContractRisk);
  const qty = Math.max(0, qtyByTrade);
  return {
    qty,
    perContractRisk,
    reason: qty === 0 ? "per-trade-budget-too-small" : "ok",
  };
}

export interface PretradeCheck {
  ok: boolean;
  reason?: string;
}

export interface PretradeOpts {
  symbol?: string;
  symbolMaxConcurrent?: number;
  symbolLossStreakLockout?: number;
}

export function pretradeGate(
  state: AccountState,
  orderRisk: number,
  opts?: PretradeOpts,
): PretradeCheck {
  if (state.openPositions.length >= config.risk.maxConcurrent) {
    return { ok: false, reason: "max-concurrent" };
  }
  if (opts?.symbol && opts.symbolMaxConcurrent !== undefined) {
    if (countOpenForSymbol(state, opts.symbol) >= opts.symbolMaxConcurrent) {
      return { ok: false, reason: "symbol-max-concurrent" };
    }
  }
  const dayBudget = state.equity * config.risk.maxRiskPerDayPct;
  const alreadyLost = Math.min(0, state.today.realized);
  const dayRoom = dayBudget + alreadyLost;
  if (dayRoom <= 0) {
    return { ok: false, reason: "daily-loss-hit" };
  }
  if (orderRisk > dayRoom) {
    return { ok: false, reason: "per-trade-exceeds-day-room" };
  }
  const symStreakCap = opts?.symbolLossStreakLockout ?? config.risk.lossStreakLockout;
  if (opts?.symbol) {
    const symDay = state.perSymbolToday.get(opts.symbol);
    if (symDay && symDay.streakLosses >= symStreakCap) {
      return { ok: false, reason: "loss-streak-lockout" };
    }
  } else if (state.today.streakLosses >= config.risk.lossStreakLockout) {
    return { ok: false, reason: "loss-streak-lockout" };
  }
  return { ok: true };
}
