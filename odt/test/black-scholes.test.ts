import { describe, it, expect } from "vitest";
import { bsDelta, bsPrice, strikeForTargetDelta } from "../src/selector/black-scholes.js";

describe("bsDelta", () => {
  it("ATM call is ~0.5", () => {
    const d = bsDelta({ S: 500, K: 500, T: 14 / 365, r: 0.04, sigma: 0.18, type: "C" });
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThan(0.6);
  });

  it("ATM put is ~-0.5", () => {
    const d = bsDelta({ S: 500, K: 500, T: 14 / 365, r: 0.04, sigma: 0.18, type: "P" });
    expect(d).toBeLessThan(-0.4);
    expect(d).toBeGreaterThan(-0.55);
  });

  it("deep ITM call approaches 1", () => {
    expect(bsDelta({ S: 600, K: 400, T: 14 / 365, r: 0.04, sigma: 0.18, type: "C" })).toBeGreaterThan(0.99);
  });

  it("deep ITM put approaches -1", () => {
    expect(bsDelta({ S: 400, K: 600, T: 14 / 365, r: 0.04, sigma: 0.18, type: "P" })).toBeLessThan(-0.99);
  });
});

describe("strikeForTargetDelta", () => {
  it("finds a call strike near target delta 0.50", () => {
    const k = strikeForTargetDelta(500, 14 / 365, 0.04, 0.18, "C", 0.50, 1);
    const d = bsDelta({ S: 500, K: k, T: 14 / 365, r: 0.04, sigma: 0.18, type: "C" });
    expect(Math.abs(d - 0.50)).toBeLessThan(0.05);
  });

  it("finds a put strike near target delta -0.60", () => {
    const k = strikeForTargetDelta(500, 14 / 365, 0.04, 0.18, "P", 0.60, 1);
    const d = bsDelta({ S: 500, K: k, T: 14 / 365, r: 0.04, sigma: 0.18, type: "P" });
    expect(d).toBeLessThan(-0.5);
    expect(d).toBeGreaterThan(-0.7);
  });

  it("put strike is above spot when delta is < -0.50", () => {
    const k = strikeForTargetDelta(500, 14 / 365, 0.04, 0.18, "P", 0.60, 1);
    expect(k).toBeGreaterThan(500);
  });
});

describe("bsPrice", () => {
  it("put-call parity (rough)", () => {
    const S = 500, K = 500, T = 14 / 365, r = 0.04, sigma = 0.18;
    const c = bsPrice({ S, K, T, r, sigma, type: "C" });
    const p = bsPrice({ S, K, T, r, sigma, type: "P" });
    const parity = c - p - (S - K * Math.exp(-r * T));
    expect(Math.abs(parity)).toBeLessThan(0.01);
  });
});
