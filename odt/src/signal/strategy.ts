import type { Bar, Signal } from "../types.js";
import type { StrategyParams } from "../config.js";
import * as trendPullback from "./trend-pullback.js";
import * as orbBreakout from "./orb-breakout.js";
import * as orbFiltered from "./orb-filtered.js";
import * as orbMulti from "./orb-multi.js";

export interface Strategy {
  readonly name: string;
  makeState(params?: StrategyParams): unknown;
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

export const orbFilteredStrategy: Strategy = {
  name: "orb-filtered",
  makeState: orbFiltered.makeState,
  onBar: orbFiltered.onBar as Strategy["onBar"],
  underlyingInvalidated: orbFiltered.underlyingInvalidated as Strategy["underlyingInvalidated"],
};

export const orbMultiStrategy: Strategy = {
  name: "orb-multi",
  makeState: orbMulti.makeState,
  onBar: orbMulti.onBar as Strategy["onBar"],
  underlyingInvalidated: orbMulti.underlyingInvalidated as Strategy["underlyingInvalidated"],
};

export function getStrategy(name: string): Strategy {
  const n = name.toLowerCase();
  if (n === "trend-pullback" || n === "tp") return trendPullbackStrategy;
  if (n === "orb" || n === "orb-breakout") return orbBreakoutStrategy;
  if (n === "orbf" || n === "orb-filtered") return orbFilteredStrategy;
  if (n === "orbm" || n === "orb-multi") return orbMultiStrategy;
  throw new Error(`unknown strategy: ${name} (try: trend-pullback | orb | orb-filtered | orb-multi)`);
}
