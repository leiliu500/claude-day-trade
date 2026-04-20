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
  perSymbolToday: Map<string, DayPnL>;
  perSymbolHistory: Map<string, DayPnL[]>;
}

function newDayPnL(dateKey: string): DayPnL {
  return { dateKey, realized: 0, closedCount: 0, wins: 0, losses: 0, streakLosses: 0 };
}

export function newAccountState(equity: number, dateKey: string): AccountState {
  return {
    equity,
    openPositions: [],
    closedToday: [],
    today: newDayPnL(dateKey),
    history: [],
    perSymbolToday: new Map(),
    perSymbolHistory: new Map(),
  };
}

export function ensureSymbolDay(state: AccountState, symbol: string, dateKey: string): DayPnL {
  let d = state.perSymbolToday.get(symbol);
  if (!d) {
    d = newDayPnL(dateKey);
    state.perSymbolToday.set(symbol, d);
  } else if (d.dateKey !== dateKey) {
    const hist = state.perSymbolHistory.get(symbol) ?? [];
    hist.push(d);
    state.perSymbolHistory.set(symbol, hist);
    d = newDayPnL(dateKey);
    state.perSymbolToday.set(symbol, d);
  }
  return d;
}

export function rollDay(state: AccountState, newDateKey: string): void {
  if (state.today.dateKey === newDateKey) return;
  state.history.push(state.today);
  state.closedToday = [];
  state.today = newDayPnL(newDateKey);
  for (const symbol of state.perSymbolToday.keys()) {
    ensureSymbolDay(state, symbol, newDateKey);
  }
}

export function rollDayFor(state: AccountState, symbol: string, newDateKey: string): void {
  ensureSymbolDay(state, symbol, newDateKey);
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
  if (pos.symbol) {
    const d = ensureSymbolDay(state, pos.symbol, state.today.dateKey);
    d.realized += pos.pnlDollars;
    d.closedCount++;
    if (pos.pnlDollars >= 0) {
      d.wins++;
      d.streakLosses = 0;
    } else {
      d.losses++;
      d.streakLosses++;
    }
  }
}

export function countOpenForSymbol(state: AccountState, symbol: string): number {
  let n = 0;
  for (const p of state.openPositions) if (p.symbol === symbol) n++;
  return n;
}
