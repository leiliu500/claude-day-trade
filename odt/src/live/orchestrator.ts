import type { Bar, OptionContract, OptionOrder, Position, Vehicle } from "../types.js";
import { AlpacaStream } from "../data/alpaca-stream.js";
import { fetchAccount, fetchOptionSnapshots, fetchStockBars } from "../data/alpaca-rest.js";
import type { Strategy } from "../signal/strategy.js";
import { getStrategy, trendPullbackStrategy } from "../signal/strategy.js";
import { pickFromSnapshots, pickLongOptionFromSnapshots } from "../selector/strike-picker.js";
import { filterTradeable } from "../selector/chain-filter.js";
import {
  newAccountState,
  rollDay,
  recordClose,
  ensureSymbolDay,
  countOpenForSymbol,
} from "../risk/account.js";
import { pretradeGate, sizeOrder } from "../risk/limits.js";
import { newKillState, check as killCheck } from "../risk/kill-switch.js";
import { theoreticalDebit } from "../backtest/fills.js";
import { closePosition, evaluateExit, openPosition } from "../position/manager.js";
import type { ExitParams } from "../position/manager.js";
import type { StrikeParams } from "../selector/strike-picker.js";
import { hvAnnualizedFromDailyCloses, dailyClosesFromIntraday } from "../vol/hv.js";
import { LiveRouter } from "../exec/order-router.js";
import { config, exitParamsFor, resolveSymbolConfig, strategyParamsFor, strikeParamsFor } from "../config.js";
import type { SymbolConfig, ResolvedSymbolConfig } from "../config.js";
import { etDateKey, addBusinessDays, isRTH } from "../util/time.js";
import { logger } from "../util/logger.js";
import type { TrackingSink } from "../tracking/sink.js";
import { NoopSink } from "../tracking/sink.js";
import type { DailySummary } from "../tracking/types.js";

const log = logger("live");

export interface RunLiveParams {
  dryRun: boolean;
  symbols?: SymbolConfig[];
  symbol?: string;
  strategy?: Strategy;
  vehicle?: Vehicle;
  sink?: TrackingSink;
  sinkFactory?: (sym: ResolvedSymbolConfig) => TrackingSink;
}

interface SymbolContext {
  cfg: ResolvedSymbolConfig;
  strikeParams: StrikeParams;
  exitParams: ExitParams;
  strategy: Strategy;
  state: unknown;
  vehicle: Vehicle;
  sink: TrackingSink;
  barBuffer: Bar[];
  currentBucket: Bar | null;
  hv: number;
  positionMarkBucket: Map<string, number>;
  dayKey: string;
  dayEquityStart: number;
  dayEquityPeak: number;
  dayMaxDD: number;
  daySignalsTotal: number;
  daySignalsAccepted: number;
  dayWins: number;
  dayLosses: number;
  dayEntriesTotal: number;
}

function resolveSymbolList(params: RunLiveParams): SymbolConfig[] {
  if (params.symbols && params.symbols.length > 0) return params.symbols;
  if (params.symbol) {
    return [
      {
        symbol: params.symbol,
        strategy: params.strategy?.name,
        vehicle: params.vehicle,
      },
    ];
  }
  return config.symbols;
}

