import type { Bar, OptionContract, OptionOrder, Vehicle } from "../types.js";
import { AlpacaStream } from "../data/alpaca-stream.js";
import { fetchAccount, fetchOptionSnapshots, fetchStockBars } from "../data/alpaca-rest.js";
import type { Strategy } from "../signal/strategy.js";
import { trendPullbackStrategy } from "../signal/strategy.js";
import { pickFromSnapshots, pickLongOptionFromSnapshots } from "../selector/strike-picker.js";
import { filterTradeable } from "../selector/chain-filter.js";
import { newAccountState, rollDay, recordClose } from "../risk/account.js";
import { pretradeGate, sizeOrder } from "../risk/limits.js";
import { newKillState, check as killCheck } from "../risk/kill-switch.js";
import { theoreticalDebit } from "../backtest/fills.js";
import { closePosition, evaluateExit, openPosition } from "../position/manager.js";
import { hvAnnualizedFromDailyCloses, dailyClosesFromIntraday } from "../vol/hv.js";
import { LiveRouter } from "../exec/order-router.js";
import { config } from "../config.js";
import { etDateKey, addBusinessDays, isRTH } from "../util/time.js";
import { logger } from "../util/logger.js";
import type { TrackingSink } from "../tracking/sink.js";
import { NoopSink } from "../tracking/sink.js";
import type { DailySummary } from "../tracking/types.js";

const log = logger("live");

