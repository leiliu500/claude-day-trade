import { writeFileSync } from "node:fs";
import { runBacktest } from "../backtest/engine.js";
import { computeMetrics, formatReport, toCSV } from "../backtest/report.js";
import { getStrategy } from "../signal/strategy.js";
import { makeSink } from "../tracking/factory.js";
import { closePool } from "../tracking/db-pool.js";

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main(): Promise<void> {
  const symbol = arg("symbol", "SPY");
  const startISO = arg("start");
  const endISO = arg("end");
  const equity = Number(arg("equity", "25000"));
  const strategyName = arg("strategy", "trend-pullback");
  const strategy = getStrategy(strategyName);
  const vehicleArg = arg("vehicle", "") as "" | "debit_vertical" | "long_option";
  const vehicle = vehicleArg === "" ? undefined : vehicleArg;
  const csvPath = arg("out", `odt/backtest-${symbol}-${strategy.name}-${startISO}-${endISO}.csv`);
  const useDb = process.argv.includes("--db");
  const useTelegram = process.argv.includes("--telegram");

  const sink = makeSink(
    {
      mode: "backtest",
      strategy: strategy.name,
      vehicle: vehicle ?? "debit_vertical",
      symbol,
      startedAt: Date.now(),
      foldWindow: { start: startISO, end: endISO },
    },
    { db: useDb, telegram: useTelegram },
  );

  const result = await runBacktest({ symbol, startISO, endISO, initialEquity: equity, strategy, vehicle, sink });
  const metrics = computeMetrics(result);
  console.log(formatReport(result, metrics));
  writeFileSync(csvPath, toCSV(result.closedPositions));
  console.log(`\nTrades CSV: ${csvPath}`);
  if (useDb) await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
