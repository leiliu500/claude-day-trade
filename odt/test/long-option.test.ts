import { describe, it, expect } from "vitest";
import { pickSyntheticLongOption } from "../src/selector/strike-picker.js";
import { theoreticalDebit, simulateEntryFill, simulateExitFill } from "../src/backtest/fills.js";
import { sizeOrder } from "../src/risk/limits.js";
import { newAccountState } from "../src/risk/account.js";
import { evaluateExit, openPosition } from "../src/position/manager.js";
import type { Signal } from "../src/types.js";

function mkSignal(side: "LONG" | "SHORT"): Signal {
  return {
    side,
    atr: 1,
    reason: "test",
    ts: new Date("2026-04-20T14:00:00Z").getTime(),
    entryPrice: 500,
    stopPrice: side === "LONG" ? 499 : 501,
  };
}

describe("pickSyntheticLongOption", () => {
  it("LONG picks a call near target delta 0.60", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "LONG",
      mkSignal("LONG"),
    );
    expect(order.kind).toBe("long_option");
    expect(order.leg.type).toBe("C");
    expect(Math.abs(order.leg.delta - 0.60)).toBeLessThan(0.15);
    expect(order.limitDebit).toBeGreaterThan(0.5);
    expect(order.limitDebit).toBeLessThan(30);
  });

  it("SHORT picks a put", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "SHORT",
      mkSignal("SHORT"),
    );
    expect(order.leg.type).toBe("P");
    expect(order.leg.delta).toBeLessThan(0);
  });
});

describe("long-option fill+sizing+exit integration", () => {
  it("theoretical increases with underlying for a call", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "LONG",
      mkSignal("LONG"),
    );
    const t0 = new Date("2026-04-20T14:00:00Z").getTime();
    const cheap = theoreticalDebit({ order, underlyingPx: 495, nowMs: t0, sigma: 0.18 });
    const rich = theoreticalDebit({ order, underlyingPx: 510, nowMs: t0, sigma: 0.18 });
    expect(rich).toBeGreaterThan(cheap);
  });

  it("sizing uses configured long-option stop pct of premium", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "LONG",
      mkSignal("LONG"),
    );
    const state = newAccountState(25_000, "2026-04-20");
    const size = sizeOrder(order, state);
    const expectedPerContractRisk = order.limitDebit * 100 * 0.40;
    expect(size.perContractRisk).toBeCloseTo(expectedPerContractRisk, 1);
  });

  it("premium_stop fires past configured long-option stop pct", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "LONG",
      mkSignal("LONG"),
    );
    order.qty = 1;
    const now = new Date("2026-04-20T14:00:00Z").getTime();
    const fill = simulateEntryFill(order, 5.0, now);
    expect(fill).not.toBeNull();
    const pos = openPosition(fill!, now);
    const mild = evaluateExit(pos, {
      now,
      underlyingPx: 498,
      markDebit: 3.8,
      underlyingInvalidated: false,
      killTripped: false,
    });
    expect(mild).toBeNull();
    const severe = evaluateExit(pos, {
      now,
      underlyingPx: 495,
      markDebit: 2.3,
      underlyingInvalidated: false,
      killTripped: false,
    });
    expect(severe).toBe("premium_stop");
  });

  it("target fires at +100% for long option (not +60%)", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "LONG",
      mkSignal("LONG"),
    );
    order.qty = 1;
    const now = new Date("2026-04-20T14:00:00Z").getTime();
    const fill = simulateEntryFill(order, 5.0, now);
    const pos = openPosition(fill!, now);
    const atPlus80 = evaluateExit(pos, {
      now,
      underlyingPx: 510,
      markDebit: 9.3,
      underlyingInvalidated: false,
      killTripped: false,
    });
    expect(atPlus80).toBeNull();
    const atPlus120 = evaluateExit(pos, {
      now,
      underlyingPx: 515,
      markDebit: 12.0,
      underlyingInvalidated: false,
      killTripped: false,
    });
    expect(atPlus120).toBe("target");
  });

  it("exit fill removes single-leg slippage (not two legs)", () => {
    const order = pickSyntheticLongOption(
      { underlying: "SPY", underlyingPx: 500, hvAnnualized: 0.18, asOfDateISO: "2026-04-20", asOfMs: new Date("2026-04-20T14:00:00Z").getTime(), strikeStep: 1 },
      "LONG",
      mkSignal("LONG"),
    );
    order.qty = 2;
    const exit = simulateExitFill(order, 4.0);
    expect(exit.debit).toBeCloseTo(4.0 - 0.02, 2);
    expect(exit.fees).toBeCloseTo(0.65 * 1 * 2, 6);
  });
});
