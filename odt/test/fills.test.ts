import { describe, it, expect } from "vitest";
import { theoreticalDebit, simulateEntryFill, simulateExitFill } from "../src/backtest/fills.js";
import { buildOccSymbol } from "../src/selector/occ-symbol.js";
import type { VerticalOrder } from "../src/types.js";

function mkVertical(): VerticalOrder {
  const expiry = "2026-04-30";
  return {
    kind: "debit_vertical",
    side: "LONG",
    long: {
      symbol: buildOccSymbol({ underlying: "SPY", expiryISO: expiry, type: "C", strike: 500 }),
      underlying: "SPY",
      strike: 500,
      expiry,
      type: "C",
      delta: 0.5,
      bid: 4.9,
      ask: 5.1,
      oi: 500,
      volume: 100,
    },
    short: {
      symbol: buildOccSymbol({ underlying: "SPY", expiryISO: expiry, type: "C", strike: 505 }),
      underlying: "SPY",
      strike: 505,
      expiry,
      type: "C",
      delta: 0.35,
      bid: 2.9,
      ask: 3.1,
      oi: 500,
      volume: 100,
    },
    qty: 2,
    limitDebit: 2,
    meta: { signalTs: Date.now(), entryUnderlying: 500, atr: 1, reason: "test" },
  };
}

describe("theoreticalDebit", () => {
  it("is positive and bounded by width for a call debit spread", () => {
    const order = mkVertical();
    const nowMs = new Date("2026-04-20T13:30:00Z").getTime();
    const theo = theoreticalDebit({ order, underlyingPx: 500, nowMs, sigma: 0.15 });
    expect(theo).toBeGreaterThan(0);
    expect(theo).toBeLessThan(5);
  });
  it("increases with ITM-ness for a long call vertical", () => {
    const order = mkVertical();
    const nowMs = new Date("2026-04-20T13:30:00Z").getTime();
    const lowTheo = theoreticalDebit({ order, underlyingPx: 495, nowMs, sigma: 0.15 });
    const highTheo = theoreticalDebit({ order, underlyingPx: 510, nowMs, sigma: 0.15 });
    expect(highTheo).toBeGreaterThan(lowTheo);
  });
});

describe("simulateEntryFill", () => {
  it("adds slippage vs theoretical", () => {
    const order = mkVertical();
    const fill = simulateEntryFill(order, 2.0, Date.now());
    expect(fill).not.toBeNull();
    expect(fill!.filledDebit).toBeGreaterThan(2.0);
    expect(fill!.fees).toBeCloseTo(0.65 * 2 * order.qty, 6);
  });
  it("rejects when implied spread-pct exceeds guard", () => {
    const order = mkVertical();
    const fill = simulateEntryFill(order, 0.05, Date.now());
    expect(fill).toBeNull();
  });
});

describe("simulateExitFill", () => {
  it("removes slippage on exit (worse for seller)", () => {
    const order = mkVertical();
    const exit = simulateExitFill(order, 3.0);
    expect(exit.debit).toBeLessThan(3.0);
    expect(exit.fees).toBeCloseTo(0.65 * 2 * order.qty, 6);
  });
});
