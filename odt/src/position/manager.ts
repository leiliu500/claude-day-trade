import type { ExitRule, Fill, Position } from "../types.js";
import { config } from "../config.js";
import { etMinutesSinceMidnight, parseHHMM } from "../util/time.js";

let nextId = 1;

export function openPosition(fill: Fill, now: number): Position {
  const order = fill.order;
  const symbol = order.kind === "debit_vertical" ? order.long.underlying : order.leg.underlying;
  return {
    id: `p${nextId++}`,
    symbol,
    opened: now,
    fill,
    entryUnderlying: fill.order.meta.entryUnderlying,
    lastMarkDebit: fill.filledDebit,
  };
}

export interface ExitParams {
  premiumStopPct: number;
  profitTargetPct: number;
  longOptionPremiumStopPct: number;
  longOptionProfitTargetPct: number;
  sessionCloseHHMM: string;
}

export function defaultExitParams(): ExitParams {
  return {
    premiumStopPct: config.strategy.premiumStopPct,
    profitTargetPct: config.strategy.profitTargetPct,
    longOptionPremiumStopPct: config.strategy.longOptionPremiumStopPct,
    longOptionProfitTargetPct: config.strategy.longOptionProfitTargetPct,
    sessionCloseHHMM: config.strategy.sessionCloseHHMM,
  };
}

export interface MarkContext {
  now: number;
  underlyingPx: number;
  markDebit: number;
  underlyingInvalidated: boolean;
  killTripped: boolean;
}

export function evaluateExit(
  pos: Position,
  ctx: MarkContext,
  params: ExitParams = defaultExitParams(),
): ExitRule | null {
  if (ctx.killTripped) return "kill_switch";
  const sessionMins = etMinutesSinceMidnight(ctx.now);
  const cutoff = parseHHMM(params.sessionCloseHHMM);
  if (sessionMins >= cutoff) return "time";

  const entry = pos.fill.filledDebit;
  if (entry <= 0) return null;
  const isLongOption = pos.fill.order.kind === "long_option";
  const stopPct = isLongOption ? params.longOptionPremiumStopPct : params.premiumStopPct;
  const targetPct = isLongOption ? params.longOptionProfitTargetPct : params.profitTargetPct;
  const pctMove = (ctx.markDebit - entry) / entry;
  if (pctMove <= -stopPct) return "premium_stop";
  if (pctMove >= targetPct) return "target";
  if (ctx.underlyingInvalidated) return "invalidation";
  return null;
}

export function closePosition(
  pos: Position,
  exitRule: ExitRule,
  exitDebit: number,
  fees: number,
  now: number,
): void {
  pos.exitRule = exitRule;
  pos.closedTs = now;
  pos.exitDebit = exitDebit;
  const grossPerContract = (exitDebit - pos.fill.filledDebit) * 100;
  const gross = grossPerContract * pos.fill.order.qty;
  pos.pnlDollars = gross - fees - pos.fill.fees;
}
