/**
 * parity-report.ts — Structured live↔backtest parity check (6 layers).
 *
 * For a given (date, ticker), compares:
 *   1. DATA       — bars recorded by live (signal_payload.timeframes[].bars) vs Alpaca REST
 *   2. INDICATORS — recorded DMI vs computeDMI re-run on REST bars
 *   3. DIRECTION  — recorded direction vs detectDirection() walked over recorded bars + mode override
 *   4. CONFIDENCE — live snapshot confidence vs nearest backtest tick confidence
 *   5. DECISION   — live decision_type/gate vs backtest gate result (PASSED, STAGE-1, ...)
 *   6. ENTRY      — confirmed live entries vs backtest confirmed entries (matched / live-only / bt-only)
 *
 * Layers 1-3 are fast (DB + REST). Layers 4-6 spawn `backtest-day --json` (~30-90s).
 *
 * Usage:
 *   npx tsx src/scripts/parity-report.ts <YYYY-MM-DD> <TICKER> [--json] [--skip-backtest]
 *
 * --json           emit `__JSON_START__{...}__JSON_END__` for dashboard consumption
 * --skip-backtest  run only layers 1-3 (no backtest invocation)
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import { computeDMI } from '../indicators/dmi.js';
import { detectDirection, type PersistenceState } from '../lib/direction-detector.js';
import { computeTimeframeIndicators } from '../agents/signal-agent.js';
import { getTickerConfig } from '../ticker-configs.js';
import type { OHLCVBar, AlpacaBarsResponse } from '../types/market.js';
import { normalizeAlpacaBars } from '../types/market.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const TARGET_DATE = process.argv[2];
const TICKER = process.argv[3];
const JSON_OUT = process.argv.includes('--json');
const SKIP_BT = process.argv.includes('--skip-backtest');

if (!TARGET_DATE || !TICKER) {
  console.error('Usage: npx tsx src/scripts/parity-report.ts <YYYY-MM-DD> <TICKER> [--json] [--skip-backtest]');
  process.exit(1);
}

// ── Types ──────────────────────────────────────────────────────────────────
interface RecordedBar { timestamp: string; open: number; high: number; low: number; close: number; volume: number; }
interface RecordedDmi { adx: number; plusDI: number; minusDI: number; trend: string; }
interface RecordedTimeframe { timeframe: string; bars: RecordedBar[]; dmi: RecordedDmi; }
interface SnapshotRow {
  id: string;
  created_at: Date;
  direction: 'bullish' | 'bearish' | 'neutral';
  alignment: string;
  confidence: string;
  confidence_meets_threshold: boolean;
  signal_payload: { timeframes: RecordedTimeframe[]; signalMode?: string };
}
interface DecisionRow {
  id: string;
  signal_snapshot_id: string | null;
  decision_type: string;
  direction: string | null;
  confirmation_count: number;
  orchestration_confidence: string | null;
  reasoning: string | null;
  should_execute: boolean;
  entry_strategy: { stage?: string; notes?: string } | null;
  created_at: Date;
}
interface BtEntry {
  time: string;
  timeET: string;
  direction: string;
  mode: string;
  confidence: number;
  price: number;
  grade?: string;
  gate?: string;
}
interface BtSummary { date: string; ticker: string; confirmed: BtEntry[]; blocked: BtEntry[]; filtered: BtEntry[] }

interface LayerResult { pass: boolean; summary: string; details: unknown }
interface Report {
  date: string;
  ticker: string;
  ranAt: string;
  liveSnapshots: number;
  liveDecisions: number;
  skippedBacktest: boolean;
  overallPass: boolean;
  layers: {
    data: LayerResult;
    indicators: LayerResult;
    direction: LayerResult;
    confidence: LayerResult;
    decision: LayerResult;
    entry: LayerResult;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────
const TF_LABELS = ['LTF', 'MTF', 'HTF'] as const;
const ALPACA_TF: Record<string, string> = { '1m': '1Min', '3m': '3Min', '5m': '5Min' };
// Periods to match what signal-agent stores in signal_payload (LTF=8, others=14).
const DMI_PERIODS: Record<string, number> = { '1m': 8, '3m': 14, '5m': 14 };

function utcToET(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function etToMin(et: string): number {
  const [h, m] = et.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isRegularSession(iso: string): boolean {
  const mins = etToMin(utcToET(iso));
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function fetchRest(ticker: string, timeframe: string, start: string, end: string): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const out: OHLCVBar[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]!);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca ${res.status}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    out.push(...normalizeAlpacaBars(data));
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);
  return out;
}

// ── Layer 1: DATA parity (bars) ─────────────────────────────────────────
interface TfDataResult {
  label: string; timeframe: string;
  liveCount: number; restCount: number;
  matching: number; presenceMisses: number; restOnly: number;
  ohlcMisses: number; worstDelta: number; worstDeltaTs: string | null;
}

function diffBars(liveBars: RecordedBar[], restAll: OHLCVBar[]): Omit<TfDataResult, 'label' | 'timeframe'> {
  if (liveBars.length === 0) {
    return { liveCount: 0, restCount: 0, matching: 0, presenceMisses: 0, restOnly: 0, ohlcMisses: 0, worstDelta: 0, worstDeltaTs: null };
  }
  const liveFirst = new Date(liveBars[0]!.timestamp).getTime();
  const liveLast = new Date(liveBars[liveBars.length - 1]!.timestamp).getTime();
  const restWindow = restAll.filter(b => {
    const ts = new Date(b.timestamp).getTime();
    return ts >= liveFirst && ts <= liveLast;
  });
  const tsKey = (s: string) => new Date(s).getTime();
  const liveByTs = new Map<number, RecordedBar>();
  for (const b of liveBars) liveByTs.set(tsKey(b.timestamp), b);
  const restByTs = new Map<number, OHLCVBar>();
  for (const b of restWindow) restByTs.set(tsKey(b.timestamp), b);
  let matching = 0, presenceMisses = 0, ohlcMisses = 0;
  let worstDelta = 0;
  let worstDeltaTs: string | null = null;
  for (const ts of liveByTs.keys()) {
    if (!restByTs.has(ts)) { presenceMisses++; continue; }
    matching++;
    const lb = liveByTs.get(ts)!;
    const rb = restByTs.get(ts)!;
    const delta = Math.max(
      Math.abs(lb.open - rb.open),
      Math.abs(lb.high - rb.high),
      Math.abs(lb.low - rb.low),
      Math.abs(lb.close - rb.close),
    );
    if (delta > 0.001) {
      ohlcMisses++;
      if (delta > worstDelta) { worstDelta = delta; worstDeltaTs = lb.timestamp; }
    }
  }
  let restOnly = 0;
  for (const ts of restByTs.keys()) if (!liveByTs.has(ts)) restOnly++;
  return { liveCount: liveBars.length, restCount: restWindow.length, matching, presenceMisses, restOnly, ohlcMisses, worstDelta, worstDeltaTs };
}

// ── Layer 4-6: backtest invocation + parsing ────────────────────────────
async function runBacktest(date: string, ticker: string): Promise<BtSummary | null> {
  // Prefer compiled .js (matches the dashboard's backtest invocation path); fall back to .ts.
  const scriptJs = join(__dirname, 'backtest-day.js');
  let scriptPath = scriptJs;
  try {
    const { existsSync } = await import('fs');
    if (!existsSync(scriptJs)) scriptPath = join(__dirname, 'backtest-day.ts');
  } catch { /* default path */ }

  const args = scriptPath.endsWith('.ts')
    ? ['tsx', scriptPath, date, ticker, '--json', '--no-cache']
    : [scriptPath, date, ticker, '--json', '--no-cache'];
  const cmd = scriptPath.endsWith('.ts') ? 'npx' : process.execPath;

  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 180_000, maxBuffer: 100 * 1024 * 1024, env: { ...process.env },
  });
  const m = stdout.match(/__JSON_START__(.*?)__JSON_END__/s);
  if (!m) return null;
  return JSON.parse(m[1]!) as BtSummary;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<Report> {
  const ranAt = new Date().toISOString();
  const pool = getPool();

  const { rows: snaps } = await pool.query<SnapshotRow>(
    `SELECT id, created_at, direction, alignment, confidence::text,
            confidence_meets_threshold, signal_payload
     FROM trading.signal_snapshots
     WHERE ticker=$1 AND trade_date=$2
     ORDER BY created_at ASC`,
    [TICKER, TARGET_DATE]
  );
  const { rows: decisions } = await pool.query<DecisionRow>(
    `SELECT id, signal_snapshot_id, decision_type, direction, confirmation_count,
            orchestration_confidence::text, reasoning, should_execute, entry_strategy, created_at
     FROM trading.trading_decisions
     WHERE ticker=$1 AND trade_date=$2
     ORDER BY created_at ASC`,
    [TICKER, TARGET_DATE]
  );

  // Initialize with "no data" defaults; layers below mutate.
  const layers: Report['layers'] = {
    data:       { pass: true, summary: 'no live snapshots', details: { perTf: [], snapshotsCompared: 0 } },
    indicators: { pass: true, summary: 'no live snapshots', details: { perSnapshot: [] } },
    direction:  { pass: true, summary: 'no live snapshots', details: { walkMatches: 0, walkTotal: 0, walkMismatches: [] } },
    confidence: { pass: true, summary: SKIP_BT ? 'skipped' : 'no backtest', details: { samples: [], avgGap: 0, maxGap: 0 } },
    decision:   { pass: true, summary: SKIP_BT ? 'skipped' : 'no backtest', details: { live: {}, bt: {}, alignment: {} } },
    entry:      { pass: true, summary: SKIP_BT ? 'skipped' : 'no backtest', details: { matched: [], btOnly: [], liveOnly: [] } },
  };

  if (snaps.length === 0) {
    await closePool();
    return {
      date: TARGET_DATE!, ticker: TICKER!, ranAt,
      liveSnapshots: 0, liveDecisions: decisions.length,
      skippedBacktest: SKIP_BT, overallPass: true, layers,
    };
  }

  // ── REST fetch (single-shot for full warmup window) ────────────────────
  const startWarmup = new Date(new Date(TARGET_DATE!).getTime() - 6 * 86400_000).toISOString();
  const end = new Date().toISOString();
  const [rest1m, rest3m, rest5m] = await Promise.all([
    fetchRest(TICKER!, '1m', startWarmup, end),
    fetchRest(TICKER!, '3m', startWarmup, end),
    fetchRest(TICKER!, '5m', startWarmup, end),
  ]);
  const rest1mF = rest1m.filter(b => isRegularSession(b.timestamp));
  const rest3mF = rest3m.filter(b => isRegularSession(b.timestamp));
  const rest5mF = rest5m.filter(b => isRegularSession(b.timestamp));
  const restByLabel: Record<string, OHLCVBar[]> = { LTF: rest1mF, MTF: rest3mF, HTF: rest5mF };

  // ── Layer 1+2: DATA + INDICATORS — sample 6 evenly-spaced + most recent ─
  const picks: SnapshotRow[] = [];
  const stride = Math.max(1, Math.floor(snaps.length / 6));
  for (let i = 0; i < snaps.length && picks.length < 6; i += stride) picks.push(snaps[i]!);
  if (picks[picks.length - 1] !== snaps[snaps.length - 1]) picks.push(snaps[snaps.length - 1]!);

  const dataPerTf: TfDataResult[] = [];
  const indicatorsPerSnapshot: Array<{
    tickET: string;
    perTf: Array<{ label: string; timeframe: string; liveDmi: RecordedDmi; restDmi: RecordedDmi; dmiMatch: boolean }>;
  }> = [];

  for (const snap of picks) {
    const tickET = utcToET(snap.created_at);
    const tfs = snap.signal_payload?.timeframes ?? [];
    const perTfInd: { label: string; timeframe: string; liveDmi: RecordedDmi; restDmi: RecordedDmi; dmiMatch: boolean }[] = [];
    for (let i = 0; i < 3; i++) {
      const tf = tfs[i];
      if (!tf) continue;
      const label = TF_LABELS[i]!;
      const restAll = restByLabel[label]!;
      const dataDiff = diffBars(tf.bars, restAll);
      dataPerTf.push({ label, timeframe: tf.timeframe, ...dataDiff });

      // Re-run DMI on the rest-window slice to compare against live's recorded DMI.
      const liveFirst = tf.bars.length > 0 ? new Date(tf.bars[0]!.timestamp).getTime() : 0;
      const liveLast = tf.bars.length > 0 ? new Date(tf.bars[tf.bars.length - 1]!.timestamp).getTime() : 0;
      const restWindow = restAll.filter(b => {
        const ts = new Date(b.timestamp).getTime();
        return ts >= liveFirst && ts <= liveLast;
      });
      const period = DMI_PERIODS[tf.timeframe] ?? 14;
      const recompRest = computeDMI(restWindow, period, true);
      const dmiMatch =
        recompRest.trend === tf.dmi.trend &&
        Math.abs(recompRest.adx - tf.dmi.adx) < 0.5 &&
        Math.abs(recompRest.plusDI - tf.dmi.plusDI) < 0.5 &&
        Math.abs(recompRest.minusDI - tf.dmi.minusDI) < 0.5;
      perTfInd.push({
        label, timeframe: tf.timeframe,
        liveDmi: tf.dmi,
        restDmi: { adx: recompRest.adx, plusDI: recompRest.plusDI, minusDI: recompRest.minusDI, trend: recompRest.trend },
        dmiMatch,
      });
    }
    indicatorsPerSnapshot.push({ tickET, perTf: perTfInd });
  }

  // Layer 1 verdict
  const dataAgg = dataPerTf.reduce(
    (acc, r) => ({
      presenceMisses: acc.presenceMisses + r.presenceMisses,
      restOnly: acc.restOnly + r.restOnly,
      ohlcMisses: acc.ohlcMisses + r.ohlcMisses,
      worst: Math.max(acc.worst, r.worstDelta),
    }),
    { presenceMisses: 0, restOnly: 0, ohlcMisses: 0, worst: 0 },
  );
  const dataPass = dataAgg.ohlcMisses === 0 && dataAgg.presenceMisses <= 2;
  layers.data = {
    pass: dataPass,
    summary: dataPass
      ? `OK: ${dataPerTf.length} timeframe-slices match (${dataAgg.presenceMisses} presence trim, worst Δ=${dataAgg.worst.toFixed(4)})`
      : `DRIFT: ${dataAgg.ohlcMisses} OHLC mismatches, ${dataAgg.presenceMisses} live-only, ${dataAgg.restOnly} rest-only (worst Δ=${dataAgg.worst.toFixed(4)})`,
    details: { perTf: dataPerTf, snapshotsCompared: picks.length },
  };

  // Layer 2 verdict
  const dmiTotal = indicatorsPerSnapshot.flatMap(s => s.perTf).length;
  const dmiBad = indicatorsPerSnapshot.flatMap(s => s.perTf).filter(t => !t.dmiMatch).length;
  const indPass = dmiBad === 0;
  layers.indicators = {
    pass: indPass,
    summary: indPass
      ? `OK: all ${dmiTotal} DMI recomputations within thresh (Δadx<0.5, Δdi<0.5)`
      : `DRIFT: ${dmiBad}/${dmiTotal} DMI mismatches (recompute on REST != live's recorded DMI)`,
    details: { perSnapshot: indicatorsPerSnapshot, total: dmiTotal, mismatches: dmiBad },
  };

  // ── Layer 3: DIRECTION — full walk over live's recorded bars ───────────
  const persistence: PersistenceState = { dir: null, ts: 0 };
  let walkMatches = 0;
  let walkTotal = 0;
  const walkMismatches: Array<{ tickET: string; live: string; replay: string }> = [];
  for (const snap of snaps) {
    const tfs = snap.signal_payload?.timeframes;
    if (!tfs || tfs.length < 3) continue;
    const ltf: OHLCVBar[] = tfs[0]!.bars.map(b => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const mtf: OHLCVBar[] = tfs[1]!.bars.map(b => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const htf: OHLCVBar[] = tfs[2]!.bars.map(b => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    if (ltf.length < 14 || mtf.length < 14 || htf.length < 14) continue;
    const tickTs = snap.created_at.getTime();
    const dr = detectDirection(ltf, mtf, htf, true, persistence, tickTs);
    let direction = dr.direction;
    // Replicate signal-agent.ts mode-evaluator override.
    const tickerCfg = getTickerConfig(TICKER!);
    const tfIndicators = [
      computeTimeframeIndicators(ltf, '1m', direction, true),
      computeTimeframeIndicators(mtf, '3m', direction, false),
      computeTimeframeIndicators(htf, '5m', direction, false),
    ];
    const currentPrice = ltf[ltf.length - 1]!.close;
    const modeResult = tickerCfg.strategy.detectMode(tfIndicators, direction, currentPrice);
    if (modeResult.direction && !dr.leadingSignalOverride && !dr.reversalOverride) {
      direction = modeResult.direction;
    }
    walkTotal++;
    if (direction === snap.direction) walkMatches++;
    else if (walkMismatches.length < 50) {
      walkMismatches.push({ tickET: utcToET(snap.created_at), live: snap.direction, replay: direction });
    }
  }
  const walkPct = walkTotal > 0 ? walkMatches / walkTotal : 1;
  const dirPass = walkPct >= 0.99;
  layers.direction = {
    pass: dirPass,
    summary: walkTotal === 0
      ? 'no walk-eligible snapshots (insufficient bars)'
      : `${walkMatches}/${walkTotal} (${(walkPct * 100).toFixed(1)}%) match — ${walkMismatches.length} mismatches`,
    details: { walkMatches, walkTotal, walkMismatches },
  };

  // ── Layers 4-6 require backtest ────────────────────────────────────────
  let bt: BtSummary | null = null;
  if (!SKIP_BT) {
    try {
      bt = await runBacktest(TARGET_DATE!, TICKER!);
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 200) ?? String(e);
      layers.confidence.summary = `backtest failed: ${msg}`;
      layers.decision.summary = `backtest failed: ${msg}`;
      layers.entry.summary = `backtest failed: ${msg}`;
      layers.confidence.pass = false;
      layers.decision.pass = false;
      layers.entry.pass = false;
    }
  }

  if (bt) {
    const allBt: Array<BtEntry & { kind: 'confirmed' | 'blocked' | 'filtered' }> = [
      ...bt.confirmed.map(e => ({ ...e, kind: 'confirmed' as const })),
      ...bt.blocked.map(e => ({ ...e, kind: 'blocked' as const })),
      ...bt.filtered.map(e => ({ ...e, kind: 'filtered' as const })),
    ];

    // ── Layer 4: CONFIDENCE — pair each backtest tick with nearest live snapshot ──
    const confSamples: Array<{ tickET: string; liveConf: number; btConf: number; gap: number; direction: string; mode: string }> = [];
    for (const e of allBt) {
      if (!e.timeET) continue;
      const btMin = etToMin(e.timeET);
      let closestSnap: SnapshotRow | null = null;
      let closestDiff = Infinity;
      for (const s of snaps) {
        const sMin = etToMin(utcToET(s.created_at));
        const diff = Math.abs(sMin - btMin);
        if (diff <= 2 && diff < closestDiff) { closestDiff = diff; closestSnap = s; }
      }
      if (!closestSnap) continue;
      const liveConf = parseFloat(closestSnap.confidence);
      const gap = e.confidence - liveConf;
      confSamples.push({ tickET: e.timeET, liveConf, btConf: e.confidence, gap, direction: e.direction, mode: e.mode });
    }
    const confAvgGap = confSamples.length > 0 ? confSamples.reduce((a, x) => a + x.gap, 0) / confSamples.length : 0;
    const confMaxGap = confSamples.reduce((a, x) => Math.max(a, Math.abs(x.gap)), 0);
    const confPass = confMaxGap < 0.05;
    layers.confidence = {
      pass: confPass,
      summary: confSamples.length === 0
        ? 'no overlap between live snapshots and backtest ticks'
        : `${confSamples.length} samples, avg gap ${(confAvgGap * 100).toFixed(2)}pp, max |gap| ${(confMaxGap * 100).toFixed(2)}pp`,
      details: { samples: confSamples.slice(0, 200), totalSamples: confSamples.length, avgGap: confAvgGap, maxGap: confMaxGap },
    };

    // ── Layer 5: DECISION — gate-result alignment ──
    function btGateOf(e: BtEntry & { kind: string }): string {
      if (e.gate) return e.gate;
      return e.kind === 'confirmed' ? 'PASSED' : e.kind === 'blocked' ? 'BLOCKED' : 'FILTERED';
    }
    function liveGateOf(d: DecisionRow): string {
      const r = d.reasoning ?? '';
      if (r.includes('[STAGE-1 OBSERVE]')) return 'STAGE1_OBSERVE';
      if (r.includes('[WEAKENING-SIGNAL BLOCK]')) return 'WEAKENING_BLOCK';
      if (r.includes('[STALE-SIGNAL BLOCK]')) return 'STALE_BLOCK';
      if (r.includes('[PHASE-CHANGE OVERRIDE]')) return 'PHASE_CHANGE_OVERRIDE';
      if (r.includes('[HIGH-CONV')) return 'HIGH_CONV_OVERRIDE';
      if (d.entry_strategy?.stage === 'OVERRIDE_ENTRY') return 'OVERRIDE_ENTRY';
      if (d.decision_type === 'NEW_ENTRY' && d.should_execute) return 'PASSED';
      if (d.decision_type === 'WAIT') return 'AI_WAIT';
      return d.decision_type;
    }
    const decisionRows: Array<{ tickET: string; direction: string; btGate: string; liveGate: string | null; agree: boolean }> = [];
    for (const e of allBt) {
      const btMin = etToMin(e.timeET);
      let closest: DecisionRow | null = null;
      let closestDiff = Infinity;
      for (const d of decisions) {
        if (d.direction !== e.direction) continue;
        const dMin = etToMin(utcToET(d.created_at));
        const diff = Math.abs(dMin - btMin);
        if (diff <= 3 && diff < closestDiff) { closestDiff = diff; closest = d; }
      }
      const btGate = btGateOf(e);
      const liveGate = closest ? liveGateOf(closest) : null;
      const agree = liveGate !== null && (
        (liveGate === btGate) ||
        // PASSED-equivalent overrides treated as agreement.
        (['PASSED', 'HIGH_CONV_OVERRIDE', 'PHASE_CHANGE_OVERRIDE', 'OVERRIDE_ENTRY'].includes(btGate) &&
         ['PASSED', 'HIGH_CONV_OVERRIDE', 'PHASE_CHANGE_OVERRIDE', 'OVERRIDE_ENTRY'].includes(liveGate))
      );
      decisionRows.push({ tickET: e.timeET, direction: e.direction, btGate, liveGate, agree });
    }
    const decAgree = decisionRows.filter(r => r.agree).length;
    const decTotal = decisionRows.filter(r => r.liveGate !== null).length;
    const decPct = decTotal > 0 ? decAgree / decTotal : 1;
    const decPass = decPct >= 0.80;
    layers.decision = {
      pass: decPass,
      summary: decTotal === 0
        ? `${decisionRows.length} backtest ticks, 0 with a live decision within ±3min`
        : `${decAgree}/${decTotal} (${(decPct * 100).toFixed(1)}%) gate-agree across same-direction live decisions`,
      details: {
        rows: decisionRows.slice(0, 200),
        totalBt: decisionRows.length, withLive: decTotal, agree: decAgree,
        live: { entries: decisions.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute).length },
        bt: { confirmed: bt.confirmed.length, blocked: bt.blocked.length, filtered: bt.filtered.length },
      },
    };

    // ── Layer 6: ENTRY — confirmed-vs-confirmed match ──
    const liveEntries = decisions.filter(d => d.decision_type === 'NEW_ENTRY' && d.should_execute);
    type EntryRow = { timeET: string; direction: string; confidence: number; price?: number; mode?: string };
    const matched: Array<{ live: EntryRow; bt: EntryRow; diffMin: number; confGap: number }> = [];
    const btOnly: Array<EntryRow & { grade?: string }> = [];
    const liveOnly: Array<EntryRow> = [];
    const usedLiveIds = new Set<string>();
    for (const e of bt.confirmed) {
      const btMin = etToMin(e.timeET);
      let bestLive: DecisionRow | null = null;
      let bestDiff = Infinity;
      for (const d of liveEntries) {
        if (usedLiveIds.has(d.id)) continue;
        if (d.direction !== e.direction) continue;
        const dMin = etToMin(utcToET(d.created_at));
        const diff = Math.abs(dMin - btMin);
        if (diff <= 3 && diff < bestDiff) { bestDiff = diff; bestLive = d; }
      }
      if (bestLive) {
        usedLiveIds.add(bestLive.id);
        const liveConf = parseFloat(bestLive.orchestration_confidence ?? '0');
        matched.push({
          live: { timeET: utcToET(bestLive.created_at), direction: bestLive.direction ?? '', confidence: liveConf },
          bt: { timeET: e.timeET, direction: e.direction, confidence: e.confidence, price: e.price, mode: e.mode },
          diffMin: bestDiff,
          confGap: e.confidence - liveConf,
        });
      } else {
        btOnly.push({ timeET: e.timeET, direction: e.direction, confidence: e.confidence, price: e.price, mode: e.mode, grade: e.grade });
      }
    }
    for (const d of liveEntries) {
      if (usedLiveIds.has(d.id)) continue;
      liveOnly.push({
        timeET: utcToET(d.created_at),
        direction: d.direction ?? '',
        confidence: parseFloat(d.orchestration_confidence ?? '0'),
      });
    }
    const totalEntryUniverse = matched.length + btOnly.length + liveOnly.length;
    const entryPass = totalEntryUniverse === 0 || (matched.length / totalEntryUniverse) >= 0.66;
    layers.entry = {
      pass: entryPass,
      summary: totalEntryUniverse === 0
        ? 'no confirmed entries on either side'
        : `matched=${matched.length}, bt-only=${btOnly.length}, live-only=${liveOnly.length}`,
      details: { matched, btOnly, liveOnly },
    };
  }

  await closePool();

  const overallPass =
    layers.data.pass && layers.indicators.pass && layers.direction.pass &&
    layers.confidence.pass && layers.decision.pass && layers.entry.pass;

  return {
    date: TARGET_DATE!, ticker: TICKER!, ranAt,
    liveSnapshots: snaps.length, liveDecisions: decisions.length,
    skippedBacktest: SKIP_BT, overallPass, layers,
  };
}

// ── Output ────────────────────────────────────────────────────────────────
function printText(r: Report): void {
  const bar = '═'.repeat(80);
  console.log(`\n${bar}`);
  console.log(`  PARITY REPORT: ${r.ticker} ${r.date}  (snapshots=${r.liveSnapshots}, decisions=${r.liveDecisions})`);
  console.log(`${bar}\n`);
  const order: Array<keyof Report['layers']> = ['data', 'indicators', 'direction', 'confidence', 'decision', 'entry'];
  for (const k of order) {
    const L = r.layers[k];
    const badge = L.pass ? '✓' : '✗';
    const name = k.toUpperCase().padEnd(11);
    console.log(`  [${badge}] ${name} — ${L.summary}`);
  }
  console.log(`\n  OVERALL: ${r.overallPass ? '✓ PARITY OK' : '✗ DIVERGENCE DETECTED'}\n${bar}\n`);
}

main()
  .then(report => {
    if (JSON_OUT) {
      // Marker convention matches backtest-day.ts so dashboards can extract.
      console.log(`__JSON_START__${JSON.stringify(report)}__JSON_END__`);
    } else {
      printText(report);
    }
  })
  .catch(err => {
    console.error('parity-report failed:', err);
    process.exit(1);
  });
