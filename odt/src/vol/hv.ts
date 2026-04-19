import type { Bar } from "../types.js";

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sq = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(sq);
}

export function hvAnnualizedFromDailyCloses(closes: number[], period: number): number {
  if (closes.length < period + 1) return NaN;
  const rets = logReturns(closes.slice(-(period + 1)));
  const s = stdev(rets);
  return s * Math.sqrt(252);
}

export function dailyClosesFromIntraday(bars: Bar[], sessionKey: (b: Bar) => string): number[] {
  const map = new Map<string, Bar>();
  for (const b of bars) map.set(sessionKey(b), b);
  return Array.from(map.values())
    .sort((a, b) => a.t - b.t)
    .map((b) => b.c);
}
