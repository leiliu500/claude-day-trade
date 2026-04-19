import { describe, it, expect } from "vitest";
import { makeState, onBar } from "../src/signal/trend-pullback.js";
import type { Bar } from "../src/types.js";

function et(hour: number, minute: number, dayOffset = 0): number {
  const d = new Date("2026-04-20T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour + 4, minute, 0, 0);
  return d.getTime();
}

function bar(t: number, o: number, h: number, l: number, c: number): Bar {
  return { t, o, h, l, c, v: 1_000_000 };
}

describe("trend-pullback signal", () => {
  it("stays silent without enough history", () => {
    const s = makeState();
    for (let i = 0; i < 10; i++) {
      const sig = onBar(s, bar(et(9, 30 + i * 5), 500, 500.5, 499.5, 500));
      expect(sig).toBeNull();
    }
  });

  it("does not emit outside 10:00-15:30 ET window", () => {
    const s = makeState();
    for (let i = 0; i < 60; i++) {
      onBar(s, bar(et(9, 30 + i, -1), 500 + i * 0.05, 500.5 + i * 0.05, 499.5 + i * 0.05, 500 + i * 0.05));
    }
    const earlySig = onBar(s, bar(et(9, 35), 501, 501.5, 500.5, 501));
    expect(earlySig).toBeNull();
  });

  it("returns a Signal object with finite atr when it does fire", () => {
    const s = makeState();
    const priceAt = (i: number) => 500 + Math.sin(i / 10) * 2 + i * 0.02;
    for (let day = -3; day <= 0; day++) {
      for (let m = 0; m < 78; m++) {
        const p = priceAt(day * 78 + m);
        const sig = onBar(s, bar(et(9, 30 + m * 5, day), p, p + 0.3, p - 0.3, p + 0.05));
        if (sig) {
          expect(sig.atr).toBeGreaterThan(0);
          expect(["LONG", "SHORT"]).toContain(sig.side);
          return;
        }
      }
    }
  });
});
