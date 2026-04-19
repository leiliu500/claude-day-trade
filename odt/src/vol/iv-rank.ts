import type { VolRegime } from "../types.js";
import { config } from "../config.js";

export function rankWithin(sample: number, window: number[]): number {
  if (window.length === 0) return 0.5;
  const min = Math.min(...window);
  const max = Math.max(...window);
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (sample - min) / (max - min)));
}

export function regimeFromRank(rank: number): VolRegime {
  if (rank <= config.strategy.hvRankBuyMax) return "BUY_VOL";
  if (rank >= config.strategy.hvRankSellMin) return "SELL_VOL";
  return "AVOID";
}
