import type { Bar } from "../types.js";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

export function trueRange(b: Bar, prevClose: number): number {
  const hl = b.h - b.l;
  const hc = Math.abs(b.h - prevClose);
  const lc = Math.abs(b.l - prevClose);
  return Math.max(hl, hc, lc);
}

export function atr(bars: Bar[], period: number): number[] {
  if (bars.length === 0) return [];
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const prev = i === 0 ? bars[i].c : bars[i - 1].c;
    trs.push(trueRange(bars[i], prev));
  }
  const out: number[] = [];
  let prev = trs[0];
  out.push(prev);
  for (let i = 1; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out.push(prev);
  }
  return out;
}

export function vwapSession(bars: Bar[], sessionKey: (b: Bar) => string): number[] {
  const out: number[] = [];
  let curKey = "";
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const k = sessionKey(b);
    if (k !== curKey) {
      curKey = k;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v;
    cumV += b.v;
    out.push(cumV === 0 ? tp : cumPV / cumV);
  }
  return out;
}

export function openingRange(bars: Bar[], minutes: number, sessionStartMin: number, sessionKey: (b: Bar) => string): Map<string, { high: number; low: number }> {
  const out = new Map<string, { high: number; low: number }>();
  for (const b of bars) {
    const key = sessionKey(b);
    const mins = sessionMinuteOf(b.t);
    if (mins < sessionStartMin || mins >= sessionStartMin + minutes) continue;
    const existing = out.get(key);
    if (!existing) out.set(key, { high: b.h, low: b.l });
    else out.set(key, { high: Math.max(existing.high, b.h), low: Math.min(existing.low, b.l) });
  }
  return out;
}

function sessionMinuteOf(ts: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ts));
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minPart = parts.find((p) => p.type === "minute")?.value ?? "0";
  const h = Number(hourPart === "24" ? "0" : hourPart);
  return h * 60 + Number(minPart);
}
