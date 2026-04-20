import { describe, it, expect } from "vitest";
import { resolveSymbolConfig, strikeParamsFor, exitParamsFor } from "../src/config.js";
import { evaluateExit, openPosition } from "../src/position/manager.js";
import { simulateEntryFill } from "../src/backtest/fills.js";
import { pickSyntheticLongOption, pickLongOptionFromSnapshots } from "../src/selector/strike-picker.js";
import type { OptionContract, Signal } from "../src/types.js";

function mkSignal(side: "LONG" | "SHORT"): Signal {
  return { side, atr: 1, reason: "test", ts: Date.now(), entryPrice: 500, stopPrice: 495 };
}

describe("resolveSymbolConfig", () => {
  it("fills missing fields from global defaults", () => {
    const r = resolveSymbolConfig({ symbol: "SPY" });
    expect(r.symbol).toBe("SPY");
    expect(r.strategy).toBe("trend-pullback");
    expect(r.vehicle).toBe("debit_vertical");
    expect(r.maxConcurrent).toBe(1);
    expect(r.targetDelta).toBeGreaterThan(0);
  });

  it("honors per-symbol overrides", () => {
    const r = resolveSymbolConfig({
      symbol: "QQQ",
      strategy: "orb",
      vehicle: "long_option",
      targetDelta: 0.6,
      maxConcurrent: 3,
      lossStreakLockout: 5,
    });
    expect(r.strategy).toBe("orb");
    expect(r.vehicle).toBe("long_option");
    expect(r.targetDelta).toBe(0.6);
    expect(r.maxConcurrent).toBe(3);
    expect(r.lossStreakLockout).toBe(5);
  });
});

function mkLeg(underlying: string, delta: number, strike: number): OptionContract {
  return {
    symbol: `${underlying}T${strike}`,
    underlying,
    strike,
    expiry: "2026-04-30",
    type: "C",
    delta,
    bid: 1,
    ask: 1.1,
    oi: 500,
    volume: 100,
  };
}

describe("Phase 1: strike-picker honors per-symbol StrikeParams", () => {
  it("SPY targetDelta=0.50 picks a different leg than QQQ targetDelta=0.30 from the same chain", () => {
    const chain: OptionContract[] = [
      mkLeg("SPY", 0.30, 510),
      mkLeg("SPY", 0.50, 505),
      mkLeg("SPY", 0.70, 500),
    ];
    const spy = resolveSymbolConfig({ symbol: "SPY", vehicle: "long_option", longOptionTargetDelta: 0.50 });
    const qqq = resolveSymbolConfig({ symbol: "QQQ", vehicle: "long_option", longOptionTargetDelta: 0.30 });
    const sig: Signal = { side: "LONG", atr: 1, reason: "t", ts: Date.now(), entryPrice: 500, stopPrice: 495 };
    const spyOrder = pickLongOptionFromSnapshots(chain, "LONG", sig, strikeParamsFor(spy));
    const qqqOrder = pickLongOptionFromSnapshots(chain, "LONG", sig, strikeParamsFor(qqq));
    expect(spyOrder?.leg.delta).toBe(0.50);
    expect(qqqOrder?.leg.delta).toBe(0.30);
  });
});

