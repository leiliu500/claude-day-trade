import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  alpaca: {
    apiKey: req("ALPACA_API_KEY"),
    secretKey: req("ALPACA_SECRET_KEY"),
    baseUrl: process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets",
    dataUrl: process.env.ALPACA_DATA_URL ?? "https://data.alpaca.markets",
  },
  risk: {
    accountEquityFallback: 25_000,
    maxRiskPerTradePct: 0.01,
    maxRiskPerDayPct: 0.03,
    maxConcurrent: 2,
    lossStreakLockout: 3,
  },
  execution: {
    feePerContract: 0.65,
    slippagePerContract: 0.02,
    spreadMaxPctOfMid: 0.08,
    minOI: 100,
    minContractVolume: 10,
  },
  strategy: {
    barMinutes: 5,
    emaPeriod: 20,
    atrPeriod: 14,
    vwapEnabled: true,
    hvPeriod: 20,
    hvRankBuyMax: 0.35,
    hvRankSellMin: 0.70,
    hvRankRegimeKill: 0.90,
    hvRankRegimeKillConsecutiveDays: 2,
    vehicle: "debit_vertical" as "debit_vertical" | "long_option",
    targetDelta: 0.50,
    longOptionTargetDelta: 0.50,
    deltaBand: 0.10,
    minDTE: 0,
    maxDTE: 0,
    verticalWidthDollars: 5,
    premiumStopPct: 0.40,
    profitTargetPct: 0.60,
    longOptionPremiumStopPct: 0.40,
    longOptionProfitTargetPct: 1.00,
    sessionOpenHHMM: "09:30",
    sessionCloseHHMM: "15:45",
  },
} as const;

export type Config = typeof config;
