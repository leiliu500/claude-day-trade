import type { Bar, Signal } from "../types.js";
import { etDateKey, etMinutesSinceMidnight } from "../util/time.js";
import { config } from "../config.js";

const RECENT_CAP = 10;

const OR_WIDTH_MIN_PCT = 0.0015;
const OR_WIDTH_MAX_PCT = 0.006;

interface RangeDef {
  id: number;
  startMins: number;
  endMins: number;
  entryEndMins: number;
}

const RANGES: readonly RangeDef[] = [
  { id: 1, startMins: 9 * 60 + 30,  endMins: 10 * 60,       entryEndMins: 10 * 60 + 30 },
  { id: 2, startMins: 10 * 60,      endMins: 10 * 60 + 30,  entryEndMins: 11 * 60 },
  { id: 3, startMins: 10 * 60 + 30, endMins: 11 * 60,       entryEndMins: 11 * 60 + 30 },
  { id: 4, startMins: 11 * 60,      endMins: 11 * 60 + 30,  entryEndMins: 12 * 60 },
] as const;

interface Range {
  id: number;
  high: number;
  low: number;
  ready: boolean;
  fired: boolean;
}

export interface ORBMultiState {
  recent: Bar[];
  count: number;
  ema: number;
  prevEma: number;
  atr: number;
  prevTrClose: number;
  vwapCumPV: number;
  vwapCumV: number;
  vwapDay: string;
  vwap: number;
  orDay: string;
  ranges: Range[];
  priorDayClose: number;
  runningLastClose: number;
  activeRangeId: number | null;
  lastSignal?: Signal;
}

function freshRanges(): Range[] {
  return RANGES.map((r) => ({ id: r.id, high: -Infinity, low: Infinity, ready: false, fired: false }));
}

export function makeState(): ORBMultiState {
  return {
    recent: [],
    count: 0,
    ema: NaN,
    prevEma: NaN,
    atr: NaN,
    prevTrClose: NaN,
    vwapCumPV: 0,
    vwapCumV: 0,
    vwapDay: "",
    vwap: NaN,
    orDay: "",
    ranges: freshRanges(),
    priorDayClose: NaN,
    runningLastClose: NaN,
    activeRangeId: null,
  };
}

function updateEMA(s: ORBMultiState, close: number): void {
  const k = 2 / (config.strategy.emaPeriod + 1);
  s.prevEma = s.ema;
  if (!isFinite(s.ema)) s.ema = close;
  else s.ema = close * k + s.ema * (1 - k);
}

function updateATR(s: ORBMultiState, b: Bar): void {
  const prev = isFinite(s.prevTrClose) ? s.prevTrClose : b.c;
  const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  const n = config.strategy.atrPeriod;
  if (!isFinite(s.atr)) s.atr = tr;
  else s.atr = (s.atr * (n - 1) + tr) / n;
  s.prevTrClose = b.c;
}

function updateVWAP(s: ORBMultiState, b: Bar): void {
  const day = etDateKey(b.t);
  if (day !== s.vwapDay) {
    s.vwapDay = day;
    s.vwapCumPV = 0;
    s.vwapCumV = 0;
  }
  const tp = (b.h + b.l + b.c) / 3;
  s.vwapCumPV += tp * b.v;
  s.vwapCumV += b.v;
  s.vwap = s.vwapCumV === 0 ? tp : s.vwapCumPV / s.vwapCumV;
}

function updateRanges(s: ORBMultiState, b: Bar): void {
  const day = etDateKey(b.t);
  const mins = etMinutesSinceMidnight(b.t);
  if (day !== s.orDay) {
    if (s.orDay !== "" && isFinite(s.runningLastClose)) {
      s.priorDayClose = s.runningLastClose;
    }
    s.orDay = day;
    s.ranges = freshRanges();
    s.activeRangeId = null;
  }
  for (let i = 0; i < RANGES.length; i++) {
    const def = RANGES[i];
    const r = s.ranges[i];
    if (mins >= def.startMins && mins < def.endMins) {
      r.high = Math.max(r.high, b.h);
      r.low = Math.min(r.low, b.l);
    } else if (mins >= def.endMins && isFinite(r.high) && isFinite(r.low) && r.high > r.low) {
      r.ready = true;
    }
  }
  s.runningLastClose = b.c;
}

function eligibleRange(s: ORBMultiState, mins: number): { def: RangeDef; r: Range } | null {
  for (let i = 0; i < RANGES.length; i++) {
    const def = RANGES[i];
    const r = s.ranges[i];
    if (!r.ready || r.fired) continue;
    if (mins < def.endMins || mins >= def.entryEndMins) continue;
    return { def, r };
  }
  return null;
}

function biasOk(s: ORBMultiState, close: number, side: "LONG" | "SHORT"): boolean {
  if (!isFinite(s.priorDayClose)) return true;
  return side === "LONG" ? close > s.priorDayClose : close < s.priorDayClose;
}

export function onBar(s: ORBMultiState, b: Bar): Signal | null {
  updateEMA(s, b.c);
  updateATR(s, b);
  updateVWAP(s, b);
  updateRanges(s, b);
  s.recent.push(b);
  if (s.recent.length > RECENT_CAP) s.recent.shift();
  s.count++;

  const warmup = config.strategy.atrPeriod + 2;
  if (s.count < warmup) return null;
  if (!isFinite(s.atr) || s.atr <= 0) return null;

  const mins = etMinutesSinceMidnight(b.t);
  const hit = eligibleRange(s, mins);
  if (!hit) return null;

  const mid = (hit.r.high + hit.r.low) / 2;
  const widthPct = (hit.r.high - hit.r.low) / mid;
  if (widthPct < OR_WIDTH_MIN_PCT || widthPct > OR_WIDTH_MAX_PCT) return null;

  const longBreak = b.c > hit.r.high && b.c > s.vwap;
  const shortBreak = b.c < hit.r.low && b.c < s.vwap;

  let sig: Signal | null = null;
  if (longBreak && biasOk(s, b.c, "LONG")) {
    sig = {
      side: "LONG",
      atr: s.atr,
      reason: `ORBM range#${hit.def.id} long break ${hit.r.high.toFixed(2)} (orW=${(widthPct * 100).toFixed(2)}%)`,
      ts: b.t,
      entryPrice: b.c,
      stopPrice: hit.r.low,
    };
  } else if (shortBreak && biasOk(s, b.c, "SHORT")) {
    sig = {
      side: "SHORT",
      atr: s.atr,
      reason: `ORBM range#${hit.def.id} short break ${hit.r.low.toFixed(2)} (orW=${(widthPct * 100).toFixed(2)}%)`,
      ts: b.t,
      entryPrice: b.c,
      stopPrice: hit.r.high,
    };
  }
  if (sig) {
    hit.r.fired = true;
    s.activeRangeId = hit.def.id;
    s.lastSignal = sig;
  }
  return sig;
}

export function underlyingInvalidated(s: ORBMultiState, entrySide: "LONG" | "SHORT"): boolean {
  if (s.recent.length < 2 || s.activeRangeId === null) return false;
  const idx = s.ranges.findIndex((r) => r.id === s.activeRangeId);
  if (idx < 0) return false;
  const r = s.ranges[idx];
  if (!isFinite(r.high) || !isFinite(r.low)) return false;
  const last = s.recent[s.recent.length - 1].c;
  const prev = s.recent[s.recent.length - 2].c;
  if (entrySide === "LONG") return last < r.high && prev < r.high;
  return last > r.low && prev > r.low;
}
