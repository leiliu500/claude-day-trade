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

const log = logger("live");

export async function runLive(params: {
  symbol: string;
  dryRun: boolean;
  strategy?: Strategy;
  vehicle?: Vehicle;
}): Promise<void> {
  const strategy = params.strategy ?? trendPullbackStrategy;
  const vehicle: Vehicle = params.vehicle ?? config.strategy.vehicle;

  const acct = await fetchAccount();
  const equity = Number(acct.equity);
  log.info(`account equity: $${equity.toFixed(2)}`);
  log.info(`strategy=${strategy.name} vehicle=${vehicle} dryRun=${params.dryRun}`);

  const state = strategy.makeState();
  const account = newAccountState(equity, etDateKey(Date.now()));
  const kill = newKillState();
  const router = new LiveRouter({ dryRun: params.dryRun });

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
    rollDay(account, dayKey);
    if (!isRTH(now)) return;

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
        const fees = config.execution.feePerContract * legCount * pos.fill.order.qty;
        closePosition(pos, exitRule, mark, fees, now);
        account.openPositions = account.openPositions.filter((p) => p.id !== pos.id);
        recordClose(account, pos);
        log.info(`closed ${pos.id} via ${exitRule} pnl=$${(pos.pnlDollars ?? 0).toFixed(2)}`);
      }
    }

    if (!signal || signal.side === "FLAT" || kill.tripped) return;

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
      return;
    }

    const size = sizeOrder(order, account);
    if (size.qty === 0) {
      log.warn(`sizing blocked: ${size.reason}`);
      return;
    }
    order.qty = size.qty;
    const gate = pretradeGate(account, size.perContractRisk * size.qty);
    if (!gate.ok) {
      log.warn(`gate blocked: ${gate.reason}`);
      return;
    }
    const fill = await router.submit(order, now);
    if (!fill) return;
    account.openPositions.push(openPosition(fill, now));
    const legDesc =
      order.kind === "debit_vertical"
        ? `${order.long.symbol}/${order.short.symbol}`
        : order.leg.symbol;
    log.info(`opened ${order.side} ${legDesc} qty=${order.qty}`);
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
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
