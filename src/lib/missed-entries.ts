// Shared library for the missed-entry finder. Pure functions used by both the
// CLI (src/scripts/find-missed-entries.ts) and the dashboard
// (/api/missed-entries route). The CLI and dashboard each handle their own
// subprocess execution for backtest-day.ts; this module exposes parseBacktestJson
// to consume the resulting stdout.

import { config } from '../config.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type Bar = { ts: number; o: number; h: number; l: number; c: number; v: number };
export type Direction = 'long' | 'short';
export type Grade = 'A' | 'B' | 'C';

export interface DetectArgs {
  windowMin: number;
  minMfe: number;
  maxMae: number;
  minR: number;
  minVolMult: number;
}

export interface IdealEntry {
  ts: number;            // bar START ts (UTC ms). Decision time = barCloseTs(ts).
  direction: Direction;
  entryPrice: number;
  peakPrice: number;
  peakTs: number;
  mfePct: number;
  maePct: number;
  rMultiple: number;
  ttpMin: number;
  entryVolMult: number;
  grade: Grade;
}

export type BtStatus = 'confirmed' | 'blocked' | 'filtered';

export interface BtEntry {
  ts: number;
  direction: 'bullish' | 'bearish';
  confidence: number;    // 0..1
  mode: string;
  grade?: string;
  status: BtStatus;
  filterRule?: string;
}

export interface LiveSnapshot {
  ts: number;
  direction: 'bullish' | 'bearish';
  confidence: number;
  meets: boolean;
  alignment: string;
}

export interface LiveDispatch { ts: number; decision: string; }

export interface BtMatch { entry: BtEntry | null; }
export interface LiveMatch { peakSignal: LiveSnapshot | null; enterDispatch: LiveDispatch | null; }

export type Verdict =
  | 'BOTH_EXEC'
  | 'PARITY_GAP'
  | 'ALGO_GAP'
  | 'BLIND'
  | 'BT_ONLY_DETECT_LIVE_EXEC'
  | 'NO_DATA';

export interface VerifiedEntry {
  ideal: IdealEntry;
  bt: BtMatch | null;
  live: LiveMatch | null;
  verdict: Verdict;
}

// ── Date / TZ helpers (DST-aware) ───────────────────────────────────────────

export function todayET(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
}

export function etOffsetHours(dateET: string): number {
  const probe = new Date(`${dateET}T15:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = tz.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1]!, 10) : -5;
}

export function etToUtcISO(dateET: string, hh: number, mm: number): string {
  const off = etOffsetHours(dateET);
  const utcH = hh - off;
  return `${dateET}T${String(utcH).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
}

export function fmtET(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ts));
}

// Alpaca bar `t` is the bar START. Decision moment = ts + 60s.
export function barCloseTs(barStartTs: number): number { return barStartTs + 60_000; }

// Parse a backtest "HH:MM ET" or ISO string into UTC ms on the target date.
export function parseBtTime(timeStr: string, dateET: string): number {
  const m = timeStr.match(/^(\d{2}):(\d{2})/);
  if (m) {
    return new Date(etToUtcISO(dateET, parseInt(m[1]!, 10), parseInt(m[2]!, 10))).getTime();
  }
  return new Date(timeStr).getTime();
}

// ── Bar fetch ───────────────────────────────────────────────────────────────

