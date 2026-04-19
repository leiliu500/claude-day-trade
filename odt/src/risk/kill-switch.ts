import type { AccountState } from "./account.js";
import { config } from "../config.js";

export type KillReason =
  | "daily_loss"
  | "loss_streak"
  | "data_stale"
  | "spread_blowout"
  | "regime"
  | "manual";

export interface KillState {
  tripped: boolean;
  reason?: KillReason;
  trippedAt?: number;
}

export function newKillState(): KillState {
  return { tripped: false };
}

export function trip(state: KillState, reason: KillReason): void {
  if (state.tripped) return;
  state.tripped = true;
  state.reason = reason;
  state.trippedAt = Date.now();
}

export function check(account: AccountState, kill: KillState): void {
  if (kill.tripped) return;
  const dayBudget = account.equity * config.risk.maxRiskPerDayPct;
  if (account.today.realized < -dayBudget) trip(kill, "daily_loss");
  else if (account.today.streakLosses >= config.risk.lossStreakLockout) trip(kill, "loss_streak");
}

export function reset(kill: KillState): void {
  kill.tripped = false;
  kill.reason = undefined;
  kill.trippedAt = undefined;
}

export function shouldKillForRegime(
  rankHistory: number[],
  threshold: number,
  consecutiveDays: number,
): boolean {
  if (rankHistory.length < consecutiveDays) return false;
  const recent = rankHistory.slice(-consecutiveDays);
  return recent.every((r) => r >= threshold);
}
