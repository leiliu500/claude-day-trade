import { describe, it, expect } from "vitest";
import { ema, atr, sma, trueRange } from "../src/signal/indicators.js";
import type { Bar } from "../src/types.js";

describe("ema", () => {
  it("returns input when values.length == 1", () => {
    expect(ema([5], 10)).toEqual([5]);
  });
  it("smooths with expected factor", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBeGreaterThan(3);
    expect(out[out.length - 1]).toBeLessThan(5);
  });
  it("converges toward constant input", () => {
    const out = ema(Array(50).fill(10), 5);
    expect(out[out.length - 1]).toBeCloseTo(10, 6);
  });
});

describe("sma", () => {
  it("emits NaN until period reached, then correct average", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(2, 6);
    expect(out[3]).toBeCloseTo(3, 6);
    expect(out[4]).toBeCloseTo(4, 6);
  });
});

describe("trueRange", () => {
  it("uses high-low when no gap", () => {
    const b: Bar = { t: 0, o: 100, h: 102, l: 99, c: 101, v: 100 };
    expect(trueRange(b, 100)).toBe(3);
  });
  it("picks gap-including range", () => {
    const b: Bar = { t: 0, o: 105, h: 106, l: 104, c: 105, v: 100 };
    expect(trueRange(b, 100)).toBe(6);
  });
});

describe("atr", () => {
  it("returns one value per bar", () => {
    const bars: Bar[] = Array.from({ length: 20 }, (_, i) => ({
      t: i,
      o: 100 + i,
      h: 101 + i,
      l: 99 + i,
      c: 100 + i,
      v: 100,
    }));
    const a = atr(bars, 14);
    expect(a).toHaveLength(20);
    expect(a[a.length - 1]).toBeGreaterThan(0);
  });
});
