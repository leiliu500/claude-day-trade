import { describe, it, expect } from "vitest";
import { LiveRouter } from "../src/exec/order-router.js";
import { buildOccSymbol } from "../src/selector/occ-symbol.js";
import type { LongOptionOrder, VerticalOrder } from "../src/types.js";

function mkLongOption(qty = 2): LongOptionOrder {
  const expiry = "2026-04-20";
  return {
    kind: "long_option",
    side: "LONG",
    leg: {
      symbol: buildOccSymbol({ underlying: "SPY", expiryISO: expiry, type: "C", strike: 500 }),
      underlying: "SPY",
      strike: 500,
      expiry,
      type: "C",
      delta: 0.5,
      bid: 2.0,
      ask: 2.1,
      oi: 500,
      volume: 100,
    },
    qty,
    limitDebit: 2.05,
    meta: { signalTs: Date.now(), entryUnderlying: 500, atr: 1, reason: "test" },
  };
}

function mkVertical(qty = 2): VerticalOrder {
  const expiry = "2026-04-20";
  const leg = (strike: number) => ({
    symbol: buildOccSymbol({ underlying: "SPY", expiryISO: expiry, type: "C" as const, strike }),
    underlying: "SPY",
    strike,
    expiry,
    type: "C" as const,
    delta: 0.5,
    bid: 1.0,
    ask: 1.2,
    oi: 500,
    volume: 100,
  });
  return {
    kind: "debit_vertical",
    side: "LONG",
    long: leg(500),
    short: leg(505),
    qty,
    limitDebit: 1.5,
    meta: { signalTs: Date.now(), entryUnderlying: 500, atr: 1, reason: "test" },
  };
}

describe("LiveRouter dry-run close", () => {
  it("returns synthetic fill at mark for long option", async () => {
    const router = new LiveRouter({ dryRun: true });
    const now = Date.now();
    const fill = await router.submitClose(mkLongOption(2), 4.0, now);
    expect(fill).not.toBeNull();
    expect(fill!.filledDebit).toBe(4.0);
    expect(fill!.fees).toBeCloseTo(0.65 * 1 * 2, 6);
    expect(fill!.ts).toBe(now);
  });

  it("returns synthetic fill at mark for debit vertical (2 legs fees)", async () => {
    const router = new LiveRouter({ dryRun: true });
    const fill = await router.submitClose(mkVertical(3), 2.5, Date.now());
    expect(fill).not.toBeNull();
    expect(fill!.filledDebit).toBe(2.5);
    expect(fill!.fees).toBeCloseTo(0.65 * 2 * 3, 6);
  });

  it("dry-run useMarket returns synthetic fill too", async () => {
    const router = new LiveRouter({ dryRun: true });
    const fill = await router.submitClose(mkLongOption(1), 3.2, Date.now(), { useMarket: true });
    expect(fill).not.toBeNull();
    expect(fill!.filledDebit).toBe(3.2);
  });
});

describe("LiveRouter dry-run open", () => {
  it("returns null on dry-run open (caller does not open position)", async () => {
    const router = new LiveRouter({ dryRun: true });
    const fill = await router.submit(mkLongOption(1), Date.now());
    expect(fill).toBeNull();
  });
});
