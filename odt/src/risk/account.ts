import type { Position } from "../types.js";

export interface DayPnL {
  dateKey: string;
  realized: number;
  closedCount: number;
  wins: number;
  losses: number;
  streakLosses: number;
}

export interface AccountState {
  equity: number;
  openPositions: Position[];
  closedToday: Position[];
  today: DayPnL;
  history: DayPnL[];
}

export function newAccountState(equity: number, dateKey: string): AccountState {
  return {
    equity,
    openPositions: [],
    closedToday: [],
    today: { dateKey, realized: 0, closedCount: 0, wins: 0, losses: 0, streakLosses: 0 },
    history: [],
  };
}

export function rollDay(state: AccountState, newDateKey: string): void {
  if (state.today.dateKey === newDateKey) return;
  state.history.push(state.today);
  state.closedToday = [];
  state.today = { dateKey: newDateKey, realized: 0, closedCount: 0, wins: 0, losses: 0, streakLosses: 0 };
}

export function recordClose(state: AccountState, pos: Position): void {
  if (pos.pnlDollars === undefined) return;
  state.equity += pos.pnlDollars;
  state.today.realized += pos.pnlDollars;
  state.today.closedCount++;
  state.closedToday.push(pos);
  if (pos.pnlDollars >= 0) {
    state.today.wins++;
    state.today.streakLosses = 0;
  } else {
    state.today.losses++;
    state.today.streakLosses++;
  }
}
