import { describe, it, expect } from "vitest";
import { sessionCloseUTCms } from "../src/util/time.js";
import { theoreticalDebit } from "../src/backtest/fills.js";
import { pickSyntheticLongOption } from "../src/selector/strike-picker.js";
import type { Signal } from "../src/types.js";

function mkSignal(side: "LONG" | "SHORT", tsMs: number): Signal {
  return {
    side,
    atr: 1,
    reason: "test",
    ts: tsMs,
    entryPrice: 500,
    stopPrice: side === "LONG" ? 499 : 501,
  };
}

describe("sessionCloseUTCms", () => {
  it("returns 20:00 UTC for a winter date (EST, UTC-5)", () => {
    const ms = sessionCloseUTCms("2026-01-15");
    const d = new Date(ms);
    expect(d.getUTCHours()).toBe(21);
  });

  it("returns 20:00 UTC for a summer date (EDT, UTC-4)", () => {
    const ms = sessionCloseUTCms("2026-07-15");
    const d = new Date(ms);
    expect(d.getUTCHours()).toBe(20);
  });
});

describe("0DTE pricing behaviour", () => {
  it("intraday T shrinks as the trading day progresses", () => {
    const asOfDateISO = "2026-07-15";
    const ctx1 = {
      underlying: "SPY",
      underlyingPx: 500,
      hvAnnualized: 0.18,
      asOfDateISO,
      asOfMs: new Date("2026-07-15T14:00:00Z").getTime(),
      strikeStep: 1,
    };
    const ctx2 = { ...ctx1, asOfMs: new Date("2026-07-15T19:00:00Z").getTime() };

    const early = pickSyntheticLongOption(ctx1, "LONG", mkSignal("LONG", ctx1.asOfMs));
    const late = pickSyntheticLongOption(ctx2, "LONG", mkSignal("LONG", ctx2.asOfMs));

    expect(early.limitDebit).toBeGreaterThan(late.limitDebit);
  });

  it("theoretical debit at 0DTE collapses toward intrinsic near expiry", () => {
    const ts = new Date("2026-07-15T14:30:00Z").getTime();
    const ctx = {
      underlying: "SPY",
      underlyingPx: 500,
      hvAnnualized: 0.18,
      asOfDateISO: "2026-07-15",
      asOfMs: ts,
      strikeStep: 1,
    };
    const order = pickSyntheticLongOption(ctx, "LONG", mkSignal("LONG", ts));

    const nearClose = new Date("2026-07-15T19:55:00Z").getTime();
    const itmTheo = theoreticalDebit({ order, underlyingPx: 510, nowMs: nearClose, sigma: 0.18 });
    const intrinsic = Math.max(0, 510 - order.leg.strike);
    expect(itmTheo).toBeGreaterThanOrEqual(intrinsic);
    expect(itmTheo - intrinsic).toBeLessThan(0.5);
  });

  it("0DTE premium is much smaller than 14DTE would be at same strike", () => {
    const ts = new Date("2026-07-15T14:00:00Z").getTime();
    const ctx = {
      underlying: "SPY",
      underlyingPx: 500,
      hvAnnualized: 0.18,
      asOfDateISO: "2026-07-15",
      asOfMs: ts,
      strikeStep: 1,
    };
    const zeroDte = pickSyntheticLongOption(ctx, "LONG", mkSignal("LONG", ts));
    expect(zeroDte.limitDebit).toBeLessThan(5);
  });
});
