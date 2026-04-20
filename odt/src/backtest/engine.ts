import type { Bar, Position, Signal, Vehicle } from "../types.js";
import { fetchStockBars } from "../data/alpaca-rest.js";
import type { Strategy } from "../signal/strategy.js";
import { getStrategy, trendPullbackStrategy } from "../signal/strategy.js";
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
import {
  config,
  exitParamsFor,
  resolveSymbolConfig,
  strategyParamsFor,
  strikeParamsFor,
} from "../config.js";
import { logger } from "../util/logger.js";
import type { TrackingSink } from "../tracking/sink.js";
import { NoopSink } from "../tracking/sink.js";
import type { DailySummary, OpenEvent } from "../tracking/types.js";

const log = logger("backtest");

export interface BacktestInputs {
  symbol: string;
  startISO: string;
  endISO: string;
  initialEquity?: number;
  strategy?: Strategy;
  vehicle?: Vehicle;
  sink?: TrackingSink;
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

  const preset = config.symbols.find((c) => c.symbol === inp.symbol);
  const resolved = resolveSymbolConfig(preset ?? { symbol: inp.symbol });
  const strategy =
    inp.strategy ?? (preset?.strategy ? getStrategy(resolved.strategy) : trendPullbackStrategy);
  const vehicle: Vehicle = inp.vehicle ?? resolved.vehicle;
  const strikeParams = strikeParamsFor({ ...resolved, vehicle });
  const exitParams = exitParamsFor({ ...resolved, vehicle });
  log.info(`strategy: ${strategy.name}, vehicle: ${vehicle}`);
  const sink: TrackingSink = inp.sink ?? new NoopSink({
    mode: "backtest",
    strategy: strategy.name,
    vehicle,
    symbol: inp.symbol,
    startedAt: Date.now(),
    foldWindow: { start: inp.startISO, end: inp.endISO },
  });
  const initialEquity = inp.initialEquity ?? config.risk.accountEquityFallback;
  const account = newAccountState(initialEquity, etDateKey(new Date(inp.startISO).getTime()));
  const kill = newKillState();
  const state = strategy.makeState(strategyParamsFor({ ...resolved, vehicle }));
  const closed: Position[] = [];
  const signals: Signal[] = [];
  const blocked: Array<{ signal: Signal; reason: string }> = [];
  const hvWindow: number[] = [];
  const dailyRankHistory: number[] = [];

  let dayEquityStart = initialEquity;
  let dayEquityPeak = initialEquity;
  let dayMaxDD = 0;
  let daySignalsTotal = 0;
  let daySignalsAccepted = 0;
  let dayWins = 0;
  let dayLosses = 0;
  let dayEntriesTotal = 0;

  const emitEndOfDay = async (day: string): Promise<void> => {
    if (!day) return;
    const summary: DailySummary = {
      kind: "daily",
      day,
      mode: "backtest",
      strategy: strategy.name,
      vehicle,
      symbol: inp.symbol,
      equityStart: dayEquityStart,
      equityEnd: account.equity,
      pnlRealized: account.equity - dayEquityStart,
      signalsTotal: daySignalsTotal,
      signalsAccepted: daySignalsAccepted,
      signalsBlocked: daySignalsTotal - daySignalsAccepted,
      entriesTotal: dayEntriesTotal,
      wins: dayWins,
      losses: dayLosses,
      maxDrawdown: dayMaxDD,
      killSwitchReason: kill.tripped ? kill.reason : undefined,
    };
    await sink.endOfDay(summary);
  };

  const positionMarkBucket = new Map<string, number>();

