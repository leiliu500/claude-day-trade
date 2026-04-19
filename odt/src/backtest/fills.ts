import type { Fill, OptionOrder } from "../types.js";
import { config } from "../config.js";
import { bsPrice } from "../selector/black-scholes.js";
import { sessionCloseUTCms } from "../util/time.js";

const R = 0.04;

export interface MarkInputs {
  order: OptionOrder;
  underlyingPx: number;
  nowMs: number;
  sigma: number;
}

const MIN_T_SECONDS = 60;
const YEAR_SECONDS = 365 * 24 * 3600;

function dteYears(asOfMs: number, expiryISO: string): number {
  const expiryMs = sessionCloseUTCms(expiryISO);
  const secondsLeft = Math.max(MIN_T_SECONDS, (expiryMs - asOfMs) / 1000);
  return secondsLeft / YEAR_SECONDS;
}

export function theoreticalDebit(m: MarkInputs): number {
  if (m.order.kind === "debit_vertical") {
    const T = dteYears(m.nowMs, m.order.long.expiry);
    const longP = bsPrice({
      S: m.underlyingPx,
      K: m.order.long.strike,
      T,
      r: R,
      sigma: m.sigma,
      type: m.order.long.type,
    });
    const shortP = bsPrice({
      S: m.underlyingPx,
      K: m.order.short.strike,
      T,
      r: R,
      sigma: m.sigma,
      type: m.order.short.type,
    });
    return Math.max(0.01, longP - shortP);
  }
  const T = dteYears(m.nowMs, m.order.leg.expiry);
  const p = bsPrice({
    S: m.underlyingPx,
    K: m.order.leg.strike,
    T,
    r: R,
    sigma: m.sigma,
    type: m.order.leg.type,
  });
  return Math.max(0.01, p);
}

function legCount(order: OptionOrder): number {
  return order.kind === "debit_vertical" ? 2 : 1;
}

export function simulateEntryFill(order: OptionOrder, theoretical: number, now: number): Fill | null {
  const legs = legCount(order);
  const slippage = config.execution.slippagePerContract * legs;
  const filledDebit = theoretical + slippage;
  const impliedSpreadPct = slippage / Math.max(theoretical, 0.05);
  if (impliedSpreadPct > config.execution.spreadMaxPctOfMid) return null;
  const fees = config.execution.feePerContract * legs * order.qty;
  return {
    order,
    filledDebit: Number(filledDebit.toFixed(2)),
    fees,
    ts: now,
  };
}

export function simulateExitFill(order: OptionOrder, theoretical: number): { debit: number; fees: number } {
  const legs = legCount(order);
  const slippage = config.execution.slippagePerContract * legs;
  const exitDebit = Math.max(0, theoretical - slippage);
  const fees = config.execution.feePerContract * legs * order.qty;
  return { debit: Number(exitDebit.toFixed(2)), fees };
}
