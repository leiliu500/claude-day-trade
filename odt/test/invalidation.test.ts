import { describe, it, expect } from "vitest";
import { makeState, onBar, underlyingInvalidated } from "../src/signal/trend-pullback.js";
import type { Bar } from "../src/types.js";

function bar(t: number, close: number): Bar {
  return { t, o: close, h: close + 0.1, l: close - 0.1, c: close, v: 1_000_000 };
}

function feed(closes: number[]): ReturnType<typeof makeState> {
  const s = makeState();
  let t = Date.UTC(2026, 3, 1, 13, 30);
  for (const c of closes) {
    onBar(s, bar(t, c));
    t += 5 * 60 * 1000;
  }
  return s;
}

describe("underlyingInvalidated", () => {
  it("returns false before any bars", () => {
    const s = makeState();
    expect(underlyingInvalidated(s, "LONG")).toBe(false);
    expect(underlyingInvalidated(s, "SHORT")).toBe(false);
  });

  it("does not invalidate a LONG on a single close below EMA (within buffer)", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.2);
    const s = feed(closes);
    const preEma = s.ema;
    expect(underlyingInvalidated(s, "LONG")).toBe(false);
    onBar(s, bar(Date.now(), preEma - 0.5 * s.atr));
    expect(underlyingInvalidated(s, "LONG")).toBe(false);
  });

  it("does invalidate a LONG on two consecutive closes below EMA - 0.25 ATR", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.2);
    const s = feed(closes);
    const t = Date.UTC(2026, 3, 2, 13, 30);
    onBar(s, bar(t, s.ema - 1.0 * s.atr));
    expect(underlyingInvalidated(s, "LONG")).toBe(false);
    onBar(s, bar(t + 300_000, s.ema - 1.0 * s.atr));
    expect(underlyingInvalidated(s, "LONG")).toBe(true);
  });

  it("symmetric behaviour for SHORT", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 0.2);
    const s = feed(closes);
    const t = Date.UTC(2026, 3, 2, 13, 30);
    onBar(s, bar(t, s.ema + 1.0 * s.atr));
    expect(underlyingInvalidated(s, "SHORT")).toBe(false);
    onBar(s, bar(t + 300_000, s.ema + 1.0 * s.atr));
    expect(underlyingInvalidated(s, "SHORT")).toBe(true);
  });
});
