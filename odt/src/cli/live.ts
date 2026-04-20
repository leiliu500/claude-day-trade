import { runLive } from "../live/orchestrator.js";
import { getStrategy } from "../signal/strategy.js";
import { makeSink } from "../tracking/factory.js";
import { closePool } from "../tracking/db-pool.js";
import { config, resolveSymbolConfig } from "../config.js";
import type { SymbolConfig } from "../config.js";
import type { Vehicle } from "../types.js";

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function hasArg(name: string): boolean {
  const prefix = `--${name}=`;
  if (process.argv.some((a) => a.startsWith(prefix))) return true;
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length;
}

function resolveSymbolList(): SymbolConfig[] {
  const single = hasArg("symbol") ? arg("symbol") : null;
  const list = hasArg("symbols") ? arg("symbols") : null;
  const strategyOverride = hasArg("strategy") ? arg("strategy") : null;
  const vehicleOverride = hasArg("vehicle") ? (arg("vehicle") as Vehicle) : null;

  if (single) {
    const preset = config.symbols.find((c) => c.symbol === single);
    return [
      {
        symbol: single,
        strategy: strategyOverride ?? preset?.strategy,
        vehicle: vehicleOverride ?? preset?.vehicle,
        targetDelta: preset?.targetDelta,
        longOptionTargetDelta: preset?.longOptionTargetDelta,
        deltaBand: preset?.deltaBand,
        verticalWidthDollars: preset?.verticalWidthDollars,
        premiumStopPct: preset?.premiumStopPct,
        profitTargetPct: preset?.profitTargetPct,
        longOptionPremiumStopPct: preset?.longOptionPremiumStopPct,
        longOptionProfitTargetPct: preset?.longOptionProfitTargetPct,
        maxConcurrent: preset?.maxConcurrent,
        lossStreakLockout: preset?.lossStreakLockout,
      },
    ];
  }
  if (list) {
    return list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((symbol) => {
        const preset = config.symbols.find((c) => c.symbol === symbol);
        return {
          symbol,
          strategy: strategyOverride ?? preset?.strategy,
          vehicle: vehicleOverride ?? preset?.vehicle,
          targetDelta: preset?.targetDelta,
          longOptionTargetDelta: preset?.longOptionTargetDelta,
          deltaBand: preset?.deltaBand,
          verticalWidthDollars: preset?.verticalWidthDollars,
          premiumStopPct: preset?.premiumStopPct,
          profitTargetPct: preset?.profitTargetPct,
          longOptionPremiumStopPct: preset?.longOptionPremiumStopPct,
          longOptionProfitTargetPct: preset?.longOptionProfitTargetPct,
          maxConcurrent: preset?.maxConcurrent,
          lossStreakLockout: preset?.lossStreakLockout,
        };
      });
  }
  if (strategyOverride || vehicleOverride) {
    return config.symbols.map((c) => ({
      ...c,
      strategy: strategyOverride ?? c.strategy,
      vehicle: vehicleOverride ?? c.vehicle,
    }));
  }
  return config.symbols;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const noDb = process.argv.includes("--no-db");
  const noTelegram = process.argv.includes("--no-telegram");
  const symbolList = resolveSymbolList();

  if (symbolList.length === 0) throw new Error("no symbols to run (set config.symbols or pass --symbol/--symbols)");

  const desc = symbolList
    .map((s) => `${s.symbol}(${s.strategy ?? "default"}/${s.vehicle ?? "default"})`)
    .join(" ");
  console.log(
    `Starting live: ${desc} dry-run=${dryRun} db=${!noDb} telegram=${!noTelegram}`,
  );

  try {
    if (symbolList.length === 1) {
      const cfg = resolveSymbolConfig(symbolList[0]);
      const strategy = getStrategy(cfg.strategy);
      const sink = makeSink(
        {
          mode: "live",
          strategy: strategy.name,
          vehicle: cfg.vehicle,
          symbol: cfg.symbol,
          startedAt: Date.now(),
        },
        { db: !noDb, telegram: !noTelegram },
      );
      await runLive({
        symbol: cfg.symbol,
        strategy,
        vehicle: cfg.vehicle,
        sink,
        dryRun,
      });
    } else {
      await runLive({
        symbols: symbolList,
        dryRun,
        sinkFactory: (cfg) =>
          makeSink(
            {
              mode: "live",
              strategy: cfg.strategy,
              vehicle: cfg.vehicle,
              symbol: cfg.symbol,
              startedAt: Date.now(),
            },
            { db: !noDb, telegram: !noTelegram },
          ),
      });
    }
  } finally {
    if (!noDb) await closePool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