export async function runLive(params: {
  symbol: string;
  dryRun: boolean;
  strategy?: Strategy;
  vehicle?: Vehicle;
  sink?: TrackingSink;
}): Promise<void> {
  const strategy = params.strategy ?? trendPullbackStrategy;
  const vehicle: Vehicle = params.vehicle ?? config.strategy.vehicle;

  const acct = await fetchAccount();
  const equity = Number(acct.equity);
  log.info(`account equity: $${equity.toFixed(2)}`);
  log.info(`strategy=${strategy.name} vehicle=${vehicle} dryRun=${params.dryRun}`);

  const sink: TrackingSink = params.sink ?? new NoopSink({
    mode: "live",
    strategy: strategy.name,
    vehicle,
    symbol: params.symbol,
    startedAt: Date.now(),
  });
  await sink.init();

  const state = strategy.makeState();
  const account = newAccountState(equity, etDateKey(Date.now()));
  const kill = newKillState();
  const router = new LiveRouter({ dryRun: params.dryRun });

  let dayEquityStart = equity;
  let dayEquityPeak = equity;
  let dayMaxDD = 0;
  let daySignalsTotal = 0;
  let daySignalsAccepted = 0;
  let dayWins = 0;
  let dayLosses = 0;
  let dayEntriesTotal = 0;
  let currentDayKey = account.today.dateKey;
  const positionMarkBucket = new Map<string, number>();

  const emitDaily = async (): Promise<void> => {
    const summary: DailySummary = {
      kind: "daily",
      day: currentDayKey,
      mode: "live",
      strategy: strategy.name,
      vehicle,
      symbol: params.symbol,
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

  const rollDayIfNeeded = async (now: number): Promise<void> => {
    const k = etDateKey(now);
    if (k === currentDayKey) return;
    await emitDaily();
    rollDay(account, k);
    currentDayKey = k;
    dayEquityStart = account.equity;
    dayEquityPeak = account.equity;
    dayMaxDD = 0;
    daySignalsTotal = 0;
    daySignalsAccepted = 0;
    dayWins = 0;
    dayLosses = 0;
    dayEntriesTotal = 0;
    positionMarkBucket.clear();
  };

  const updateDrawdown = (): void => {
    if (account.equity > dayEquityPeak) dayEquityPeak = account.equity;
    const dd = dayEquityPeak - account.equity;
    if (dd > dayMaxDD) dayMaxDD = dd;
  };

  const maybeEmitMark = async (
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
    const crossed = (bucket > 0 && bucket > last) || (bucket < 0 && bucket < last);
    if (!crossed) return;
    positionMarkBucket.set(pos.id, bucket);
    await sink.mark({
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

  const priorStart = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayISO = new Date().toISOString().slice(0, 10);
  const daily = await fetchStockBars(params.symbol, "1Day", priorStart, todayISO);
  const closes = dailyClosesFromIntraday(daily, (b) => etDateKey(b.t));
  const hv = hvAnnualizedFromDailyCloses(closes, config.strategy.hvPeriod);
  log.info(`HV(20d) = ${hv.toFixed(3)}`);

  const stream = new AlpacaStream();
  await stream.connect();
  stream.subscribeBars([params.symbol]);
  log.info("stream connected, subscribed bars");

  const barBuffer: Bar[] = [];
  let currentBucket: Bar | null = null;
  const bucketMs = config.strategy.barMinutes * 60 * 1000;

  stream.onBar(async (sym, min1) => {
    if (sym !== params.symbol) return;
    const bucketStart = Math.floor(min1.t / bucketMs) * bucketMs;
    if (!currentBucket || currentBucket.t !== bucketStart) {
      if (currentBucket) barBuffer.push(currentBucket);
      currentBucket = { t: bucketStart, o: min1.o, h: min1.h, l: min1.l, c: min1.c, v: min1.v };
    } else {
      currentBucket.h = Math.max(currentBucket.h, min1.h);
      currentBucket.l = Math.min(currentBucket.l, min1.l);
      currentBucket.c = min1.c;
      currentBucket.v += min1.v;
    }

    const now = min1.t;
    const dayKey = etDateKey(now);
    await rollDayIfNeeded(now);
    if (!isRTH(now)) return;

    for (const pos of account.openPositions) {
      const mark = theoreticalDebit({
        order: pos.fill.order,
        underlyingPx: min1.c,
        nowMs: now,
        sigma: hv,
      });
      pos.lastMarkDebit = mark;
      await maybeEmitMark(pos, mark, min1.c, now);
    }

    if (barBuffer.length === 0) return;
    const b = barBuffer[barBuffer.length - 1];
    const signal = strategy.onBar(state, b);
    killCheck(account, kill);

    for (const pos of [...account.openPositions]) {
      const mark = theoreticalDebit({ order: pos.fill.order, underlyingPx: min1.c, nowMs: now, sigma: hv });
      pos.lastMarkDebit = mark;
      const invalidated = strategy.underlyingInvalidated(state, pos.fill.order.side);
      const exitRule = evaluateExit(pos, {
        now,
        underlyingPx: min1.c,
        markDebit: mark,
        underlyingInvalidated: invalidated,
        killTripped: kill.tripped,
      });
      if (exitRule) {
        const legCount = pos.fill.order.kind === "debit_vertical" ? 2 : 1;
        const fallbackFees = config.execution.feePerContract * legCount * pos.fill.order.qty;

        let closeFill = await router.submitClose(pos.fill.order, mark, now);
        if (!closeFill && exitRule === "time") {
          log.warn(`time-exit limit-close failed for ${pos.id}; retrying with market order`);
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
            `closed ${pos.id} via ${exitRule} @ $${closeFill.filledDebit.toFixed(2)} (broker-confirmed)`,
          );
        } else {
          log.error(
            `CLOSE FAILED for ${pos.id} via ${exitRule} — broker may still hold the position. Using theoretical mark $${mark.toFixed(2)} for DB P&L. MANUAL RECONCILIATION NEEDED.`,
          );
        }

        closePosition(pos, exitRule, exitDebit, fees, now);
        account.openPositions = account.openPositions.filter((p) => p.id !== pos.id);
        recordClose(account, pos);
        if ((pos.pnlDollars ?? 0) >= 0) dayWins++;
        else dayLosses++;
        updateDrawdown();
        if (closedOnBroker) {
          log.info(`${pos.id} pnl=$${(pos.pnlDollars ?? 0).toFixed(2)}`);
        }
        await sink.close({
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
        positionMarkBucket.delete(pos.id);
      }
    }

    if (!signal || signal.side === "FLAT") return;
    daySignalsTotal++;

    const recordBlocked = async (reason: string): Promise<void> => {
      await sink.signal({
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

    const expiryISO = addBusinessDays(
      dayKey,
      Math.round((config.strategy.minDTE + config.strategy.maxDTE) / 2),
    );
    const snaps = await fetchOptionSnapshots(params.symbol, {
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
          underlying: params.symbol,
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
      vehicle === "long_option"
        ? pickLongOptionFromSnapshots(filtered.passed, signal.side, signal)
        : pickFromSnapshots(filtered.passed, signal.side, signal);

    if (!order) {
      log.warn(`no tradeable ${vehicle} from snapshots`, filtered.stats);
      await recordBlocked("no-tradeable-chain");
      return;
    }

    const size = sizeOrder(order, account);
    if (size.qty === 0) {
      log.warn(`sizing blocked: ${size.reason}`);
      await recordBlocked(size.reason);
      return;
    }
    order.qty = size.qty;
    const gate = pretradeGate(account, size.perContractRisk * size.qty);
    if (!gate.ok) {
      log.warn(`gate blocked: ${gate.reason}`);
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
    daySignalsAccepted++;
    dayEntriesTotal++;
    const legDesc =
      order.kind === "debit_vertical"
        ? `${order.long.symbol}/${order.short.symbol}`
        : order.leg.symbol;
    log.info(`opened ${order.side} ${legDesc} qty=${order.qty}`);
    await sink.signal({
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
    await sink.open({
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
    log.info(
      `hb: equity=$${account.equity.toFixed(2)} open=${account.openPositions.length} closedToday=${account.today.closedCount} kill=${kill.tripped ? kill.reason : "off"}`,
    );
  }, 60_000);

  const shutdown = async () => {
    clearInterval(hb);
    await router.cancelAll();
    stream.disconnect();
    await emitDaily();
    await sink.shutdown();
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
