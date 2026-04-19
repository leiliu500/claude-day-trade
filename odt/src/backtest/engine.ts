import type { Bar, Position, Signal, Vehicle } from "../types.js";
import { fetchStockBars } from "../data/alpaca-rest.js";
import type { Strategy } from "../signal/strategy.js";
import { trendPullbackStrategy } from "../signal/strategy.js";
import { pickSyntheticVertical, pickSyntheticLongOption } from "../selector/strike-picker.js";
import { newAccountState, rollDay, recordClose } from "../risk/account.js";
import { pretradeGate, sizeOrder } from "../risk/limits.js";
import {
  newKillState,
  check as killCheck,
  reset as killReset,
  trip as killTrip,
  shouldKillForRegime,
} from "../risk/kill-switch.js";
import { simulateEntryFill, simulateExitFill, theoreticalDebit } from "./fills.js";
import { closePosition, evaluateExit, openPosition } from "../position/manager.js";
import { hvAnnualizedFromDailyCloses, dailyClosesFromIntraday } from "../vol/hv.js";
import { rankWithin } from "../vol/iv-rank.js";
import { etDateKey, etMinutesSinceMidnight } from "../util/time.js";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger("backtest");

export interface BacktestInputs {
  symbol: string;
  startISO: string;
  endISO: string;
  initialEquity?: number;
  strategy?: Strategy;
  vehicle?: Vehicle;
}

export interface BacktestResult {
  symbol: string;
  startISO: string;
  endISO: string;
  finalEquity: number;
  closedPositions: Position[];
  signalsEmitted: Signal[];
  signalsBlocked: Array<{ signal: Signal; reason: string }>;
}