export async function runLive(params: RunLiveParams): Promise<void> {
  const symbolList = resolveSymbolList(params);
  if (symbolList.length === 0) throw new Error("runLive: no symbols configured");

  const acct = await fetchAccount();
  const equity = Number(acct.equity);
  log.info(`account equity: $${equity.toFixed(2)}`);

  const account = newAccountState(equity, etDateKey(Date.now()));
  const kill = newKillState();
  const router = new LiveRouter({ dryRun: params.dryRun });

  const contexts = new Map<string, SymbolContext>();
  const dayKey0 = account.today.dateKey;

  for (const sc of symbolList) {
    const cfg = resolveSymbolConfig(sc);
    const strategy =
      params.strategy && symbolList.length === 1
        ? params.strategy
        : sc.strategy
          ? getStrategy(sc.strategy)
          : trendPullbackStrategy;
    const vehicle: Vehicle = cfg.vehicle;

    const sink: TrackingSink =
      params.sink && symbolList.length === 1
        ? params.sink
        : params.sinkFactory
          ? params.sinkFactory(cfg)
          : new NoopSink({
              mode: "live",
              strategy: strategy.name,
              vehicle,
              symbol: cfg.symbol,
              startedAt: Date.now(),
            });
    await sink.init();

    const priorStart = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const todayISO = new Date().toISOString().slice(0, 10);
    const daily = await fetchStockBars(cfg.symbol, "1Day", priorStart, todayISO);
    const closes = dailyClosesFromIntraday(daily, (b) => etDateKey(b.t));
    const hv = hvAnnualizedFromDailyCloses(closes, cfg.hvPeriod);
    log.info(`[${cfg.symbol}] strategy=${strategy.name} vehicle=${vehicle} HV(20d)=${hv.toFixed(3)}`);

    ensureSymbolDay(account, cfg.symbol, dayKey0);

    contexts.set(cfg.symbol, {
      cfg,
      strikeParams: strikeParamsFor(cfg),
      exitParams: exitParamsFor(cfg),
      strategy,
      state: strategy.makeState(strategyParamsFor(cfg)),
      vehicle,
      sink,
      barBuffer: [],
      currentBucket: null,
      hv,
      positionMarkBucket: new Map(),
      dayKey: dayKey0,
      dayEquityStart: equity,
      dayEquityPeak: equity,
      dayMaxDD: 0,
      daySignalsTotal: 0,
      daySignalsAccepted: 0,
      dayWins: 0,
      dayLosses: 0,
      dayEntriesTotal: 0,
    });
  }

  const bucketMs = config.strategy.barMinutes * 60 * 1000;

  const emitDailyFor = async (ctx: SymbolContext): Promise<void> => {
    const symDay = account.perSymbolToday.get(ctx.cfg.symbol);
    const pnlRealized = symDay?.realized ?? 0;
    const summary: DailySummary = {
      kind: "daily",
      day: ctx.dayKey,
      mode: "live",
      strategy: ctx.strategy.name,
      vehicle: ctx.vehicle,
      symbol: ctx.cfg.symbol,
      equityStart: ctx.dayEquityStart,
      equityEnd: ctx.dayEquityStart + pnlRealized,
      pnlRealized,
      signalsTotal: ctx.daySignalsTotal,
      signalsAccepted: ctx.daySignalsAccepted,
      signalsBlocked: ctx.daySignalsTotal - ctx.daySignalsAccepted,
      entriesTotal: ctx.dayEntriesTotal,
      wins: ctx.dayWins,
      losses: ctx.dayLosses,
      maxDrawdown: ctx.dayMaxDD,
      killSwitchReason: kill.tripped ? kill.reason : undefined,
    };
    await ctx.sink.endOfDay(summary);
  };

  const rollDayIfNeeded = async (ctx: SymbolContext, now: number): Promise<void> => {
    const k = etDateKey(now);
    if (k === ctx.dayKey) return;
    await emitDailyFor(ctx);
    if (account.today.dateKey !== k) rollDay(account, k);
    else ensureSymbolDay(account, ctx.cfg.symbol, k);
    ctx.dayKey = k;
    ctx.dayEquityStart = account.equity;
    ctx.dayEquityPeak = account.equity;
    ctx.dayMaxDD = 0;
    ctx.daySignalsTotal = 0;
    ctx.daySignalsAccepted = 0;
    ctx.dayWins = 0;
    ctx.dayLosses = 0;
    ctx.dayEntriesTotal = 0;
    ctx.positionMarkBucket.clear();
  };

  const updateDrawdown = (ctx: SymbolContext): void => {
    if (account.equity > ctx.dayEquityPeak) ctx.dayEquityPeak = account.equity;
    const dd = ctx.dayEquityPeak - account.equity;
    if (dd > ctx.dayMaxDD) ctx.dayMaxDD = dd;
  };

  const maybeEmitMark = async (
    ctx: SymbolContext,
    pos: Position,
    theo: number,
    underlyingPx: number,
    now: number,
  ): Promise<void> => {
    const entry = pos.fill.filledDebit;
    if (entry <= 0) return;
    const pnlPct = (theo - entry) / entry;
    const bucket = pnlBucketOrZero(pnlPct);
    const last = ctx.positionMarkBucket.get(pos.id) ?? 0;
    const crossed = (bucket > 0 && bucket > last) || (bucket < 0 && bucket < last);
    if (!crossed) return;
    ctx.positionMarkBucket.set(pos.id, bucket);
    await ctx.sink.mark({
      kind: "mark",
      ts: now,
      day: etDateKey(now),
      mode: "live",
      positionId: pos.id,
      markDebit: theo,
      pnlPct,
      pnlDollars: (theo - entry) * 100 * pos.fill.order.qty,
      underlyingPx,
    });
  };

  const stream = new AlpacaStream();
  await stream.connect();
  stream.subscribeBars([...contexts.keys()]);
  log.info(`stream connected, subscribed bars for ${[...contexts.keys()].join(", ")}`);

  stream.onBar(async (sym, min1) => {
    const ctx = contexts.get(sym);
    if (!ctx) return;

    const bucketStart = Math.floor(min1.t / bucketMs) * bucketMs;
    if (!ctx.currentBucket || ctx.currentBucket.t !== bucketStart) {
      if (ctx.currentBucket) ctx.barBuffer.push(ctx.currentBucket);
      ctx.currentBucket = { t: bucketStart, o: min1.o, h: min1.h, l: min1.l, c: min1.c, v: min1.v };
    } else {
      ctx.currentBucket.h = Math.max(ctx.currentBucket.h, min1.h);
      ctx.currentBucket.l = Math.min(ctx.currentBucket.l, min1.l);
      ctx.currentBucket.c = min1.c;
      ctx.currentBucket.v += min1.v;
    }

    const now = min1.t;
    const dayKey = etDateKey(now);
    await rollDayIfNeeded(ctx, now);
    if (!isRTH(now)) return;

    for (const pos of account.openPositions) {
      if (pos.symbol !== sym) continue;
      const mark = theoreticalDebit({
        order: pos.fill.order,
        underlyingPx: min1.c,
        nowMs: now,
        sigma: ctx.hv,
      });
      pos.lastMarkDebit = mark;
      await maybeEmitMark(ctx, pos, mark, min1.c, now);
    }

    if (ctx.barBuffer.length === 0) return;
    const b = ctx.barBuffer[ctx.barBuffer.length - 1];
    const signal = ctx.strategy.onBar(ctx.state, b);
    killCheck(account, kill);

    for (const pos of [...account.openPositions]) {
      if (pos.symbol !== sym) continue;
      const mark = theoreticalDebit({
        order: pos.fill.order,
        underlyingPx: min1.c,
        nowMs: now,
        sigma: ctx.hv,
      });
      pos.lastMarkDebit = mark;
      const invalidated = ctx.strategy.underlyingInvalidated(ctx.state, pos.fill.order.side);
      const exitRule = evaluateExit(
        pos,
        {
          now,
          underlyingPx: min1.c,
          markDebit: mark,
          underlyingInvalidated: invalidated,
          killTripped: kill.tripped,
        },
        ctx.exitParams,
      );
      if (!exitRule) continue;

      const legCount = pos.fill.order.kind === "debit_vertical" ? 2 : 1;
      const fallbackFees = config.execution.feePerContract * legCount * pos.fill.order.qty;

      let closeFill = await router.submitClose(pos.fill.order, mark, now);
      if (!closeFill && exitRule === "time") {
        log.warn(`[${sym}] time-exit limit-close failed for ${pos.id}; retrying with market order`);
        closeFill = await router.submitClose(pos.fill.order, mark, now, { useMarket: true });
      }

      let exitDebit = mark;
      let fees = fallbackFees;
      let closedOnBroker = false;
      if (closeFill) {
        exitDebit = closeFill.filledDebit;
        fees = closeFill.fees;
        closedOnBroker = true;
        log.info(
          `[${sym}] closed ${pos.id} via ${exitRule} @ $${closeFill.filledDebit.toFixed(2)} (broker-confirmed)`,
        );
      } else {
        log.error(
          `[${sym}] CLOSE FAILED for ${pos.id} via ${exitRule} — broker may still hold position. Using theo $${mark.toFixed(2)}. MANUAL RECONCILIATION NEEDED.`,
        );
      }

      closePosition(pos, exitRule, exitDebit, fees, now);
      account.openPositions = account.openPositions.filter((p) => p.id !== pos.id);
      recordClose(account, pos);
      if ((pos.pnlDollars ?? 0) >= 0) ctx.dayWins++;
      else ctx.dayLosses++;
      updateDrawdown(ctx);
      if (closedOnBroker) {
        log.info(`[${sym}] ${pos.id} pnl=$${(pos.pnlDollars ?? 0).toFixed(2)}`);
      }
      await ctx.sink.close({
        kind: "close",
        ts: now,
        day: dayKey,
        mode: "live",
        positionId: pos.id,
        exitRule,
        exitDebit,
        pnlDollars: pos.pnlDollars ?? 0,
        holdMinutes: Math.round((now - pos.opened) / 60_000),
      });
      ctx.positionMarkBucket.delete(pos.id);
    }

    if (!signal || signal.side === "FLAT") return;
    ctx.daySignalsTotal++;

    const recordBlocked = async (reason: string): Promise<void> => {
      await ctx.sink.signal({
        kind: "signal",
        ts: signal.ts,
        day: dayKey,
        mode: "live",
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
      return;
    }

    if (countOpenForSymbol(account, sym) >= ctx.cfg.maxConcurrent) {
      await recordBlocked("symbol-max-concurrent");
      return;
    }

    const expiryISO = addBusinessDays(
      dayKey,
      Math.round((config.strategy.minDTE + config.strategy.maxDTE) / 2),
    );
    const snaps = await fetchOptionSnapshots(sym, {
      expiration: expiryISO,
      type: signal.side === "LONG" ? "call" : "put",
      strikeMin: signal.entryPrice * 0.95,
      strikeMax: signal.entryPrice * 1.05,
    });
    const chain: OptionContract[] = snaps
      .filter((s) => s.latestQuote && s.greeks)
      .map((s) => {
        const m = s.symbol.match(/(\d{6})([CP])(\d{8})$/);
        const strike = m ? Number(m[3]) / 1000 : 0;
        return {
          symbol: s.symbol,
          underlying: sym,
          strike,
          expiry: expiryISO,
          type: (m ? m[2] : "C") as "C" | "P",
          delta: s.greeks?.delta ?? 0,
          bid: s.latestQuote?.bp ?? 0,
          ask: s.latestQuote?.ap ?? 0,
          oi: s.openInterest ?? 0,
          volume: 0,
        };
      });
    const filtered = filterTradeable(chain);
    const order: OptionOrder | null =
      ctx.vehicle === "long_option"
        ? pickLongOptionFromSnapshots(filtered.passed, signal.side, signal, ctx.strikeParams)
        : pickFromSnapshots(filtered.passed, signal.side, signal, ctx.strikeParams);

    if (!order) {
      log.warn(`[${sym}] no tradeable ${ctx.vehicle} from snapshots`, filtered.stats);
      await recordBlocked("no-tradeable-chain");
      return;
    }

    const size = sizeOrder(order, account, {
      longOptionStopPct: ctx.cfg.longOptionPremiumStopPct,
    });
    if (size.qty === 0) {
      log.warn(`[${sym}] sizing blocked: ${size.reason}`);
      await recordBlocked(size.reason);
      return;
    }
    order.qty = size.qty;
    const gate = pretradeGate(account, size.perContractRisk * size.qty, {
      symbol: sym,
      symbolMaxConcurrent: ctx.cfg.maxConcurrent,
      symbolLossStreakLockout: ctx.cfg.lossStreakLockout,
    });
    if (!gate.ok) {
      log.warn(`[${sym}] gate blocked: ${gate.reason}`);
      await recordBlocked(gate.reason ?? "gate");
      return;
    }
    const fill = await router.submit(order, now);
    if (!fill) {
      await recordBlocked("fill-failed");
      return;
    }
    const pos = openPosition(fill, now);
    account.openPositions.push(pos);
    ctx.daySignalsAccepted++;
    ctx.dayEntriesTotal++;
    const legDesc =
      order.kind === "debit_vertical"
        ? `${order.long.symbol}/${order.short.symbol}`
        : order.leg.symbol;
    log.info(`[${sym}] opened ${order.side} ${legDesc} qty=${order.qty}`);
    await ctx.sink.signal({
      kind: "signal",
      ts: signal.ts,
      day: dayKey,
      mode: "live",
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
    await ctx.sink.open({
      kind: "open",
      ts: now,
      day: dayKey,
      mode: "live",
      positionId: pos.id,
      orderKind: order.kind,
      side: order.side,
      symbols,
      qty: order.qty,
      filledDebit: fill.filledDebit,
      fees: fill.fees,
      entryUnderlying: signal.entryPrice,
      signalTs: signal.ts,
    });
  });

  stream.onTradeUpdate((ev) => {
    log.debug("trade update", ev.event);
  });

  const hb = setInterval(() => {
    const perSym = [...contexts.keys()]
      .map((s) => `${s}:${countOpenForSymbol(account, s)}`)
      .join(" ");
    log.info(
      `hb: equity=$${account.equity.toFixed(2)} open=${account.openPositions.length} [${perSym}] kill=${kill.tripped ? kill.reason : "off"}`,
    );
  }, 60_000);

  const shutdown = async () => {
    clearInterval(hb);
    await router.cancelAll();
    stream.disconnect();
    for (const ctx of contexts.values()) {
      await emitDailyFor(ctx);
      await ctx.sink.shutdown();
    }
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
