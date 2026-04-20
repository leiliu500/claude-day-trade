import { runBacktest } from "../backtest/engine.js";
import { computeMetrics } from "../backtest/report.js";
import { config } from "../config.js";
import type { SymbolConfig } from "../config.js";

interface Trial {
  label: string;
  overrides: Partial<SymbolConfig>;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number;
  netPnL: number;
  maxDD: number;
  exitBreakdown: Record<string, number>;
  blockedBreakdown: Record<string, number>;
}

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function findOrCreateEntry(symbol: string): SymbolConfig {
  let entry = config.symbols.find((c) => c.symbol === symbol);
  if (!entry) {
    entry = { symbol, strategy: "orb-filtered", vehicle: "long_option", maxConcurrent: 1 };
    config.symbols.push(entry);
  }
  return entry;
}

async function runTrial(
  symbol: string,
  startISO: string,
  endISO: string,
  overrides: Partial<SymbolConfig>,
  label: string,
): Promise<Trial> {
  const entry = findOrCreateEntry(symbol);
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(overrides) as (keyof SymbolConfig)[]) {
    prev[k as string] = entry[k];
  }
  Object.assign(entry, overrides);

  try {
    const res = await runBacktest({ symbol, startISO, endISO });
    const m = computeMetrics(res);
    return {
      label,
      overrides,
      trades: m.entries,
      wins: m.wins,
      losses: m.losses,
      winRate: m.winRate,
      expectancy: m.expectancy,
      netPnL: m.netPnL,
      maxDD: m.maxDrawdown,
      exitBreakdown: m.exitBreakdown,
      blockedBreakdown: m.blockedBreakdown,
    };
  } finally {
    const mut = entry as unknown as Record<string, unknown>;
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete mut[k];
      else mut[k] = prev[k];
    }
  }
}

const DEFAULT_GRID: Record<string, Array<string | number>> = {
  strategy: ["orb-filtered", "orb-breakout", "orb-multi", "trend-pullback"],
  longOptionTargetDelta: [0.40, 0.45, 0.50, 0.55, 0.60],
  longOptionPremiumStopPct: [0.25, 0.30, 0.40, 0.50, 0.60],
  longOptionProfitTargetPct: [0.60, 0.80, 1.00, 1.20, 1.50],
  deltaBand: [0.05, 0.10, 0.15, 0.20],
  emaPeriod: [10, 15, 20, 25, 30],
  atrPeriod: [7, 10, 14, 20],
  hvRankSellMin: [0.60, 0.70, 0.80, 0.90, 0.95],
};

function formatVal(v: unknown): string {
  if (typeof v === "number") return String(v);
  return String(v);
}

function printTable(rows: Trial[], minTrades: number, baselineExp: number): void {
  const hdr = [
    "label".padEnd(40),
    "trades".padStart(7),
    "W/L".padStart(9),
    "winRate".padStart(8),
    "expect".padStart(9),
    "Δexp".padStart(9),
    "net".padStart(10),
    "maxDD".padStart(9),
  ].join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const r of rows) {
    const dexp = r.expectancy - baselineExp;
    const flag = r.trades < minTrades ? "*" : " ";
    const row = [
      (flag + r.label).slice(0, 40).padEnd(40),
      String(r.trades).padStart(7),
      `${r.wins}/${r.losses}`.padStart(9),
      (r.winRate * 100).toFixed(1).padStart(7) + "%",
      r.expectancy.toFixed(2).padStart(9),
      (dexp >= 0 ? "+" : "") + dexp.toFixed(2).padStart(8),
      (r.netPnL >= 0 ? "+" : "") + r.netPnL.toFixed(0).padStart(9),
      r.maxDD.toFixed(0).padStart(9),
    ].join(" | ");
    console.log(row);
  }
  console.log(`(* = below minTrades=${minTrades} — unreliable)`);
}

async function main(): Promise<void> {
  const symbol = arg("symbol");
  const startISO = arg("start");
  const endISO = arg("end");
  const minTrades = Number(arg("minTrades", "10"));
  const combosArg = process.argv.some((a) => a === "--combos" || a.startsWith("--combos="))
    ? arg("combos")
    : null;

  console.log(`\n=== Sweeping ${symbol} ${startISO} → ${endISO} (minTrades=${minTrades}) ===\n`);

  const baseline = await runTrial(symbol, startISO, endISO, {}, "baseline");
  console.log("BASELINE:");
  printTable([baseline], 0, 0);

  if (combosArg) {
    const combos = JSON.parse(combosArg) as Array<{ label?: string; overrides: Partial<SymbolConfig> }>;
    const rows: Trial[] = [baseline];
    for (const { label, overrides } of combos) {
      const name = label ?? Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(" ");
      try {
        const t = await runTrial(symbol, startISO, endISO, overrides, name);
        rows.push(t);
      } catch (e) {
        console.log(`  ${name}: error ${(e as Error).message}`);
      }
    }
    rows.sort((a, b) => b.expectancy - a.expectancy);
    console.log("\n=== Combo results (ranked by expectancy) ===");
    printTable(rows, minTrades, baseline.expectancy);
    return;
  }

  const paramsArg = process.argv.some((a) => a === "--params" || a.startsWith("--params="))
    ? arg("params")
    : null;
  const paramsToSweep = paramsArg ? paramsArg.split(",") : Object.keys(DEFAULT_GRID);

  if (baseline.trades < minTrades) {
    console.log(`\n⚠️  Baseline has only ${baseline.trades} trades — sweeping may yield unreliable results.`);
  }

  const allTrials: Trial[] = [baseline];
  const perParamBest: Record<string, Trial> = {};

  for (const param of paramsToSweep) {
    const grid = DEFAULT_GRID[param];
    if (!grid) {
      console.log(`\n⚠️  Unknown param: ${param}`);
      continue;
    }
    console.log(`\n--- Sweeping ${param} ---`);
    const trials: Trial[] = [];
    for (const value of grid) {
      const overrides = { [param]: value } as Partial<SymbolConfig>;
      const label = `${param}=${formatVal(value)}`;
      try {
        const t = await runTrial(symbol, startISO, endISO, overrides, label);
        trials.push(t);
        allTrials.push(t);
      } catch (e) {
        console.log(`  ${label}: error ${(e as Error).message}`);
      }
    }
    trials.sort((a, b) => b.expectancy - a.expectancy);
    printTable(trials, minTrades, baseline.expectancy);

    const best = trials.find((t) => t.trades >= minTrades);
    if (best && best.expectancy > baseline.expectancy) perParamBest[param] = best;
  }

  console.log(`\n=== Top per-param improvements (Δexp vs baseline) ===`);
  const ranked = Object.entries(perParamBest).sort(
    (a, b) => b[1].expectancy - a[1].expectancy,
  );
  if (ranked.length === 0) {
    console.log("No single-param override beat baseline with sufficient trades.");
  } else {
    printTable(ranked.map((r) => r[1]), 0, baseline.expectancy);
  }

  console.log(`\n=== Suggested QQQ override (one-at-a-time top-ranked) ===`);
  const combined: Partial<SymbolConfig> = {};
  for (const [, t] of ranked) Object.assign(combined, t.overrides);
  if (Object.keys(combined).length === 0) {
    console.log("(no changes — baseline is best)");
  } else {
    console.log(JSON.stringify(combined, null, 2));
    console.log(`\nVerifying combined override...`);
    const combinedTrial = await runTrial(symbol, startISO, endISO, combined, "combined");
    printTable([baseline, combinedTrial], 0, baseline.expectancy);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
