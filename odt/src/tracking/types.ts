import type { ExitRule } from "../types.js";

export interface RunMeta {
  mode: "backtest" | "live";
  strategy: string;
  vehicle: string;
  symbol: string;
  startedAt: number;
  foldWindow?: { start: string; end: string };
}

export interface SignalEvent {
  kind: "signal";
  ts: number;
  day: string;
  mode: "backtest" | "live";
  side: "LONG" | "SHORT" | "FLAT";
  reason: string;
  atr: number;
  entryPrice: number;
  accepted: boolean;
  blockReason?: string;
}

export interface OpenEvent {
  kind: "open";
  ts: number;
  day: string;
  mode: "backtest" | "live";
  positionId: string;
  orderKind: "debit_vertical" | "long_option";
  side: "LONG" | "SHORT";
  symbols: string[];
  qty: number;
  filledDebit: number;
  fees: number;
  entryUnderlying: number;
  signalTs: number;
}

export interface CloseEvent {
  kind: "close";
  ts: number;
  day: string;
  mode: "backtest" | "live";
  positionId: string;
  exitRule: ExitRule;
  exitDebit: number;
  pnlDollars: number;
  holdMinutes: number;
}

export interface MarkEvent {
  kind: "mark";
  ts: number;
  day: string;
  mode: "backtest" | "live";
  positionId: string;
  markDebit: number;
  pnlPct: number;
  pnlDollars: number;
  underlyingPx: number;
}

export interface DailySummary {
  kind: "daily";
  day: string;
  mode: "backtest" | "live";
  strategy: string;
  vehicle: string;
  symbol: string;
  equityStart: number;
  equityEnd: number;
  pnlRealized: number;
  signalsTotal: number;
  signalsAccepted: number;
  signalsBlocked: number;
  entriesTotal: number;
  wins: number;
  losses: number;
  maxDrawdown: number;
  killSwitchReason?: string;
}

export type TrackingEvent = SignalEvent | OpenEvent | CloseEvent | MarkEvent | DailySummary;