export async function fetch1mBars(ticker: string, startISO: string, endISO: string): Promise<Bar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const out: Bar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', '1Min');
    url.searchParams.set('start', startISO);
    url.searchParams.set('end', endISO);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    for (const b of (json.bars || [])) {
      out.push({ ts: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    if (json.next_page_token) pageToken = json.next_page_token; else break;
  }
  return out;
}

// ── Phase 1: Ideal entry detection ──────────────────────────────────────────

interface EntryEval {
  direction: Direction;
  entryPrice: number;
  peakPrice: number;
  peakIdx: number;
  mfeAbs: number;
  maeAbsBeforePeak: number;
}

function evaluateEntry(bars: Bar[], i: number, direction: Direction, windowMin: number): EntryEval {
  const start = bars[i]!;
  const entry = start.c;
  const endIdx = Math.min(i + windowMin, bars.length - 1);
  let mfeAbs = 0, maeBeforePeak = 0, runningMae = 0, peakIdx = i, peakPrice = entry;
  for (let j = i + 1; j <= endIdx; j++) {
    const b = bars[j]!;
    if (direction === 'long') {
      runningMae = Math.max(runningMae, entry - b.l);
      const fav = b.h - entry;
      if (fav > mfeAbs) { mfeAbs = fav; maeBeforePeak = runningMae; peakIdx = j; peakPrice = b.h; }
    } else {
      runningMae = Math.max(runningMae, b.h - entry);
      const fav = entry - b.l;
      if (fav > mfeAbs) { mfeAbs = fav; maeBeforePeak = runningMae; peakIdx = j; peakPrice = b.l; }
    }
  }
  return { direction, entryPrice: entry, peakPrice, peakIdx, mfeAbs, maeAbsBeforePeak: maeBeforePeak };
}

function gradeEntry(mfePct: number, maePct: number, ttpMin: number, args: DetectArgs): Grade | null {
  const r = mfePct / Math.max(maePct, 0.01);
  if (mfePct < args.minMfe) return null;
  if (maePct > args.maxMae) return null;
  if (r < args.minR) return null;
  if (mfePct >= 0.40 && r >= 4.0 && ttpMin <= 30) return 'A';
  if (mfePct >= 0.25 && r >= 2.5) return 'B';
  return 'C';
}

export function findIdealEntries(bars: Bar[], args: DetectArgs): IdealEntry[] {
  const avgVol = bars.length > 0 ? bars.reduce((s, b) => s + b.v, 0) / bars.length : 1;
  const entries: IdealEntry[] = [];
  let i = 0;
  while (i < bars.length - 1) {
    const start = bars[i]!;
    const longEval = evaluateEntry(bars, i, 'long', args.windowMin);
    const shortEval = evaluateEntry(bars, i, 'short', args.windowMin);
    const candidates: IdealEntry[] = [];
    // Momentum confirmation: bar i (the decision bar where the marker lands)
    // must close in the trade direction, AND at least 3 of the last 5 bars
    // must match direction. Both checks together ensure the marker sits on
    // a direction-matching candle inside a directionally-confirmed stretch.
    const barIsGreen = start.c > start.o;
    const barIsRed = start.c < start.o;
    const lookback = 5, minMatch = 3;
    const lo = Math.max(0, i - (lookback - 1));
    let greenCount = 0, redCount = 0;
    for (let k = lo; k <= i; k++) {
      const b = bars[k]!;
      if (b.c > b.o) greenCount++;
      else if (b.c < b.o) redCount++;
    }
    for (const ev of [longEval, shortEval]) {
      if (ev.direction === 'long' && (!barIsGreen || greenCount < minMatch)) continue;
      if (ev.direction === 'short' && (!barIsRed || redCount < minMatch)) continue;
      const mfePct = (ev.mfeAbs / ev.entryPrice) * 100;
      const maePct = (ev.maeAbsBeforePeak / ev.entryPrice) * 100;
      const ttpMin = (bars[ev.peakIdx]!.ts - start.ts) / 60_000;
      const grade = gradeEntry(mfePct, maePct, ttpMin, args);
      if (!grade) continue;
      const entryVolMult = start.v / Math.max(avgVol, 1);
      if (entryVolMult < args.minVolMult) continue;
      candidates.push({
        ts: start.ts, direction: ev.direction, entryPrice: ev.entryPrice,
        peakPrice: ev.peakPrice, peakTs: bars[ev.peakIdx]!.ts,
        mfePct, maePct, rMultiple: mfePct / Math.max(maePct, 0.01),
        ttpMin, entryVolMult, grade,
      });
    }
    if (candidates.length === 0) { i++; continue; }
    candidates.sort((a, b) => {
      const ga = { A: 3, B: 2, C: 1 }[a.grade];
      const gb = { A: 3, B: 2, C: 1 }[b.grade];
      if (ga !== gb) return gb - ga;
      return b.mfePct - a.mfePct;
    });
    const best = candidates[0]!;
    entries.push(best);
    const peakIdx = bars.findIndex(b => b.ts === best.peakTs);
    i = (peakIdx > i ? peakIdx : i) + 1;
  }
  return entries;
}

// ── Phase 2: Backtest JSON parsing (subprocess execution lives in caller) ───

// Caller spawns backtest-day.{ts|js} with --json. Pass its stdout to this fn.
// Returns null if the JSON marker is missing or malformed (caller should log/fallback).
export function parseBacktestJson(stdout: string, dateET: string): BtEntry[] | null {
  const m = stdout.match(/__JSON_START__([\s\S]*?)__JSON_END__/);
  if (!m) return null;
  let data: any;
  try { data = JSON.parse(m[1]!); } catch { return null; }
  const entries: BtEntry[] = [];
  for (const e of (data.confirmed ?? [])) {
    entries.push({
      ts: parseBtTime(e.timeET ?? e.time, dateET),
      direction: e.direction, confidence: Number(e.confidence) || 0,
      mode: e.mode ?? '', grade: e.grade, status: 'confirmed',
    });
  }
  for (const e of (data.blocked ?? [])) {
    entries.push({
      ts: parseBtTime(e.timeET ?? e.time, dateET),
      direction: e.direction, confidence: Number(e.confidence) || 0,
      mode: e.mode ?? '', grade: e.grade, status: 'blocked',
    });
  }
  for (const e of (data.filtered ?? [])) {
    entries.push({
      ts: parseBtTime(e.timeET ?? e.time, dateET),
      direction: e.direction, confidence: Number(e.confidence) || 0,
      mode: e.mode ?? '', grade: e.grade, status: 'filtered',
      filterRule: e.filterRule,
    });
  }
  return entries;
}

// ── Phase 3: Live DB layer ──────────────────────────────────────────────────

// `closePool=true` → creates a fresh pool and ends it. Use false when called
// from a long-running process that already has a shared pool (e.g., dashboard).
export async function fetchLiveLayer(
  ticker: string,
  date: string,
  options: { closePool?: boolean } = {},
): Promise<{ signals: LiveSnapshot[]; dispatches: LiveDispatch[] } | null> {
  const closePool = options.closePool ?? true;
  let pool: any;
  try {
    const mod = await import('../db/client.js');
    pool = mod.getPool();
    const sigs = await pool.query(
      `SELECT created_at, direction, confidence::float8 AS confidence,
              confidence_meets_threshold AS meets, alignment
       FROM trading.signal_snapshots
       WHERE ticker = $1 AND trade_date = $2
       ORDER BY created_at`,
      [ticker, date]
    );
    const disps = await pool.query(
      `SELECT created_at, orchestrator_decision AS decision
       FROM trading.order_agent_dispatches
       WHERE ticker = $1
         AND (created_at AT TIME ZONE 'America/New_York')::date = $2::date
       ORDER BY created_at`,
      [ticker, date]
    );
    if (closePool) await pool.end();
    return {
      signals: sigs.rows.map((r: any) => ({
        ts: new Date(r.created_at).getTime(), direction: r.direction,
        confidence: Number(r.confidence), meets: r.meets, alignment: r.alignment,
      })),
      dispatches: disps.rows.map((r: any) => ({
        ts: new Date(r.created_at).getTime(), decision: r.decision,
      })),
    };
  } catch (e) {
    if (pool && closePool) try { await pool.end(); } catch {}
    throw e;
  }
}

// ── Verification matching ───────────────────────────────────────────────────

export const MATCH_WINDOW_MS = 5 * 60_000;

export function dirMatches(human: Direction, sys: 'bullish' | 'bearish'): boolean {
  return (human === 'long' && sys === 'bullish') || (human === 'short' && sys === 'bearish');
}

export function matchBacktest(ideal: IdealEntry, bt: BtEntry[]): BtMatch {
  const target = barCloseTs(ideal.ts);
  let best: BtEntry | null = null;
  let bestScore = -Infinity;
  for (const e of bt) {
    if (!dirMatches(ideal.direction, e.direction)) continue;
    if (Math.abs(e.ts - target) > MATCH_WINDOW_MS) continue;
    const statusRank = { confirmed: 3, blocked: 2, filtered: 1 }[e.status];
    const proximity = 1 - Math.abs(e.ts - target) / MATCH_WINDOW_MS;
    const score = statusRank * 10 + proximity;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return { entry: best };
}

export function matchLive(ideal: IdealEntry, signals: LiveSnapshot[], dispatches: LiveDispatch[]): LiveMatch {
  const target = barCloseTs(ideal.ts);
  let peak: LiveSnapshot | null = null;
  for (const s of signals) {
    if (!dirMatches(ideal.direction, s.direction)) continue;
    if (Math.abs(s.ts - target) > MATCH_WINDOW_MS) continue;
    if (!peak || s.confidence > peak.confidence) peak = s;
  }
  let enter: LiveDispatch | null = null;
  for (const d of dispatches) {
    if (d.decision !== 'ENTER') continue;
    if (Math.abs(d.ts - target) > MATCH_WINDOW_MS) continue;
    if (!enter || Math.abs(d.ts - target) < Math.abs(enter.ts - target)) enter = d;
  }
  return { peakSignal: peak, enterDispatch: enter };
}

export function classifyVerdict(bt: BtMatch | null, live: LiveMatch | null): Verdict {
  if (!bt && !live) return 'NO_DATA';
  const btEntered = bt?.entry?.status === 'confirmed';
  const liveEntered = live?.enterDispatch != null;
  if (btEntered && liveEntered) return 'BOTH_EXEC';
  if (btEntered && !liveEntered) return 'PARITY_GAP';
  if (!btEntered && liveEntered) return 'BT_ONLY_DETECT_LIVE_EXEC';
  const sawAnything = (bt?.entry != null) || (live?.peakSignal != null);
  return sawAnything ? 'ALGO_GAP' : 'BLIND';
}

// ── Session-window helper ───────────────────────────────────────────────────

export function sessionWindowUTC(dateET: string, includeETH = false): { startUTC: string; endUTC: string } {
  const startHH = includeETH ? 4 : 9;
  const startMM = includeETH ? 0 : 30;
  const endHH = includeETH ? 20 : 16;
  return {
    startUTC: etToUtcISO(dateET, startHH, startMM),
    endUTC: etToUtcISO(dateET, endHH, 0),
  };
}