  const emitMarkIfBucketCrossed = async (
    pos: { id: string; fill: { filledDebit: number; order: { qty: number } } },
    theo: number,
    underlyingPx: number,
    now: number,
  ): Promise<void> => {
    const entry = pos.fill.filledDebit;
    if (entry <= 0) return;
    const pnlPct = (theo - entry) / entry;
    const bucket = pnlBucketOrZero(pnlPct);
    const last = positionMarkBucket.get(pos.id) ?? 0;
    const crossed =
      (bucket > 0 && bucket > last) || (bucket < 0 && bucket < last);
    if (!crossed) return;
    positionMarkBucket.set(pos.id, bucket);
    await sink.mark({
      kind: "mark",
      ts: now,
      day: etDateKey(now),
      mode: "backtest",
      positionId: pos.id,
      markDebit: theo,
      pnlPct,
      pnlDollars: (theo - entry) * 100 * pos.fill.order.qty,
      underlyingPx,
    });
  };

  const resetDayCounters = (): void => {
    dayEquityStart = account.equity;
    dayEquityPeak = account.equity;
    dayMaxDD = 0;
    daySignalsTotal = 0;
    daySignalsAccepted = 0;
    dayWins = 0;
    dayLosses = 0;
    dayEntriesTotal = 0;
  };

  const updateDrawdown = (): void => {
    if (account.equity > dayEquityPeak) dayEquityPeak = account.equity;
    const dd = dayEquityPeak - account.equity;
    if (dd > dayMaxDD) dayMaxDD = dd;
  };

  const startMs = new Date(inp.startISO + "T00:00:00Z").getTime();
  const endMs = new Date(inp.endISO + "T23:59:59Z").getTime();

  const relevantBars = min5All.filter((b) => b.t >= new Date(priorStart + "T00:00:00Z").getTime() && b.t <= endMs);

