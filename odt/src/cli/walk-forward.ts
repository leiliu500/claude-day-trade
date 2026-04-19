import { runWalkForward, stabilitySummary } from "../backtest/walk-forward.js";
import { formatReport } from "../backtest/report.js";
import { getStrategy } from "../signal/strategy.js";

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
  const folds = Number(arg("folds", "3"));
  const equity = Number(arg("equity", "25000"));

  const strategyName = arg("strategy", "trend-pullback");
  const strategy = getStrategy(strategyName);
  const vehicleArg = arg("vehicle", "") as "" | "debit_vertical" | "long_option";
  const vehicle = vehicleArg === "" ? undefined : vehicleArg;
  console.log(`Strategy: ${strategy.name}  Vehicle: ${vehicle ?? "(config default)"}`);
  const results = await runWalkForward({ symbol, startISO, endISO, folds, initialEquity: equity, strategy, vehicle });
  for (const f of results) {
    console.log(formatReport(f.result, f.metrics));
    console.log("");
  }
  console.log("=== Walk-Forward Stability ===");
  console.log(stabilitySummary(results));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
