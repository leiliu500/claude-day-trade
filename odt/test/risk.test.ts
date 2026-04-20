import { describe, it, expect } from "vitest";
import {
  countOpenForSymbol,
  ensureSymbolDay,
  newAccountState,
  recordClose,
  rollDay,
} from "../src/risk/account.js";
import { pretradeGate, sizeOrder } from "../src/risk/limits.js";
import { newKillState, check, trip, shouldKillForRegime } from "../src/risk/kill-switch.js";
import { buildOccSymbol } from "../src/selector/occ-symbol.js";
import type { Position, VerticalOrder } from "../src/types.js";

function mkOrder(debit = 1.5): VerticalOrder {
  const expiry = "2026-04-30";
  const leg = (strike: number) => ({
    symbol: buildOccSymbol({ underlying: "SPY", expiryISO: expiry, type: "C" as const, strike }),
    underlying: "SPY",
    strike,
    expiry,
    type: "C" as const,
    delta: 0.5,
    bid: 1,
    ask: 2,
    oi: 500,
    volume: 100,
  });
  return {
    kind: "debit_vertical",
    side: "LONG",
    long: leg(500),
    short: leg(505),
    qty: 0,
    limitDebit: debit,
    meta: { signalTs: Date.now(), entryUnderlying: 500, atr: 1, reason: "t" },
  };
}

describe("sizeOrder", () => {
  it("sizes to 1% risk budget", () => {
    const state = newAccountState(25_000, "2026-04-20");
    const r = sizeOrder(mkOrder(1.5), state);
    expect(r.qty).toBeGreaterThanOrEqual(1);
    expect(r.qty * r.perContractRisk).toBeLessThanOrEqual(25_000 * 0.01 + 0.01);
  });

  it("returns 0 when one contract exceeds the budget", () => {
    const state = newAccountState(100, "2026-04-20");
    const r = sizeOrder(mkOrder(1.5), state);
    expect(r.qty).toBe(0);
  });
});

describe("pretradeGate", () => {
  it("rejects when openPositions >= maxConcurrent", () => {
    const state = newAccountState(25_000, "2026-04-20");
    const pos = { id: "x" } as unknown as Position;
    state.openPositions.push(pos, pos);
    const g = pretradeGate(state, 100);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe("max-concurrent");
  });

  it("rejects when daily loss has already eaten budget", () => {
    const state = newAccountState(25_000, "2026-04-20");
    state.today.realized = -800;
    const g = pretradeGate(state, 100);
    expect(g.ok).toBe(false);
  });

  it("rejects on loss-streak lockout", () => {
    const state = newAccountState(25_000, "2026-04-20");
    state.today.streakLosses = 3;
    const g = pretradeGate(state, 100);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe("loss-streak-lockout");
  });
});

describe("kill-switch", () => {
  it("trips on daily loss", () => {
    const state = newAccountState(25_000, "2026-04-20");
    const kill = newKillState();
    state.today.realized = -800;
    check(state, kill);
    expect(kill.tripped).toBe(true);
    expect(kill.reason).toBe("daily_loss");
  });

  it("ignores once tripped", () => {
    const state = newAccountState(25_000, "2026-04-20");
    const kill = newKillState();
    trip(kill, "manual");
    state.today.streakLosses = 10;
    check(state, kill);
    expect(kill.reason).toBe("manual");
  });
});

describe("shouldKillForRegime", () => {
  it("is false when history is shorter than required days", () => {
    expect(shouldKillForRegime([0.95], 0.90, 2)).toBe(false);
  });

  it("trips when last N days are all at or above threshold", () => {
    expect(shouldKillForRegime([0.30, 0.91, 0.95], 0.90, 2)).toBe(true);
  });

  it("does not trip when any of the last N is below threshold", () => {
    expect(shouldKillForRegime([0.95, 0.95, 0.89], 0.90, 2)).toBe(false);
    expect(shouldKillForRegime([0.95, 0.89, 0.95], 0.90, 3)).toBe(false);
    expect(shouldKillForRegime([0.89, 0.95, 0.95], 0.90, 2)).toBe(true);
  });

  it("handles exact-threshold equality correctly", () => {
    expect(shouldKillForRegime([0.90, 0.90], 0.90, 2)).toBe(true);
  });
});

