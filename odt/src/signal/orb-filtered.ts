import type { Bar, Signal } from "../types.js";
import { etDateKey, etMinutesSinceMidnight } from "../util/time.js";
import { defaultStrategyParams } from "../config.js";
import type { StrategyParams } from "../config.js";

const OR_START_MINS = 9 * 60 + 30;
const OR_END_MINS = 10 * 60;
const ENTRY_CLOSE_MINS = 12 * 60;
const RECENT_CAP = 10;

const OR_WIDTH_MIN_PCT = 0.0015;
const OR_WIDTH_MAX_PCT = 0.006;

export interface ORBFilteredState {
  params: StrategyParams;
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
  orHigh: number;
  orLow: number;
  orReady: boolean;
  firedToday: boolean;
  priorDayClose: number;
  runningLastClose: number;
  lastSignal?: Signal;
}

export function makeState(params: StrategyParams = defaultStrategyParams()): ORBFilteredState {
  return {
    params,
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
    orHigh: -Infinity,
    orLow: Infinity,
    orReady: false,
    firedToday: false,
    priorDayClose: NaN,
    runningLastClose: NaN,
  };
}

function updateEMA(s: ORBFilteredState, close: number): void {
  const k = 2 / (s.params.emaPeriod + 1);
  s.prevEma = s.ema;
  if (!isFinite(s.ema)) s.ema = close;
  else s.ema = close * k + s.ema * (1 - k);
}

function updateATR(s: ORBFilteredState, b: Bar): void {
  const prev = isFinite(s.prevTrClose) ? s.prevTrClose : b.c;
  const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  const n = s.params.atrPeriod;
  if (!isFinite(s.atr)) s.atr = tr;
  else s.atr = (s.atr * (n - 1) + tr) / n;
  s.prevTrClose = b.c;
}

function updateVWAP(s: ORBFilteredState, b: Bar): void {
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

function updateOR(s: ORBFilteredState, b: Bar): void {
  const day = etDateKey(b.t);
  const mins = etMinutesSinceMidnight(b.t);
  if (day !== s.orDay) {
    if (s.orDay !== "" && isFinite(s.runningLastClose)) {
      s.priorDayClose = s.runningLastClose;
    }
    s.orDay = day;
    s.orHigh = -Infinity;
    s.orLow = Infinity;
    s.orReady = false;
    s.firedToday = false;
  }
  if (mins >= OR_START_MINS && mins < OR_END_MINS) {
    s.orHigh = Math.max(s.orHigh, b.h);
    s.orLow = Math.min(s.orLow, b.l);
  } else if (
    mins >= OR_END_MINS &&
    isFinite(s.orHigh) &&
    isFinite(s.orLow) &&
    s.orHigh > s.orLow
  ) {
    s.orReady = true;
  }
  s.runningLastClose = b.c;
}

export function onBar(s: ORBFilteredState, b: Bar): Signal | null {
  updateEMA(s, b.c);
  updateATR(s, b);
  updateVWAP(s, b);
  updateOR(s, b);
  s.recent.push(b);
  if (s.recent.length > RECENT_CAP) s.recent.shift();
  s.count++;

  const warmup = s.params.atrPeriod + 2;
  if (s.count < warmup) return null;
  if (!s.orReady || s.firedToday) return null;

  const mins = etMinutesSinceMidnight(b.t);
  if (mins < OR_END_MINS || mins >= ENTRY_CLOSE_MINS) return null;
  if (!isFinite(s.atr) || s.atr <= 0) return null;

  const orMid = (s.orHigh + s.orLow) / 2;
  const orWidthPct = (s.orHigh - s.orLow) / orMid;
  if (orWidthPct < OR_WIDTH_MIN_PCT || orWidthPct > OR_WIDTH_MAX_PCT) return null;

  const longBreak = b.c > s.orHigh && b.c > s.vwap;
  const shortBreak = b.c < s.orLow && b.c < s.vwap;

  const biasOk = (side: "LONG" | "SHORT"): boolean => {
    if (!isFinite(s.priorDayClose)) return true;
    if (side === "LONG") return b.c > s.priorDayClose;
    return b.c < s.priorDayClose;
  };

  let sig: Signal | null = null;
  if (longBreak && biasOk("LONG")) {
    sig = {
      side: "LONG",
      atr: s.atr,
      reason: `ORBF long break ${s.orHigh.toFixed(2)} (orW=${(orWidthPct * 100).toFixed(2)}%)`,
      ts: b.t,
      entryPrice: b.c,
      stopPrice: s.orLow,
    };
  } else if (shortBreak && biasOk("SHORT")) {
    sig = {
      side: "SHORT",
      atr: s.atr,
      reason: `ORBF short break ${s.orLow.toFixed(2)} (orW=${(orWidthPct * 100).toFixed(2)}%)`,
      ts: b.t,
      entryPrice: b.c,
      stopPrice: s.orHigh,
    };
  }
  if (sig) {
    s.firedToday = true;
    s.lastSignal = sig;
  }
  return sig;
}

export function underlyingInvalidated(s: ORBFilteredState, entrySide: "LONG" | "SHORT"): boolean {
  if (s.recent.length < 2 || !isFinite(s.orHigh) || !isFinite(s.orLow)) return false;
  const last = s.recent[s.recent.length - 1].c;
  const prev = s.recent[s.recent.length - 2].c;
  if (entrySide === "LONG") return last < s.orHigh && prev < s.orHigh;
  return last > s.orLow && prev > s.orLow;
}
