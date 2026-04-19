import type { Bar, Signal } from "../types.js";
import { etDateKey, etMinutesSinceMidnight } from "../util/time.js";
import { config } from "../config.js";

const OR_START_MINS = 9 * 60 + 30;
const OR_END_MINS = 10 * 60;
const ENTRY_CLOSE_MINS = 12 * 60;
const RECENT_CAP = 10;

export interface ORBState {
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
  lastSignal?: Signal;
}

export function makeState(): ORBState {
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
    orHigh: -Infinity,
    orLow: Infinity,
    orReady: false,
    firedToday: false,
  };
}

function updateEMA(state: ORBState, close: number): void {
  const k = 2 / (config.strategy.emaPeriod + 1);
  state.prevEma = state.ema;
  if (!isFinite(state.ema)) state.ema = close;
  else state.ema = close * k + state.ema * (1 - k);
}

function updateATR(state: ORBState, b: Bar): void {
  const prev = isFinite(state.prevTrClose) ? state.prevTrClose : b.c;
  const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  const n = config.strategy.atrPeriod;
  if (!isFinite(state.atr)) state.atr = tr;
  else state.atr = (state.atr * (n - 1) + tr) / n;
  state.prevTrClose = b.c;
}

function updateVWAP(state: ORBState, b: Bar): void {
  const day = etDateKey(b.t);
  if (day !== state.vwapDay) {
    state.vwapDay = day;
    state.vwapCumPV = 0;
    state.vwapCumV = 0;
  }
  const tp = (b.h + b.l + b.c) / 3;
  state.vwapCumPV += tp * b.v;
  state.vwapCumV += b.v;
  state.vwap = state.vwapCumV === 0 ? tp : state.vwapCumPV / state.vwapCumV;
}

function updateOR(state: ORBState, b: Bar): void {
  const day = etDateKey(b.t);
  const mins = etMinutesSinceMidnight(b.t);
  if (day !== state.orDay) {
    state.orDay = day;
    state.orHigh = -Infinity;
    state.orLow = Infinity;
    state.orReady = false;
    state.firedToday = false;
  }
  if (mins >= OR_START_MINS && mins < OR_END_MINS) {
    state.orHigh = Math.max(state.orHigh, b.h);
    state.orLow = Math.min(state.orLow, b.l);
  } else if (
    mins >= OR_END_MINS &&
    isFinite(state.orHigh) &&
    isFinite(state.orLow) &&
    state.orHigh > state.orLow
  ) {
    state.orReady = true;
  }
}

export function onBar(state: ORBState, b: Bar): Signal | null {
  updateEMA(state, b.c);
  updateATR(state, b);
  updateVWAP(state, b);
  updateOR(state, b);
  state.recent.push(b);
  if (state.recent.length > RECENT_CAP) state.recent.shift();
  state.count++;

  const warmup = config.strategy.atrPeriod + 2;
  if (state.count < warmup) return null;
  if (!state.orReady || state.firedToday) return null;

  const mins = etMinutesSinceMidnight(b.t);
  if (mins < OR_END_MINS || mins >= ENTRY_CLOSE_MINS) return null;
  if (!isFinite(state.atr) || state.atr <= 0) return null;

  const longBreak = b.c > state.orHigh && b.c > state.vwap;
  const shortBreak = b.c < state.orLow && b.c < state.vwap;

  let sig: Signal | null = null;
  if (longBreak) {
    sig = {
      side: "LONG",
      atr: state.atr,
      reason: `ORB long break ${state.orHigh.toFixed(2)}`,
      ts: b.t,
      entryPrice: b.c,
      stopPrice: state.orLow,
    };
  } else if (shortBreak) {
    sig = {
      side: "SHORT",
      atr: state.atr,
      reason: `ORB short break ${state.orLow.toFixed(2)}`,
      ts: b.t,
      entryPrice: b.c,
      stopPrice: state.orHigh,
    };
  }
  if (sig) {
    state.firedToday = true;
    state.lastSignal = sig;
  }
  return sig;
}

export function underlyingInvalidated(state: ORBState, entrySide: "LONG" | "SHORT"): boolean {
  if (state.recent.length < 2 || !isFinite(state.orHigh) || !isFinite(state.orLow)) return false;
  const last = state.recent[state.recent.length - 1].c;
  const prev = state.recent[state.recent.length - 2].c;
  if (entrySide === "LONG") return last < state.orHigh && prev < state.orHigh;
  return last > state.orLow && prev > state.orLow;
}
