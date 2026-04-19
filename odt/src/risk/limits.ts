import type { OptionOrder } from "../types.js";
import type { AccountState } from "./account.js";
import { config } from "../config.js";

export interface SizeResult {
  qty: number;
  perContractRisk: number;
  reason: string;
}

function perContractRiskFor(order: OptionOrder): number {
  if (order.kind === "debit_vertical") {
    const widthDollars = Math.abs(order.long.strike - order.short.strike);
    const maxLossPerContract = Math.max(order.limitDebit, 0.05) * 100;
    return Math.min(maxLossPerContract, widthDollars * 100);
  }
  const stopFrac = config.strategy.longOptionPremiumStopPct;
  return Math.max(order.limitDebit, 0.05) * 100 * stopFrac;
}

export function sizeOrder(order: OptionOrder, state: AccountState): SizeResult {
  const perContractRisk = perContractRiskFor(order);
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

export function pretradeGate(state: AccountState, orderRisk: number): PretradeCheck {
  if (state.openPositions.length >= config.risk.maxConcurrent) {
    return { ok: false, reason: "max-concurrent" };
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
  if (state.today.streakLosses >= config.risk.lossStreakLockout) {
    return { ok: false, reason: "loss-streak-lockout" };
  }
  return { ok: true };
}
