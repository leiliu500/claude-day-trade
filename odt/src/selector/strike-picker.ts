import type { LongOptionOrder, OptionContract, VerticalOrder, Signal } from "../types.js";
import { config } from "../config.js";
import { bsDelta, bsPrice, strikeForTargetDelta } from "./black-scholes.js";
import { buildOccSymbol } from "./occ-symbol.js";
import { addBusinessDays, sessionCloseUTCms } from "../util/time.js";

const R = 0.04;
const MIN_T_SECONDS = 60;
const YEAR_SECONDS = 365 * 24 * 3600;

export interface SynthContext {
  underlying: string;
  underlyingPx: number;
  hvAnnualized: number;
  asOfDateISO: string;
  asOfMs: number;
  strikeStep?: number;
}

function timeToExpiryYears(asOfMs: number, expiryISO: string): number {
  const expiryMs = sessionCloseUTCms(expiryISO);
  const seconds = Math.max(MIN_T_SECONDS, (expiryMs - asOfMs) / 1000);
  return seconds / YEAR_SECONDS;
}

export function pickSyntheticVertical(
  ctx: SynthContext,
  side: "LONG" | "SHORT",
  signal: Signal,
): VerticalOrder {
  const type: "C" | "P" = side === "LONG" ? "C" : "P";
  const dte = Math.round((config.strategy.minDTE + config.strategy.maxDTE) / 2);
  const expiryISO = addBusinessDays(ctx.asOfDateISO, dte);
  const T = timeToExpiryYears(ctx.asOfMs, expiryISO);
  const step = ctx.strikeStep ?? 1;
  const sigma = Math.max(ctx.hvAnnualized, 0.08);

  const longStrike = strikeForTargetDelta(
    ctx.underlyingPx,
    T,
    R,
    sigma,
    type,
    config.strategy.targetDelta,
    step,
  );
  const width = config.strategy.verticalWidthDollars;
  const shortStrike = type === "C" ? longStrike + width : longStrike - width;

  const longDelta = bsDelta({ S: ctx.underlyingPx, K: longStrike, T, r: R, sigma, type });
  const shortDelta = bsDelta({ S: ctx.underlyingPx, K: shortStrike, T, r: R, sigma, type });
  const longMid = bsPrice({ S: ctx.underlyingPx, K: longStrike, T, r: R, sigma, type });
  const shortMid = bsPrice({ S: ctx.underlyingPx, K: shortStrike, T, r: R, sigma, type });

  const debit = Math.max(0.05, longMid - shortMid);

  const mkLeg = (K: number, d: number, m: number): OptionContract => ({
    symbol: buildOccSymbol({ underlying: ctx.underlying, expiryISO, type, strike: K }),
    underlying: ctx.underlying,
    strike: K,
    expiry: expiryISO,
    type,
    delta: d,
    bid: Math.max(0.01, m - 0.05),
    ask: m + 0.05,
    oi: 500,
    volume: 100,
  });

  return {
    kind: "debit_vertical",
    side,
    long: mkLeg(longStrike, longDelta, longMid),
    short: mkLeg(shortStrike, shortDelta, shortMid),
    qty: 0,
    limitDebit: Number(debit.toFixed(2)),
    meta: {
      signalTs: signal.ts,
      entryUnderlying: ctx.underlyingPx,
      atr: signal.atr,
      reason: signal.reason,
    },
  };
}