function aggregate(bars: Bar[], minutes: number): Bar[] {
  if (bars.length === 0) return [];
  const out: Bar[] = [];
  const bucketMs = minutes * 60 * 1000;
  let cur: Bar | null = null;
  let bucketStart = 0;
  for (const b of bars) {
    const bs = Math.floor(b.t / bucketMs) * bucketMs;
    if (!cur || bs !== bucketStart) {
      if (cur) out.push(cur);
      bucketStart = bs;
      cur = { t: bs, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function runBacktest(inp: BacktestInputs): Promise<BacktestResult> {
  const priorStart = new Date(new Date(inp.startISO).getTime() - 40 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  log.info(`loading bars ${priorStart} → ${inp.endISO} for ${inp.symbol}`);
  const min1 = await fetchStockBars(inp.symbol, "1Min", priorStart, inp.endISO);
  const min5All = aggregate(min1, config.strategy.barMinutes);
  const daily = await fetchStockBars(inp.symbol, "1Day", priorStart, inp.endISO);
  log.info(`loaded ${min1.length} 1m bars, ${min5All.length} ${config.strategy.barMinutes}m bars, ${daily.length} daily bars`);

  const strategy = inp.strategy ?? trendPullbackStrategy;
  const vehicle: Vehicle = inp.vehicle ?? config.strategy.vehicle;
  log.info(`strategy: ${strategy.name}, vehicle: ${vehicle}`);
  const account = newAccountState(inp.initialEquity ?? config.risk.accountEquityFallback, etDateKey(new Date(inp.startISO).getTime()));
  const kill = newKillState();
  const state = strategy.makeState();
  const closed: Position[] = [];
  const signals: Signal[] = [];
  const blocked: Array<{ signal: Signal; reason: string }> = [];
  const hvWindow: number[] = [];
  const dailyRankHistory: number[] = [];

  const startMs = new Date(inp.startISO + "T00:00:00Z").getTime();
  const endMs = new Date(inp.endISO + "T23:59:59Z").getTime();

  const relevantBars = min5All.filter((b) => b.t >= new Date(priorStart + "T00:00:00Z").getTime() && b.t <= endMs);

  let lastDay = "";
  for (const b of relevantBars) {
    const dayKey = etDateKey(b.t);
    if (b.t < startMs) {
      strategy.onBar(state, b);
      continue;
    }

    if (dayKey !== lastDay) {
      rollDay(account, dayKey);
      killReset(kill);
      lastDay = dayKey;
      const priorClosures = dailyClosesFromIntraday(
        min5All.filter((x) => x.t < b.t),
        (x) => etDateKey(x.t),
      );
      const hv = hvAnnualizedFromDailyCloses(priorClosures, config.strategy.hvPeriod);
      if (isFinite(hv)) {
        hvWindow.push(hv);
        if (hvWindow.length > 60) hvWindow.shift();
        if (hvWindow.length >= 10) {
          const rank = rankWithin(hv, hvWindow);
          dailyRankHistory.push(rank);
          if (dailyRankHistory.length > 30) dailyRankHistory.shift();
          if (
            shouldKillForRegime(
              dailyRankHistory,
              config.strategy.hvRankRegimeKill,
              config.strategy.hvRankRegimeKillConsecutiveDays,
            )
          ) {
            killTrip(kill, "regime");
          }
        }
      }
    }

    const signal: Signal | null = strategy.onBar(state, b);
    killCheck(account, kill);

    for (const pos of [...account.openPositions]) {
      const sigma = currentSigma(hvWindow);
      const theo = theoreticalDebit({ order: pos.fill.order, underlyingPx: b.c, nowMs: b.t, sigma });
      pos.lastMarkDebit = theo;
      const invalidated = strategy.underlyingInvalidated(state, pos.fill.order.side);
      const exitRule = evaluateExit(pos, {
        now: b.t,
        underlyingPx: b.c,
        markDebit: theo,
        underlyingInvalidated: invalidated,
        killTripped: kill.tripped,
      });
      if (exitRule) {
        const exit = simulateExitFill(pos.fill.order, theo);
        closePosition(pos, exitRule, exit.debit, exit.fees, b.t);
        account.openPositions = account.openPositions.filter((p) => p.id !== pos.id);
        recordClose(account, pos);
        closed.push(pos);
      }
    }

    if (signal && signal.side !== "FLAT") {
      signals.push(signal);
      if (kill.tripped) {
        blocked.push({ signal, reason: `kill:${kill.reason}` });
        continue;
      }
      const sigma = currentSigma(hvWindow);
      if (!isFinite(sigma)) {
        blocked.push({ signal, reason: "hv-not-ready" });
        continue;
      }
      const hvRank = hvWindow.length >= 10 ? rankWithin(sigma, hvWindow) : 0.5;
      if (hvRank > config.strategy.hvRankSellMin) {
        blocked.push({ signal, reason: `hv-rank-too-high:${hvRank.toFixed(2)}` });
        continue;
      }
      const pickerCtx = {
        underlying: inp.symbol,
        underlyingPx: signal.entryPrice,
        hvAnnualized: sigma,
        asOfDateISO: dayKey,
        asOfMs: signal.ts,
        strikeStep: 1,
      };
      const order =
        vehicle === "long_option"
          ? pickSyntheticLongOption(pickerCtx, signal.side, signal)
          : pickSyntheticVertical(pickerCtx, signal.side, signal);
      const size = sizeOrder(order, account);
      if (size.qty === 0) {
        blocked.push({ signal, reason: size.reason });
        continue;
      }
      order.qty = size.qty;
      const gate = pretradeGate(account, size.perContractRisk * size.qty);
      if (!gate.ok) {
        blocked.push({ signal, reason: gate.reason ?? "gate" });
        continue;
      }
      const theo = theoreticalDebit({ order, underlyingPx: signal.entryPrice, nowMs: b.t, sigma });
      const fill = simulateEntryFill(order, theo, b.t);
      if (!fill) {
        blocked.push({ signal, reason: "fill-rejected-spread" });
        continue;
      }
      account.openPositions.push(openPosition(fill, b.t));
    }

    const mins = etMinutesSinceMidnight(b.t);
    if (mins >= 16 * 60 - 5) {
      for (const pos of [...account.openPositions]) {
        const sigma = currentSigma(hvWindow);
        const theo = theoreticalDebit({ order: pos.fill.order, underlyingPx: b.c, nowMs: b.t, sigma });
        const exit = simulateExitFill(pos.fill.order, theo);
        closePosition(pos, "time", exit.debit, exit.fees, b.t);
        account.openPositions = account.openPositions.filter((p) => p.id !== pos.id);
        recordClose(account, pos);
        closed.push(pos);
      }
    }
  }

  return {
    symbol: inp.symbol,
    startISO: inp.startISO,
    endISO: inp.endISO,
    finalEquity: account.equity,
    closedPositions: closed,
    signalsEmitted: signals,
    signalsBlocked: blocked,
  };
}

function currentSigma(window: number[]): number {
  if (window.length === 0) return NaN;
  return window[window.length - 1];
}
