import { runLive } from "../live/orchestrator.js";
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
  const dryRun = process.argv.includes("--dry-run");
  const strategyName = arg("strategy", "orb");
  const strategy = getStrategy(strategyName);
  const vehicleArg = arg("vehicle", "long_option") as "debit_vertical" | "long_option";

  console.log(
    `Starting live: symbol=${symbol} strategy=${strategy.name} vehicle=${vehicleArg} dry-run=${dryRun}`,
  );
  await runLive({ symbol, dryRun, strategy, vehicle: vehicleArg });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