export function pickSyntheticLongOption(
  ctx: SynthContext,
  side: "LONG" | "SHORT",
  signal: Signal,
): LongOptionOrder {
  const type: "C" | "P" = side === "LONG" ? "C" : "P";
  const dte = Math.round((config.strategy.minDTE + config.strategy.maxDTE) / 2);
  const expiryISO = addBusinessDays(ctx.asOfDateISO, dte);
  const T = timeToExpiryYears(ctx.asOfMs, expiryISO);
  const step = ctx.strikeStep ?? 1;
  const sigma = Math.max(ctx.hvAnnualized, 0.08);

  const strike = strikeForTargetDelta(
    ctx.underlyingPx,
    T,
    R,
    sigma,
    type,
    config.strategy.longOptionTargetDelta,
    step,
  );
  const delta = bsDelta({ S: ctx.underlyingPx, K: strike, T, r: R, sigma, type });
  const mid = bsPrice({ S: ctx.underlyingPx, K: strike, T, r: R, sigma, type });
  const premium = Math.max(0.10, mid);

  const leg: OptionContract = {
    symbol: buildOccSymbol({ underlying: ctx.underlying, expiryISO, type, strike }),
    underlying: ctx.underlying,
    strike,
    expiry: expiryISO,
    type,
    delta,
    bid: Math.max(0.01, premium - 0.05),
    ask: premium + 0.05,
    oi: 500,
    volume: 100,
  };

  return {
    kind: "long_option",
    side,
    leg,
    qty: 0,
    limitDebit: Number(premium.toFixed(2)),
    meta: {
      signalTs: signal.ts,
      entryUnderlying: ctx.underlyingPx,
      atr: signal.atr,
      reason: signal.reason,
    },
  };
}

export function pickLongOptionFromSnapshots(
  candidates: OptionContract[],
  side: "LONG" | "SHORT",
  signal: Signal,
): LongOptionOrder | null {
  const type: "C" | "P" = side === "LONG" ? "C" : "P";
  const pool = candidates.filter((c) => c.type === type);
  if (pool.length === 0) return null;

  const target = side === "LONG" ? config.strategy.longOptionTargetDelta : -config.strategy.longOptionTargetDelta;
  pool.sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target));
  const leg = pool.find(
    (c) => Math.abs(Math.abs(c.delta) - config.strategy.longOptionTargetDelta) <= config.strategy.deltaBand,
  );
  if (!leg) return null;

  const mid = (leg.bid + leg.ask) / 2;
  return {
    kind: "long_option",
    side,
    leg,
    qty: 0,
    limitDebit: Number(Math.max(0.05, mid).toFixed(2)),
    meta: {
      signalTs: signal.ts,
      entryUnderlying: signal.entryPrice,
      atr: signal.atr,
      reason: signal.reason,
    },
  };
}

export function pickFromSnapshots(
  candidates: OptionContract[],
  side: "LONG" | "SHORT",
  signal: Signal,
): VerticalOrder | null {
  const type: "C" | "P" = side === "LONG" ? "C" : "P";
  const pool = candidates.filter((c) => c.type === type);
  if (pool.length < 2) return null;

  const target = side === "LONG" ? config.strategy.targetDelta : -config.strategy.targetDelta;
  pool.sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target));
  const longLeg = pool.find((c) => Math.abs(Math.abs(c.delta) - config.strategy.targetDelta) <= config.strategy.deltaBand);
  if (!longLeg) return null;

  const width = config.strategy.verticalWidthDollars;
  const shortStrike = type === "C" ? longLeg.strike + width : longLeg.strike - width;
  const shortLeg = pool
    .filter((c) => c.expiry === longLeg.expiry)
    .sort((a, b) => Math.abs(a.strike - shortStrike) - Math.abs(b.strike - shortStrike))[0];
  if (!shortLeg || shortLeg.symbol === longLeg.symbol) return null;

  const longMid = (longLeg.bid + longLeg.ask) / 2;
  const shortMid = (shortLeg.bid + shortLeg.ask) / 2;
  const debit = Math.max(0.05, longMid - shortMid);

  return {
    kind: "debit_vertical",
    side,
    long: longLeg,
    short: shortLeg,
    qty: 0,
    limitDebit: Number(debit.toFixed(2)),
    meta: {
      signalTs: signal.ts,
      entryUnderlying: signal.entryPrice,
      atr: signal.atr,
      reason: signal.reason,
    },
  };
}
