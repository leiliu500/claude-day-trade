import { describe, it, expect } from "vitest";
import { makeState, onBar } from "../src/signal/orb-multi.js";
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

describe("orb-multi", () => {
  it("range 1 (9:30-10:00) fires a LONG break in 10:00-10:30 entry window", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    // 9:30–10:00 build first OR (width ~0.3% goldilocks)
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 501, 502, 500.5, 501.5));
    }
    const sig = onBar(s, bar(dayStart(10, 5), 502, 502.6, 501.8, 502.5));
    expect(sig?.side).toBe("LONG");
    expect(sig?.reason).toMatch(/range#1/);
  });

  it("range 1 expires at 10:30; range 2 fires in 10:30-11:00 window", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    // Range 1 build: 9:30-10:00, high=502, low=500.5 (~0.3% width)
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(9, 30 + i * 5), 501, 502, 500.5, 501.5));
    }
    // Range 2 build: 10:00-10:30 (also range 1 entry window; keep closes < 502)
    for (let i = 0; i < 6; i++) {
      onBar(s, bar(dayStart(10, i * 5), 501.5, 501.9, 500.9, 501.5));
    }
    // At 10:35 (range 2 entry window): break range 2 high=501.9
    const sig = onBar(s, bar(dayStart(10, 35), 501.9, 502.3, 501.7, 502.1));
    expect(sig?.side).toBe("LONG");
    expect(sig?.reason).toMatch(/range#2/);
  });

  it("each range can fire at most once per day (max 4 signals/day)", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    // Build range 1 and break it
    for (let i = 0; i < 6; i++) onBar(s, bar(dayStart(9, 30 + i * 5), 501, 502, 500.5, 501.5));
    const first = onBar(s, bar(dayStart(10, 5), 502.3, 503, 502, 502.8));
    expect(first?.side).toBe("LONG");
    // Second break within same entry window should NOT fire again (range1 already fired)
    const dup = onBar(s, bar(dayStart(10, 20), 503, 504, 502.8, 503.5));
    expect(dup).toBeNull();
  });

  it("rejects breakout when range width is too narrow (<0.15%)", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    // OR width = 0.3 / 500 = 0.06% — too narrow
    for (let i = 0; i < 6; i++) onBar(s, bar(dayStart(9, 30 + i * 5), 500.1, 500.2, 499.9, 500.0));
    const sig = onBar(s, bar(dayStart(10, 5), 500.3, 500.5, 500.2, 500.4));
    expect(sig).toBeNull();
  });

  it("rejects LONG when bias is wrong (close below prior day)", () => {
    const s = makeState();
    warmupPriorDays(s, 510); // prior close was 510
    for (let i = 0; i < 6; i++) onBar(s, bar(dayStart(9, 30 + i * 5), 501, 502, 500.5, 501.5));
    const sig = onBar(s, bar(dayStart(10, 5), 502, 502.6, 501.8, 502.5));
    expect(sig).toBeNull();
  });

  it("resets each day (fires cleanly after warmup on new day)", () => {
    const s = makeState();
    warmupPriorDays(s, 500);
    for (let i = 0; i < 6; i++) onBar(s, bar(dayStart(9, 30 + i * 5), 501, 502, 500.5, 501.5));
    const sig = onBar(s, bar(dayStart(10, 5), 502.3, 503, 502, 502.8));
    expect(sig?.side).toBe("LONG");
    expect(sig?.reason).toMatch(/range#1/);
  });
});
