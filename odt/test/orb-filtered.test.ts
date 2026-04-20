import { describe, it, expect } from "vitest";
import { makeState, onBar } from "../src/signal/orb-filtered.js";
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

function warmupPriorDays(s: ReturnType<typeof makeState>, priorClose: number): void {
  for (let k = 3; k >= 1; k--) {
    for (let i = 0; i < 78; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5, -k), priorClose, priorClose + 0.1, priorClose - 0.1, priorClose));
    }
  }
}

describe("ORB-filtered", () => {
  it("rejects breakout when OR is too tight (< 0.15% of price)", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 500.0, 500.3, 499.7, 500.1));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 500.5, 500.8, 500.2, 500.5));
    expect(sig).toBeNull();
  });

  it("rejects breakout when OR is too wide (> 0.60% of price)", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 500.0, 504.0, 496.0, 502.0));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 504.5, 505.0, 504.0, 504.8));
    expect(sig).toBeNull();
  });

  it("fires LONG when OR width is goldilocks AND close above prior day", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 501.0, 502.0, 500.5, 501.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 502.0, 502.8, 501.7, 502.5));
    expect(sig?.side).toBe("LONG");
  });

  it("rejects LONG breakout when today's close is below prior day close (bias filter)", () => {
    const s = makeState();
    warmupPriorDays(s, 510);
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 501.0, 502.0, 500.5, 501.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 502.0, 502.8, 501.7, 502.5));
    expect(sig).toBeNull();
  });

  it("fires SHORT when breakdown is below OR low AND close below prior day", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 499.0, 500.0, 498.5, 499.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 498.5, 498.7, 498.0, 498.2));
    expect(sig?.side).toBe("SHORT");
  });

  it("allows first-ever day (no priorDayClose yet) to trade either side", () => {
    const s = makeState();
    for (let i = 0; i < 20; i++) {
      onBar(s, bar(dayStart(9, 30 + i, -0), 500, 500.2, 499.8, 500));
    }
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 501.0, 502.0, 500.5, 501.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 502.0, 502.8, 501.7, 502.5));
    expect(sig?.side).toBe("LONG");
  });
});
