export type Side = "LONG" | "SHORT" | "FLAT";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  ts: number;
}

export interface OptionContract {
  symbol: string;
  underlying: string;
  strike: number;
  expiry: string;
  type: "C" | "P";
  delta: number;
  bid: number;
  ask: number;
  oi: number;
  volume: number;
}

export interface OrderMeta {
  signalTs: number;
  entryUnderlying: number;
  atr: number;
  reason: string;
}

export interface VerticalOrder {
  kind: "debit_vertical";
  side: "LONG" | "SHORT";
  long: OptionContract;
  short: OptionContract;
  qty: number;
  limitDebit: number;
  meta: OrderMeta;
}

export interface LongOptionOrder {
  kind: "long_option";
  side: "LONG" | "SHORT";
  leg: OptionContract;
  qty: number;
  limitDebit: number;
  meta: OrderMeta;
}

export type OptionOrder = VerticalOrder | LongOptionOrder;

export interface Fill {
  order: OptionOrder;
  filledDebit: number;
  fees: number;
  ts: number;
}

export type Vehicle = "debit_vertical" | "long_option";

export type ExitRule = "invalidation" | "premium_stop" | "target" | "time" | "kill_switch";

export interface Position {
  id: string;
  symbol: string;
  opened: number;
  fill: Fill;
  entryUnderlying: number;
  lastMarkDebit: number;
  exitRule?: ExitRule;
  closedTs?: number;
  exitDebit?: number;
  pnlDollars?: number;
}

export interface Signal {
  side: Side;
  atr: number;
  reason: string;
  ts: number;
  entryPrice: number;
  stopPrice: number;
}

export type VolRegime = "BUY_VOL" | "SELL_VOL" | "AVOID";
