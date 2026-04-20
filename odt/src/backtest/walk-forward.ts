import { runBacktest, type BacktestResult } from "./engine.js";
import { computeMetrics, type Metrics } from "./report.js";
import type { Strategy } from "../signal/strategy.js";
import type { Vehicle } from "../types.js";
import type { TrackingSink } from "../tracking/sink.js";

export interface Fold {
  startISO: string;
  endISO: string;
  result: BacktestResult;
  metrics: Metrics;
}

export function splitFolds(startISO: string, endISO: string, folds: number): Array<{ startISO: string; endISO: string }> {
  const start = new Date(startISO + "T00:00:00Z").getTime();
  const end = new Date(endISO + "T00:00:00Z").getTime();
  const span = end - start;
  const foldSpan = Math.floor(span / folds);
  const out: Array<{ startISO: string; endISO: string }> = [];
  for (let i = 0; i < folds; i++) {
    const fs = start + i * foldSpan;
    const fe = i === folds - 1 ? end : fs + foldSpan;
    out.push({
      startISO: new Date(fs).toISOString().slice(0, 10),
      endISO: new Date(fe).toISOString().slice(0, 10),
    });
  }
  return out;
}

export async function runWalkForward(params: {
  symbol: string;
  startISO: string;
  endISO: string;
  folds: number;
  initialEquity?: number;
  strategy?: Strategy;
  vehicle?: Vehicle;
  createSink?: (foldRange: { startISO: string; endISO: string }) => TrackingSink | undefined;
}): Promise<Fold[]> {
  const partitions = splitFolds(params.startISO, params.endISO, params.folds);
  const results: Fold[] = [];
  for (const p of partitions) {
    const sink = params.createSink?.(p);
    const result = await runBacktest({
      symbol: params.symbol,
      startISO: p.startISO,
      endISO: p.endISO,
      initialEquity: params.initialEquity,
      strategy: params.strategy,
      vehicle: params.vehicle,
      sink,
    });
    results.push({ startISO: p.startISO, endISO: p.endISO, result, metrics: computeMetrics(result) });
  }
  return results;
}

export function stabilitySummary(folds: Fold[]): string {
  const exps = folds.map((f) => f.metrics.expectancy);
  const wrs = folds.map((f) => f.metrics.winRate);
  const allPos = exps.every((x) => x > 0);
  const anyNeg = exps.some((x) => x < 0);
  const mean = exps.reduce((a, b) => a + b, 0) / exps.length;
  const min = Math.min(...exps);
  const max = Math.max(...exps);
  const wrMin = Math.min(...wrs);
  const wrMax = Math.max(...wrs);
  const verdict = allPos ? "STABLE" : anyNeg && mean > 0 ? "MIXED" : "UNSTABLE";
  return (
    `Folds: ${folds.length} | mean exp $${mean.toFixed(2)} | range [$${min.toFixed(2)}, $${max.toFixed(2)}] | ` +
    `win-rate range [${(wrMin * 100).toFixed(1)}%, ${(wrMax * 100).toFixed(1)}%] | verdict: ${verdict}`
  );
}
