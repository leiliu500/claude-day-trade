import type { Bar, Signal } from "../types.js";
import { etDateKey, etMinutesSinceMidnight } from "../util/time.js";
import { defaultStrategyParams } from "../config.js";
import type { StrategyParams } from "../config.js";

const ENTRY_WINDOW_OPEN = 10 * 60;
const ENTRY_WINDOW_CLOSE = 15 * 60 + 30;
const RECENT_CAP = 10;
const HTF_BUCKET_MINUTES = 15;

export interface HTFState {
  bucketStart: number;
  curClose: number;
  ema: number;
  prevEma: number;
  lastClose: number;
  closedBuckets: number;
}

export interface StrategyState {
  params: StrategyParams;
  recent: Bar[];
  count: number;
  ema: number;
  prevEma: number;
  prevClose: number;
  atr: number;
  prevTrClose: number;
  vwapCumPV: number;
  vwapCumV: number;
  vwapDay: string;
  vwap: number;
  htf: HTFState;
  lastSignal?: Signal;
}

export function makeState(params: StrategyParams = defaultStrategyParams()): StrategyState {
  return {
    params,
    recent: [],
    count: 0,
    ema: NaN,
    prevEma: NaN,
    prevClose: NaN,
    atr: NaN,
    prevTrClose: NaN,
    vwapCumPV: 0,
    vwapCumV: 0,
    vwapDay: "",
    vwap: NaN,
    htf: {
      bucketStart: 0,
      curClose: NaN,
      ema: NaN,
      prevEma: NaN,
      lastClose: NaN,
      closedBuckets: 0,
    },
  };
}

function updateEMA(state: StrategyState, close: number): void {
  const k = 2 / (state.params.emaPeriod + 1);
  state.prevEma = state.ema;
  if (!isFinite(state.ema)) state.ema = close;
  else state.ema = close * k + state.ema * (1 - k);
}

function updateATR(state: StrategyState, b: Bar): void {
  const prev = isFinite(state.prevTrClose) ? state.prevTrClose : b.c;
  const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  const n = state.params.atrPeriod;
  if (!isFinite(state.atr)) state.atr = tr;
  else state.atr = (state.atr * (n - 1) + tr) / n;
  state.prevTrClose = b.c;
}

function updateVWAP(state: StrategyState, b: Bar): void {
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

function updateHTF(state: StrategyState, b: Bar): void {
  const bucketMs = HTF_BUCKET_MINUTES * 60 * 1000;
  const bucketStart = Math.floor(b.t / bucketMs) * bucketMs;
  const h = state.htf;
  if (h.bucketStart === 0) {
    h.bucketStart = bucketStart;
    h.curClose = b.c;
    return;
  }
  if (bucketStart === h.bucketStart) {
    h.curClose = b.c;
    return;
  }
  const closedClose = h.curClose;
  const k = 2 / (state.params.emaPeriod + 1);
  h.prevEma = h.ema;
  if (!isFinite(h.ema)) h.ema = closedClose;
  else h.ema = closedClose * k + h.ema * (1 - k);
  h.lastClose = closedClose;
  h.closedBuckets++;
  h.bucketStart = bucketStart;
  h.curClose = b.c;
}

export function htfTrendAligned(state: StrategyState, side: "LONG" | "SHORT"): boolean {
  const h = state.htf;
  if (h.closedBuckets < state.params.emaPeriod + 2) return false;
  if (!isFinite(h.ema) || !isFinite(h.prevEma)) return false;
  if (side === "LONG") return h.ema > h.prevEma && h.lastClose > h.ema;
  return h.ema < h.prevEma && h.lastClose < h.ema;
}

export function onBar(state: StrategyState, b: Bar): Signal | null {
  updateHTF(state, b);
  updateEMA(state, b.c);
  updateATR(state, b);
  updateVWAP(state, b);
  state.recent.push(b);
  if (state.recent.length > RECENT_CAP) state.recent.shift();
  state.count++;

  const warmup = Math.max(state.params.emaPeriod + 5, state.params.atrPeriod + 2);
  if (state.count < warmup) {
    state.prevClose = b.c;
    return null;
  }

  const mins = etMinutesSinceMidnight(b.t);
  if (mins < ENTRY_WINDOW_OPEN || mins >= ENTRY_WINDOW_CLOSE) {
    state.prevClose = b.c;
    return null;
  }

  const prev = state.recent[state.recent.length - 2];
  if (!prev || !isFinite(state.prevEma) || !isFinite(state.atr) || state.atr <= 0) {
    state.prevClose = b.c;
    return null;
  }

  const trendUp = state.ema > state.prevEma && b.c > state.ema && b.c > state.vwap;
  const trendDown = state.ema < state.prevEma && b.c < state.ema && b.c < state.vwap;

  const lowestOfTwo = Math.min(prev.l, b.l);
  const highestOfTwo = Math.max(prev.h, b.h);
  const pulledBack = lowestOfTwo <= state.ema + 0.1 * state.atr && lowestOfTwo >= state.ema - 0.6 * state.atr;
  const pulledUp = highestOfTwo >= state.ema - 0.1 * state.atr && highestOfTwo <= state.ema + 0.6 * state.atr;

  const bullishReclaim = trendUp && pulledBack && b.c > state.prevClose && b.c > prev.h;
  const bearishRejection = trendDown && pulledUp && b.c < state.prevClose && b.c < prev.l;

  let sig: Signal | null = null;
  if (bullishReclaim && htfTrendAligned(state, "LONG")) {
    sig = {
      side: "LONG",
      atr: state.atr,
      reason: "trend-up + htf-align + pullback + reclaim",
      ts: b.t,
      entryPrice: b.c,
      stopPrice: b.c - 1.2 * state.atr,
    };
  } else if (bearishRejection && htfTrendAligned(state, "SHORT")) {
    sig = {
      side: "SHORT",
      atr: state.atr,
      reason: "trend-down + htf-align + pullback + rejection",
      ts: b.t,
      entryPrice: b.c,
      stopPrice: b.c + 1.2 * state.atr,
    };
  }
  if (sig) state.lastSignal = sig;
  state.prevClose = b.c;
  return sig;
}

export function underlyingInvalidated(state: StrategyState, entrySide: "LONG" | "SHORT"): boolean {
  if (!isFinite(state.ema) || !isFinite(state.atr) || state.recent.length < 2) return false;
  const buffer = 0.25 * state.atr;
  const last = state.recent[state.recent.length - 1].c;
  const prev = state.recent[state.recent.length - 2].c;
  if (entrySide === "LONG") {
    return last < state.ema - buffer && prev < state.ema - buffer;
  }
  return last > state.ema + buffer && prev > state.ema + buffer;
}