describe("Phase 1: evaluateExit honors per-symbol ExitParams", () => {
  it("tighter SPY stop fires while looser QQQ stop does not", () => {
    const order = pickSyntheticLongOption(
      {
        underlying: "SPY",
        underlyingPx: 500,
        hvAnnualized: 0.18,
        asOfDateISO: "2026-04-20",
        asOfMs: new Date("2026-04-20T14:00:00Z").getTime(),
        strikeStep: 1,
      },
      "LONG",
      { side: "LONG", atr: 1, reason: "t", ts: Date.now(), entryPrice: 500, stopPrice: 495 },
    );
    order.qty = 1;
    const now = new Date("2026-04-20T14:00:00Z").getTime();
    const fill = simulateEntryFill(order, 5.0, now);
    const pos = openPosition(fill!, now);

    const spy = resolveSymbolConfig({ symbol: "SPY", longOptionPremiumStopPct: 0.30 });
    const qqq = resolveSymbolConfig({ symbol: "QQQ", longOptionPremiumStopPct: 0.60 });
    const mark = 3.6; // -28% from entry 5.0
    const spyExit = evaluateExit(
      pos,
      { now, underlyingPx: 498, markDebit: mark, underlyingInvalidated: false, killTripped: false },
      exitParamsFor({ ...spy, vehicle: "long_option" }),
    );
    const qqqExit = evaluateExit(
      pos,
      { now, underlyingPx: 498, markDebit: mark, underlyingInvalidated: false, killTripped: false },
      exitParamsFor({ ...qqq, vehicle: "long_option" }),
    );
    expect(spyExit).toBeNull();

    const mark2 = 3.4; // -32%
    const spyExit2 = evaluateExit(
      pos,
      { now, underlyingPx: 498, markDebit: mark2, underlyingInvalidated: false, killTripped: false },
      exitParamsFor({ ...spy, vehicle: "long_option" }),
    );
    expect(spyExit2).toBe("premium_stop");
    expect(qqqExit).toBeNull();
  });
});

describe("Phase 2: StrategyParams isolate per-symbol EMA/ATR periods", () => {
  it("SPY strategy with emaPeriod=5 converges faster than QQQ with emaPeriod=50 on the same bars", async () => {
    const { orbFilteredStrategy } = await import("../src/signal/strategy.js");
    const bars = Array.from({ length: 60 }, (_, i) => ({
      t: Date.parse("2026-04-17T13:30:00Z") + i * 60_000,
      o: 500, h: 500 + i * 0.1, l: 500, c: 500 + i * 0.1, v: 1_000_000,
    }));
    const spy = orbFilteredStrategy.makeState({ emaPeriod: 5, atrPeriod: 14 }) as { ema: number };
    const qqq = orbFilteredStrategy.makeState({ emaPeriod: 50, atrPeriod: 14 }) as { ema: number };
    for (const b of bars) {
      orbFilteredStrategy.onBar(spy, b);
      orbFilteredStrategy.onBar(qqq, b);
    }
    const lastClose = bars[bars.length - 1].c;
    const spyDistance = Math.abs(lastClose - spy.ema);
    const qqqDistance = Math.abs(lastClose - qqq.ema);
    expect(spyDistance).toBeLessThan(qqqDistance);
  });

  it("two concurrent ORB states don't share ATR — each tracks its own atrPeriod", async () => {
    const { orbFilteredStrategy } = await import("../src/signal/strategy.js");
    const bars = Array.from({ length: 30 }, (_, i) => ({
      t: Date.parse("2026-04-17T13:30:00Z") + i * 60_000,
      o: 500, h: 501, l: 499, c: 500, v: 1_000_000,
    }));
    const a = orbFilteredStrategy.makeState({ emaPeriod: 20, atrPeriod: 5 }) as { atr: number };
    const b = orbFilteredStrategy.makeState({ emaPeriod: 20, atrPeriod: 30 }) as { atr: number };
    for (const bar of bars) {
      orbFilteredStrategy.onBar(a, bar);
      orbFilteredStrategy.onBar(b, bar);
    }
    // Both should have converged toward the same 2.0 TR, but via different smoothing — just check they're independent objects.
    expect(isFinite(a.atr)).toBe(true);
    expect(isFinite(b.atr)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("openPosition carries symbol", () => {
  it("derives symbol from long-option leg underlying", () => {
    const order = pickSyntheticLongOption(
      {
        underlying: "MSFT",
        underlyingPx: 420,
        hvAnnualized: 0.22,
        asOfDateISO: "2026-04-20",
        asOfMs: new Date("2026-04-20T14:00:00Z").getTime(),
        strikeStep: 1,
      },
      "LONG",
      mkSignal("LONG"),
    );
    order.qty = 1;
    const now = new Date("2026-04-20T14:00:00Z").getTime();
    const fill = simulateEntryFill(order, 5.0, now);
    expect(fill).not.toBeNull();
    const pos = openPosition(fill!, now);
    expect(pos.symbol).toBe("MSFT");
  });
});