  await sink.init();
  let lastDay = "";
  for (const b of relevantBars) {
    const dayKey = etDateKey(b.t);
    if (b.t < startMs) {
      strategy.onBar(state, b);
      continue;
    }

    if (dayKey !== lastDay) {
      if (lastDay) await emitEndOfDay(lastDay);
      rollDay(account, dayKey);
      killReset(kill);
      lastDay = dayKey;
      resetDayCounters();
      const priorClosures = dailyClosesFromIntraday(
        min5All.filter((x) => x.t < b.t),
        (x) => etDateKey(x.t),
      );
      const hv = hvAnnualizedFromDailyCloses(priorClosures, resolved.hvPeriod);
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
              resolved.hvRankRegimeKill,
              resolved.hvRankRegimeKillConsecutiveDays,
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
      await emitMarkIfBucketCrossed(pos, theo, b.c, b.t);
      const invalidated = strategy.underlyingInvalidated(state, pos.fill.order.side);
      const exitRule = evaluateExit(
        pos,
        {
          now: b.t,
          underlyingPx: b.c,
          markDebit: theo,
          underlyingInvalidated: invalidated,
          killTripped: kill.tripped,
        },
        exitParams,
      );
      if (exitRule) {
        const exit = simulateExitFill(pos.fill.order, theo);
        closePosition(pos, exitRule, exit.debit, exit.fees, b.t);
        account.openPositions = account.openPositions.filter((p) => p.id !== pos.id);
        recordClose(account, pos);
        closed.push(pos);
        if ((pos.pnlDollars ?? 0) >= 0) dayWins++;
        else dayLosses++;
        updateDrawdown();
        await sink.close({
          kind: "close",
          ts: b.t,
          day: dayKey,
          mode: "backtest",
          positionId: pos.id,
          exitRule,
          exitDebit: exit.debit,
          pnlDollars: pos.pnlDollars ?? 0,
          holdMinutes: Math.round(((pos.closedTs ?? b.t) - pos.opened) / 60_000),
        });
        positionMarkBucket.delete(pos.id);
      }
    }

    if (signal && signal.side !== "FLAT") {
      signals.push(signal);
      daySignalsTotal++;

      const recordBlocked = async (reason: string): Promise<void> => {
        blocked.push({ signal, reason });
        await sink.signal({
          kind: "signal",
          ts: signal.ts,
          day: dayKey,
          mode: "backtest",
          side: signal.side,
          reason: signal.reason,
          atr: signal.atr,
          entryPrice: signal.entryPrice,
          accepted: false,
          blockReason: reason,
        });
      };

      if (kill.tripped) {
        await recordBlocked(`kill:${kill.reason}`);
      } else {
        const sigma = currentSigma(hvWindow);
        if (!isFinite(sigma)) {
          await recordBlocked("hv-not-ready");
        } else {
          const hvRank = hvWindow.length >= 10 ? rankWithin(sigma, hvWindow) : 0.5;
          if (hvRank > resolved.hvRankSellMin) {
            await recordBlocked(`hv-rank-too-high:${hvRank.toFixed(2)}`);
          } else {
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
                ? pickSyntheticLongOption(pickerCtx, signal.side, signal, strikeParams)
                : pickSyntheticVertical(pickerCtx, signal.side, signal, strikeParams);
            const size = sizeOrder(order, account, {
              longOptionStopPct: resolved.longOptionPremiumStopPct,
            });
            if (size.qty === 0) {
              await recordBlocked(size.reason);
            } else {
              order.qty = size.qty;
              const gate = pretradeGate(account, size.perContractRisk * size.qty, {
                symbol: inp.symbol,
                symbolMaxConcurrent: resolved.maxConcurrent,
                symbolLossStreakLockout: resolved.lossStreakLockout,
              });
              if (!gate.ok) {
                await recordBlocked(gate.reason ?? "gate");
              } else {
                const theo = theoreticalDebit({ order, underlyingPx: signal.entryPrice, nowMs: b.t, sigma });
                const fill = simulateEntryFill(order, theo, b.t);
                if (!fill) {
                  await recordBlocked("fill-rejected-spread");
                } else {
                  const pos = openPosition(fill, b.t);
                  account.openPositions.push(pos);
                  daySignalsAccepted++;
                  dayEntriesTotal++;
                  await sink.signal({
                    kind: "signal",
                    ts: signal.ts,
                    day: dayKey,
                    mode: "backtest",
                    side: signal.side,
                    reason: signal.reason,
                    atr: signal.atr,
                    entryPrice: signal.entryPrice,
                    accepted: true,
                  });
                  const symbols =
                    order.kind === "debit_vertical"
                      ? [order.long.symbol, order.short.symbol]
                      : [order.leg.symbol];
                  const openEv: OpenEvent = {
                    kind: "open",
                    ts: b.t,
                    day: dayKey,
                    mode: "backtest",
                    positionId: pos.id,
                    orderKind: order.kind,
                    side: order.side,
                    symbols,
                    qty: order.qty,
                    filledDebit: fill.filledDebit,
                    fees: fill.fees,
                    entryUnderlying: signal.entryPrice,
                    signalTs: signal.ts,
                  };
                  await sink.open(openEv);
                }
              }
            }
          }
        }
      }
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
        if ((pos.pnlDollars ?? 0) >= 0) dayWins++;
        else dayLosses++;
        updateDrawdown();
        await sink.close({
          kind: "close",
          ts: b.t,
          day: dayKey,
          mode: "backtest",
          positionId: pos.id,
          exitRule: "time",
          exitDebit: exit.debit,
          pnlDollars: pos.pnlDollars ?? 0,
          holdMinutes: Math.round((b.t - pos.opened) / 60_000),
        });
        positionMarkBucket.delete(pos.id);
      }
    }
  }

  if (lastDay) await emitEndOfDay(lastDay);
  await sink.shutdown();

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

const PNL_BUCKETS = [-75, -50, -25, 25, 50, 75, 100, 150, 200] as const;

function pnlBucketOrZero(pctMove: number): number {
  const pct = pctMove * 100;
  let best = 0;
  for (const b of PNL_BUCKETS) {
    if (b > 0 && pct >= b && b > best) best = b;
    else if (b < 0 && pct <= b && b < best) best = b;
  }
  return best;
}
