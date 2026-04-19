import type { Bar, Signal } from "../types.js";
import * as trendPullback from "./trend-pullback.js";
import * as orbBreakout from "./orb-breakout.js";

export interface Strategy {
  readonly name: string;
  makeState(): unknown;
  onBar(state: unknown, b: Bar): Signal | null;
  underlyingInvalidated(state: unknown, side: "LONG" | "SHORT"): boolean;
}

export const trendPullbackStrategy: Strategy = {
  name: "trend-pullback",
  makeState: trendPullback.makeState,
  onBar: trendPullback.onBar as Strategy["onBar"],
  underlyingInvalidated: trendPullback.underlyingInvalidated as Strategy["underlyingInvalidated"],
};

export const orbBreakoutStrategy: Strategy = {
  name: "orb-breakout",
  makeState: orbBreakout.makeState,
  onBar: orbBreakout.onBar as Strategy["onBar"],
  underlyingInvalidated: orbBreakout.underlyingInvalidated as Strategy["underlyingInvalidated"],
};

export function getStrategy(name: string): Strategy {
  const n = name.toLowerCase();
  if (n === "trend-pullback" || n === "tp") return trendPullbackStrategy;
  if (n === "orb" || n === "orb-breakout") return orbBreakoutStrategy;
  throw new Error(`unknown strategy: ${name} (try: trend-pullback | orb)`);
}
