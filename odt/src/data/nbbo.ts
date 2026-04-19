import type { Quote } from "../types.js";
import { config } from "../config.js";

export function mid(q: Pick<Quote, "bid" | "ask">): number {
  return (q.bid + q.ask) / 2;
}

export function spreadPct(q: Pick<Quote, "bid" | "ask">): number {
  const m = mid(q);
  if (m <= 0) return Infinity;
  return (q.ask - q.bid) / m;
}

export function isStale(q: Pick<Quote, "ts">, now: number, maxAgeMs = 10_000): boolean {
  return now - q.ts > maxAgeMs;
}

export function isTradeable(q: Pick<Quote, "bid" | "ask" | "ts">, now: number): boolean {
  if (q.bid <= 0 || q.ask <= 0 || q.ask <= q.bid) return false;
  if (spreadPct(q) > config.execution.spreadMaxPctOfMid) return false;
  if (isStale(q, now)) return false;
  return true;
}