describe("per-symbol pretradeGate", () => {
  it("enforces per-symbol max-concurrent independently", () => {
    const state = newAccountState(25_000, "2026-04-20");
    const pos = { id: "a", symbol: "SPY" } as unknown as Position;
    state.openPositions.push(pos);
    const gSpy = pretradeGate(state, 100, { symbol: "SPY", symbolMaxConcurrent: 1 });
    expect(gSpy.ok).toBe(false);
    expect(gSpy.reason).toBe("symbol-max-concurrent");
    const gQqq = pretradeGate(state, 100, { symbol: "QQQ", symbolMaxConcurrent: 1 });
    expect(gQqq.ok).toBe(true);
  });

  it("uses per-symbol streakLosses when symbol provided", () => {
    const state = newAccountState(25_000, "2026-04-20");
    const d = ensureSymbolDay(state, "SPY", "2026-04-20");
    d.streakLosses = 3;
    const gSpy = pretradeGate(state, 100, {
      symbol: "SPY",
      symbolMaxConcurrent: 5,
      symbolLossStreakLockout: 3,
    });
    expect(gSpy.ok).toBe(false);
    expect(gSpy.reason).toBe("loss-streak-lockout");
    const gQqq = pretradeGate(state, 100, {
      symbol: "QQQ",
      symbolMaxConcurrent: 5,
      symbolLossStreakLockout: 3,
    });
    expect(gQqq.ok).toBe(true);
  });
});

describe("countOpenForSymbol", () => {
  it("counts only positions for the given symbol", () => {
    const state = newAccountState(25_000, "2026-04-20");
    state.openPositions.push(
      { id: "1", symbol: "SPY" } as unknown as Position,
      { id: "2", symbol: "SPY" } as unknown as Position,
      { id: "3", symbol: "QQQ" } as unknown as Position,
    );
    expect(countOpenForSymbol(state, "SPY")).toBe(2);
    expect(countOpenForSymbol(state, "QQQ")).toBe(1);
    expect(countOpenForSymbol(state, "MSFT")).toBe(0);
  });
});

describe("recordClose per-symbol", () => {
  it("updates per-symbol streak independently", () => {
    const state = newAccountState(10_000, "2026-04-20");
    const makePos = (pnl: number, symbol: string): Position =>
      ({ id: "p", symbol, pnlDollars: pnl, fill: { fees: 0, order: { qty: 1 } } }) as unknown as Position;
    recordClose(state, makePos(-50, "SPY"));
    recordClose(state, makePos(-50, "SPY"));
    recordClose(state, makePos(100, "QQQ"));
    const spy = state.perSymbolToday.get("SPY");
    const qqq = state.perSymbolToday.get("QQQ");
    expect(spy?.streakLosses).toBe(2);
    expect(spy?.losses).toBe(2);
    expect(qqq?.streakLosses).toBe(0);
    expect(qqq?.wins).toBe(1);
    expect(state.today.streakLosses).toBe(0);
  });
});

describe("account close+roll", () => {
  it("rolls day only when key changes", () => {
    const s = newAccountState(10_000, "2026-04-20");
    rollDay(s, "2026-04-20");
    expect(s.history).toHaveLength(0);
    rollDay(s, "2026-04-21");
    expect(s.history).toHaveLength(1);
    expect(s.today.dateKey).toBe("2026-04-21");
  });

  it("records streak correctly", () => {
    const s = newAccountState(10_000, "2026-04-20");
    const makePos = (pnl: number): Position =>
      ({ id: "p", pnlDollars: pnl, fill: { fees: 0, order: { qty: 1 } } } as unknown as Position);
    recordClose(s, makePos(-50));
    recordClose(s, makePos(-50));
    expect(s.today.streakLosses).toBe(2);
    recordClose(s, makePos(100));
    expect(s.today.streakLosses).toBe(0);
  });
});
