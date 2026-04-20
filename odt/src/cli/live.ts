import { runLive } from "../live/orchestrator.js";
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
  const dryRun = process.argv.includes("--dry-run");
  const strategyName = arg("strategy", "orb");
  const strategy = getStrategy(strategyName);
  const vehicleArg = arg("vehicle", "long_option") as "debit_vertical" | "long_option";
  const noDb = process.argv.includes("--no-db");
  const noTelegram = process.argv.includes("--no-telegram");

  const sink = makeSink(
    {
      mode: "live",
      strategy: strategy.name,
      vehicle: vehicleArg,
      symbol,
      startedAt: Date.now(),
    },
    { db: !noDb, telegram: !noTelegram },
  );

  console.log(
    `Starting live: symbol=${symbol} strategy=${strategy.name} vehicle=${vehicleArg} dry-run=${dryRun} db=${!noDb} telegram=${!noTelegram}`,
  );
  try {
    await runLive({ symbol, dryRun, strategy, vehicle: vehicleArg, sink });
  } finally {
    if (!noDb) await closePool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
