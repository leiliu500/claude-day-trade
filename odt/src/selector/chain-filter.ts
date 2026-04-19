import type { OptionContract } from "../types.js";
import { config } from "../config.js";
import { mid, spreadPct } from "../data/nbbo.js";

export interface FilterStats {
  passed: number;
  rejectedLiquidity: number;
  rejectedSpread: number;
  rejectedPrice: number;
}

export function filterTradeable(
  contracts: OptionContract[],
): { passed: OptionContract[]; stats: FilterStats } {
  const stats: FilterStats = { passed: 0, rejectedLiquidity: 0, rejectedSpread: 0, rejectedPrice: 0 };
  const passed: OptionContract[] = [];
  for (const c of contracts) {
    if (c.bid <= 0 || c.ask <= 0 || c.ask <= c.bid) {
      stats.rejectedPrice++;
      continue;
    }
    if (c.oi < config.execution.minOI) {
      stats.rejectedLiquidity++;
      continue;
    }
    if (spreadPct(c) > config.execution.spreadMaxPctOfMid) {
      stats.rejectedSpread++;
      continue;
    }
    passed.push(c);
    stats.passed++;
  }
  return { passed, stats };
}

export function midFor(c: OptionContract): number {
  return mid(c);
}
