import { runWalkForward, stabilitySummary } from "../backtest/walk-forward.js";
import { formatReport } from "../backtest/report.js";
import { getStrategy } from "../signal/strategy.js";
import { makeSink } from "../tracking/factory.js";
import { closePool } from "../tracking/db-pool.js";
import { config, resolveSymbolConfig } from "../config.js";

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

  const preset = config.symbols.find((c) => c.symbol === symbol);
  const resolved = resolveSymbolConfig(preset ?? { symbol });
  const strategy = getStrategy(resolved.strategy);
  const vehicle = resolved.vehicle;

  const useDb = process.argv.includes("--db");
  const useTelegram = process.argv.includes("--telegram");
  console.log(
    `Walk-forward (live-mirror): symbol=${symbol} strategy=${strategy.name} vehicle=${vehicle} source=${preset ? "config.symbols" : "global-default"}  db=${useDb} telegram=${useTelegram}`,
  );

  const createSink = (useDb || useTelegram)
    ? (fold: { startISO: string; endISO: string }) =>
        makeSink(
          {
            mode: "backtest" as const,
            strategy: strategy.name,
            vehicle,
            symbol,
            startedAt: Date.now(),
            foldWindow: { start: fold.startISO, end: fold.endISO },
          },
          { db: useDb, telegram: useTelegram },
        )
    : undefined;

  const results = await runWalkForward({
    symbol, startISO, endISO, folds, initialEquity: equity, strategy, vehicle, createSink,
  });
  for (const f of results) {
    console.log(formatReport(f.result, f.metrics));
    console.log("");
  }
  console.log("=== Walk-Forward Stability ===");
  console.log(stabilitySummary(results));
  if (useDb) await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
