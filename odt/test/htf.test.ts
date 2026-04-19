import { describe, it, expect } from "vitest";
import { makeState, onBar, htfTrendAligned } from "../src/signal/trend-pullback.js";
import type { Bar } from "../src/types.js";

function bar(t: number, close: number): Bar {
  return { t, o: close, h: close + 0.05, l: close - 0.05, c: close, v: 1_000_000 };
}

function feed(state: ReturnType<typeof makeState>, closes: number[], startTs: number): void {
  let t = startTs;
  for (const c of closes) {
    onBar(state, bar(t, c));
    t += 5 * 60 * 1000;
  }
}

describe("HTF 15-min bucket aggregation", () => {
  it("closes a bucket every 3rd 5-min bar", () => {
    const s = makeState();
    feed(s, [100, 100, 100, 100, 100, 100], Date.UTC(2026, 3, 1, 14, 0));
    expect(s.htf.closedBuckets).toBe(1);
    feed(s, [100, 100, 100], Date.UTC(2026, 3, 1, 14, 30));
    expect(s.htf.closedBuckets).toBe(2);
  });

  it("htfTrendAligned is false during warmup", () => {
    const s = makeState();
    feed(s, Array.from({ length: 30 }, (_, i) => 100 + i * 0.1), Date.UTC(2026, 3, 1, 13, 30));
    expect(htfTrendAligned(s, "LONG")).toBe(false);
  });

  it("becomes LONG-aligned after enough rising 15-min buckets", () => {
    const s = makeState();
    feed(s, Array.from({ length: 200 }, (_, i) => 100 + i * 0.05), Date.UTC(2026, 3, 1, 13, 30));
    expect(htfTrendAligned(s, "LONG")).toBe(true);
    expect(htfTrendAligned(s, "SHORT")).toBe(false);
  });

  it("becomes SHORT-aligned after enough falling 15-min buckets", () => {
    const s = makeState();
    feed(s, Array.from({ length: 200 }, (_, i) => 200 - i * 0.05), Date.UTC(2026, 3, 1, 13, 30));
    expect(htfTrendAligned(s, "SHORT")).toBe(true);
    expect(htfTrendAligned(s, "LONG")).toBe(false);
  });
});
