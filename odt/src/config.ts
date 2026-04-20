import { loadEnv } from "./util/env.js";
import type { Vehicle } from "./types.js";
loadEnv();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export interface SymbolConfig {
  symbol: string;
  strategy?: string;
  vehicle?: Vehicle;
  targetDelta?: number;
  longOptionTargetDelta?: number;
  deltaBand?: number;
  verticalWidthDollars?: number;
  premiumStopPct?: number;
  profitTargetPct?: number;
  longOptionPremiumStopPct?: number;
  longOptionProfitTargetPct?: number;
  maxConcurrent?: number;
  lossStreakLockout?: number;
  emaPeriod?: number;
  atrPeriod?: number;
  hvPeriod?: number;
  hvRankBuyMax?: number;
  hvRankSellMin?: number;
  hvRankRegimeKill?: number;
  hvRankRegimeKillConsecutiveDays?: number;
}

function parseSymbolsEnv(): SymbolConfig[] | null {
  const raw = process.env.ODT_SYMBOLS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as SymbolConfig[];
  } catch {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((symbol) => ({ symbol }));
  }
}

const defaultSymbols: SymbolConfig[] = [
  { symbol: "SPY", strategy: "orb-filtered", vehicle: "long_option", maxConcurrent: 1 },
  {
    symbol: "QQQ",
    strategy: "trend-pullback",
    vehicle: "long_option",
    maxConcurrent: 1,
    longOptionPremiumStopPct: 0.30,
    atrPeriod: 20,
  },
];

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
    vehicle: "debit_vertical" as Vehicle,
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
  symbols: parseSymbolsEnv() ?? defaultSymbols,
};

export type Config = typeof config;

export function resolveSymbolConfig(sc: SymbolConfig): Required<Omit<SymbolConfig, "symbol" | "strategy" | "vehicle">> & {
  symbol: string;
  strategy: string;
  vehicle: Vehicle;
} {
  return {
    symbol: sc.symbol,
    strategy: sc.strategy ?? "trend-pullback",
    vehicle: sc.vehicle ?? config.strategy.vehicle,
    targetDelta: sc.targetDelta ?? config.strategy.targetDelta,
    longOptionTargetDelta: sc.longOptionTargetDelta ?? config.strategy.longOptionTargetDelta,
    deltaBand: sc.deltaBand ?? config.strategy.deltaBand,
    verticalWidthDollars: sc.verticalWidthDollars ?? config.strategy.verticalWidthDollars,
    premiumStopPct: sc.premiumStopPct ?? config.strategy.premiumStopPct,
    profitTargetPct: sc.profitTargetPct ?? config.strategy.profitTargetPct,
    longOptionPremiumStopPct: sc.longOptionPremiumStopPct ?? config.strategy.longOptionPremiumStopPct,
    longOptionProfitTargetPct: sc.longOptionProfitTargetPct ?? config.strategy.longOptionProfitTargetPct,
    maxConcurrent: sc.maxConcurrent ?? 1,
    lossStreakLockout: sc.lossStreakLockout ?? config.risk.lossStreakLockout,
    emaPeriod: sc.emaPeriod ?? config.strategy.emaPeriod,
    atrPeriod: sc.atrPeriod ?? config.strategy.atrPeriod,
    hvPeriod: sc.hvPeriod ?? config.strategy.hvPeriod,
    hvRankBuyMax: sc.hvRankBuyMax ?? config.strategy.hvRankBuyMax,
    hvRankSellMin: sc.hvRankSellMin ?? config.strategy.hvRankSellMin,
    hvRankRegimeKill: sc.hvRankRegimeKill ?? config.strategy.hvRankRegimeKill,
    hvRankRegimeKillConsecutiveDays:
      sc.hvRankRegimeKillConsecutiveDays ?? config.strategy.hvRankRegimeKillConsecutiveDays,
  };
}

export type ResolvedSymbolConfig = ReturnType<typeof resolveSymbolConfig>;

export function strikeParamsFor(rc: ResolvedSymbolConfig) {
  return {
    targetDelta: rc.targetDelta,
    longOptionTargetDelta: rc.longOptionTargetDelta,
    deltaBand: rc.deltaBand,
    verticalWidthDollars: rc.verticalWidthDollars,
    minDTE: config.strategy.minDTE,
    maxDTE: config.strategy.maxDTE,
  };
}

export interface StrategyParams {
  emaPeriod: number;
  atrPeriod: number;
}

export function strategyParamsFor(rc: ResolvedSymbolConfig): StrategyParams {
  return {
    emaPeriod: rc.emaPeriod,
    atrPeriod: rc.atrPeriod,
  };
}

export function defaultStrategyParams(): StrategyParams {
  return {
    emaPeriod: config.strategy.emaPeriod,
    atrPeriod: config.strategy.atrPeriod,
  };
}

export function exitParamsFor(rc: ResolvedSymbolConfig) {
  return {
    premiumStopPct: rc.premiumStopPct,
    profitTargetPct: rc.profitTargetPct,
    longOptionPremiumStopPct: rc.longOptionPremiumStopPct,
    longOptionProfitTargetPct: rc.longOptionProfitTargetPct,
    sessionCloseHHMM: config.strategy.sessionCloseHHMM,
  };
}
