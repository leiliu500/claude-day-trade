import { describe, it, expect } from "vitest";
import { makeState, onBar, underlyingInvalidated } from "../src/signal/orb-breakout.js";
import type { Bar } from "../src/types.js";

function bar(t: number, o: number, h: number, l: number, c: number): Bar {
  return { t, o, h, l, c, v: 1_000_000 };
}

const dayStart = (hour: number, minute: number, dayOffset = 0) => {
  const d = new Date("2026-04-20T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour + 4, minute, 0, 0);
  return d.getTime();
};

describe("ORB breakout", () => {
  it("does not fire before OR is complete", () => {
    const s = makeState();
    onBar(s, bar(dayStart(9, 30), 100, 101, 99, 100.5));
    onBar(s, bar(dayStart(9, 45), 100.5, 101.5, 100, 101));
    const sig = onBar(s, bar(dayStart(9, 55), 101, 102, 100.5, 101.5));
    expect(sig).toBeNull();
    expect(s.orReady).toBe(false);
  });

  it("fires LONG on first close above OR high after 10:00 ET", () => {
    const s = makeState();
    for (let k = 20; k >= 1; k--) onBar(s, bar(dayStart(9, 30, -k), 100, 101, 99, 100));
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 100, 101, 99, 100.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 101, 102.5, 100.8, 102));
    expect(sig?.side).toBe("LONG");
    expect(s.firedToday).toBe(true);
  });

  it("does not fire twice the same day", () => {
    const s = makeState();
    for (let k = 20; k >= 1; k--) onBar(s, bar(dayStart(9, 30, -k), 100, 101, 99, 100));
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 100, 101, 99, 100.5));
    }
    const first = onBar(s, bar(dayStart(10, 5), 101, 102.5, 100.8, 102));
    expect(first?.side).toBe("LONG");
    const second = onBar(s, bar(dayStart(10, 10), 102, 103, 101.8, 102.5));
    expect(second).toBeNull();
  });

  it("does not fire past the entry cutoff", () => {
    const s = makeState();
    for (let k = 20; k >= 1; k--) onBar(s, bar(dayStart(9, 30, -k), 100, 101, 99, 100));
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 100, 101, 99, 100.5));
    }
    for (let i = 0; i < 20; i++) {
      onBar(s, bar(dayStart(10, 5 + i * 5), 100.8, 101, 100.7, 100.9));
    }
    const sig = onBar(s, bar(dayStart(12, 5), 101, 102.5, 100.8, 102));
    expect(sig).toBeNull();
  });

  it("SHORT-side invalidation fires when price returns inside OR", () => {
    const s = makeState();
    for (let k = 20; k >= 1; k--) onBar(s, bar(dayStart(9, 30, -k), 100, 101, 99, 100));
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 100, 101, 99, 100.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 99, 99.5, 98.5, 98.8));
    expect(sig?.side).toBe("SHORT");
    onBar(s, bar(dayStart(10, 10), 98.8, 99.2, 98.7, 99.1));
    onBar(s, bar(dayStart(10, 15), 99.1, 99.4, 98.9, 99.3));
    expect(underlyingInvalidated(s, "SHORT")).toBe(true);
  });
});
