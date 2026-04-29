/**
 * backtest-day.ts — Replay a historical trading day through the signal + analysis pipeline.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-day.ts [YYYY-MM-DD] [TICKER]
 *   Defaults: 2026-03-18, SPY
 *
 * Fetches 1m bars from Alpaca (with 2-day warmup), aggregates to 3m/5m,
 * walks through market hours in 1-minute intervals, and runs the full
 * signal → analysis pipeline at each step. Reports all potential entries
 * and flags bad ones.
 */

import 'dotenv/config';
import { config } from '../config.js';
import { computePriorDayLevels, computeORB } from '../indicators/market-structure.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalPayload, AlignmentType, SignalDirection } from '../types/signal.js';
import type { OptionEvaluation } from '../types/options.js';
import type { ConfidenceBreakdown, AnalysisResult } from '../types/analysis.js';
import type { PositionContext, DecisionResult, DecisionType } from '../types/decision.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { v4 as uuidv4 } from 'uuid';
import { DecisionOrchestrator } from '../agents/decision-orchestrator.js';
import { AnalysisAgent } from '../agents/analysis-agent.js';
import { evaluateEntryGate, type GateInput } from '../lib/entry-gate.js';
import { type SimResult, estimateEntryPremium } from '../lib/order-agent-sim.js';
import { evaluateTrend, evaluateRange, evaluateBreakout, evaluateVwapReversion, resolveMode } from '../strategies/default.js';
import { computeTrendConfidenceFn, computeRangeConfidenceFn, computeBreakoutConfidenceFn } from '../agents/analysis-agent.js';
import { computeTimeframeIndicators, classifyAlignment } from '../agents/signal-agent.js';
import { computeEntryMetrics } from '../lib/entry-context.js';
import { getTickerConfig } from '../ticker-configs.js';
import { detectDirection } from '../lib/direction-detector.js';
import { writeVisualizerHTML, type VisEntry, type VisBar } from './backtest-visualizer.js';
import { computePriceTopology } from '../topology/price-topology.js';
import { computeTopologyEntry } from '../topology/entry-model.js';
import type { TopologySignal } from '../topology/types.js';
import {
  hashStashPathsInWorkingTree, dayCachePathFor,
  loadCachedJSON, saveCachedJSON,
} from './lib/backtest-cache.js';
import { existsSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const USE_AI = process.argv.includes('--ai');
const USE_TOPO = !process.argv.includes('--no-topo'); // enabled by default, matching live
const JSON_OUTPUT = process.argv.includes('--json');
const HTML_OUTPUT = process.argv.includes('--html');
const NO_CACHE = process.argv.includes('--no-cache');
const TARGET_DATE = process.argv.filter(a => !a.startsWith('--'))[2] || '2026-03-18';
const TICKER = process.argv.filter(a => !a.startsWith('--'))[3] || 'SPY';
const PROFILE = 'S' as const; // Scalp: 1m, 3m, 5m

// ── Per-day stdout cache ─────────────────────────────────────────────────────
// Cache key = SHA1 of STASH_PATHS content (matches validate-change). Skip when
// any flag/env that would alter output is set: --ai (non-deterministic),
// --html (creates a file as side-effect), --no-cache (explicit), no --json
// (signal-quality is the only consumer that needs replayable output), or any
// of BT_THRESHOLD / BT_DEBUG / BT_RECONNECT_TIMES (override behavior at run time).
const CACHE_ELIGIBLE = JSON_OUTPUT && !USE_AI && !HTML_OUTPUT && !NO_CACHE
  && !process.env.BT_THRESHOLD && !process.env.BT_DEBUG && !process.env.BT_RECONNECT_TIMES;

interface DayCacheEntry { ticker: string; date: string; hash: string; stdout: string }

let _cacheBuffer: string[] | null = null;
let _cachePath: string | null = null;

function _initCache(): void {
  if (!CACHE_ELIGIBLE) return;
  const hash = hashStashPathsInWorkingTree();
  _cachePath = dayCachePathFor(TICKER, TARGET_DATE, hash);
  if (existsSync(_cachePath)) {
    const cached = loadCachedJSON<DayCacheEntry>(_cachePath);
    if (cached && cached.ticker === TICKER && cached.date === TARGET_DATE && cached.hash === hash) {
      // Replay the cached stdout verbatim and exit. Use process.stdout.write to
      // bypass the tee'd console.log (which would re-buffer). Defer exit until
      // the pipe has drained — otherwise piped parents receive truncated output.
      process.stdout.write(cached.stdout, () => process.exit(0));
      return;
    }
  }
  // Cache miss: tee everything written to stdout so we can save at the end.
  // Intercept process.stdout.write (the primitive both console.log and direct
  // process.stdout.write calls funnel through) so we capture all stdout bytes
  // regardless of which API the caller used.
  _cacheBuffer = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (_cacheBuffer) {
      _cacheBuffer.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origWrite(chunk as any, ...(rest as any));
  }) as typeof process.stdout.write;
}

function _saveCache(): void {
  if (!CACHE_ELIGIBLE || !_cacheBuffer || !_cachePath) return;
  const hash = hashStashPathsInWorkingTree();
  // Recompute hash at save time — if the working tree changed during the run,
  // the cached stdout no longer matches the code that produced it. Skip save.
  const expectedPath = dayCachePathFor(TICKER, TARGET_DATE, hash);
  if (expectedPath !== _cachePath) return;
  saveCachedJSON(_cachePath, {
    ticker: TICKER, date: TARGET_DATE, hash, stdout: _cacheBuffer.join(''),
  });
}

_initCache();

// ── Per-ticker config ────────────────────────────────────────────────────────
// Backtest config: sim parameters, entry window, daily limits, etc.
import { loadBacktestConfig } from './backtest-configs/index.js';
const TCFG = loadBacktestConfig(TICKER);
const MIN_CONFIDENCE = parseFloat(process.env.BT_THRESHOLD ?? '') || TCFG.minConfidence;
// Live ticker config: provides the REAL strategy hooks (shouldAllowEntry, adjustConfidence, detectMode)
const LIVE_TICKER_CFG = getTickerConfig(TICKER);

// Market hours in UTC (ET + 4 during EDT, ET + 5 during EST)
// March 18 2026 is EDT → 9:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC
const MARKET_OPEN_UTC = '13:30';
const MARKET_CLOSE_UTC = '20:00';

// ── Alpaca REST helpers ───────────────────────────────────────────────────────

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

async function fetchBarsRange(
  ticker: string,
  timeframe: Timeframe,
  start: string,
  end: string,
  limit = 10000,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };

  const allBars: OHLCVBar[] = [];
  let pageToken: string | undefined;

  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', ALPACA_TF[timeframe]);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', String(Math.min(limit, 10000)));
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as AlpacaBarsResponse;
    allBars.push(...normalizeAlpacaBars(data));

    if (data.next_page_token) {
      pageToken = data.next_page_token;
    } else {
      break;
    }
  }

  return allBars;
}

// ── Bar aggregation (from 1m → Nm, same logic as AlpacaStreamManager) ────────

function aggregate1mBars(oneMins: OHLCVBar[], timeframe: Timeframe, upToTs: number): OHLCVBar[] {
  const n = { '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }[timeframe] ?? 1;
  if (n <= 1) return oneMins.filter(b => new Date(b.timestamp).getTime() <= upToTs);

  const bucketMs = n * 60_000;
  // Current bucket at upToTs is still forming — exclude it
  const currentBucket = Math.floor(upToTs / bucketMs) * bucketMs;

  const groups = new Map<number, OHLCVBar[]>();
  for (const bar of oneMins) {
    const ts = new Date(bar.timestamp).getTime();
    if (ts > upToTs) continue; // future bar
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue; // in-progress bucket
    let g = groups.get(bucket);
    if (!g) { g = []; groups.set(bucket, g); }
    g.push(bar);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, bars]) => ({
      timestamp: new Date(bucket).toISOString(),
      open: bars[0]!.open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1]!.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
      vwap: (() => {
        if (!bars.some(b => b.vwap !== undefined)) return undefined;
        const totalVol = bars.reduce((s, b) => s + b.volume, 0);
        if (totalVol === 0) return undefined;
        return bars.reduce((s, b) => s + (b.vwap ?? 0) * b.volume, 0) / totalVol;
      })(),
    }));
}

// ── Indicator computation — imported from signal-agent.ts ────────────────────
// computeTimeframeIndicators() and classifyAlignment() are shared with signal-agent.

// ── Theta decay simulation ───────────────────────────────────────────────────
// Simulates the theta decay penalty that the live system applies based on option
// expiration proximity. In live trading, 0DTE options are the default choice,
// so the backtest assumes 0DTE expiration on the target date.

function simulateThetaDecay(signalTime: string, targetDate: string): number {
  const now = new Date(signalTime);
  const marketCloseUtc = new Date(`${targetDate}T20:00:00Z`);
  const minutesToClose = (marketCloseUtc.getTime() - now.getTime()) / 60000;

  // 0DTE: same logic as analysis-agent.ts
  if (minutesToClose <= 30) return -0.10;
  if (minutesToClose <= 60) return -0.06;
  if (minutesToClose <= 90) return -0.03;

  return 0;
}

// ── Mock option evaluation (no historical option data available) ──────────────

function mockOptionEval(signal: SignalPayload): OptionEvaluation {
  return {
    signalId: signal.id,
    ticker: signal.ticker,
    evaluatedAt: signal.createdAt,
    desiredSide: signal.direction === 'bearish' ? 'put' : 'call',
    callCandidate: null,
    putCandidate: null,
    winner: signal.direction === 'bearish' ? 'put' : 'call',
    winnerCandidate: null, // No historical option data
    selectionReason: 'Backtest mock — no historical option data',
    liquidityOk: true,
    candidatePass: true,
  };
}

// ── Filter-blocked entry tracking (counterfactual analysis) ───────────────────

interface FilterBlockedEntry {
  time: string;
  timeET: string;
  direction: SignalDirection;
  signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none';
  confidence: number;
  price: number;
  filterRule: string;          // e.g. "trend regime 86 >= 80", "breakout confidence 68% < 74%"
  filterCategory: string;      // normalized prefix for grouping: "trend_regime", "breakout_confidence", etc.
  // Forward move metrics (same as EntryRecord)
  mfePct: number;
  maePct: number;
  mfeOverMae: number;
  mfePeakMinutes: number;
  entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  // Context
  regimeScore?: number;
  rangeExhaustion?: number;
  displacementVelocity?: number;
  choppiness?: number;
}

/** Normalize a filter reason string into a grouping category */
function filterCategory(reason: string): string {
  // shouldAllowEntry reasons: "trend regime 86 >= 80", "breakout confidence 68% < 74%", etc.
  // Inline backtest reasons: "trend_exhausted_reverting", "trend_max_exhaustion", "entry_window", etc.
  if (reason.startsWith('trend regime')) return 'trend_regime';
  if (reason.startsWith('trend atr')) return 'trend_atr';
  if (reason.startsWith('trend exhausted+choppy')) return 'trend_exhausted_choppy';
  if (reason.startsWith('breakout confidence')) return 'breakout_confidence';
  if (reason.startsWith('breakout atrPct')) return 'breakout_atrPct';
  if (reason.startsWith('breakout dvel')) return 'breakout_dvel';
  if (reason.startsWith('breakout rangeExhaustion')) return 'breakout_rangeExhaustion';
  if (reason.startsWith('breakout chop+lowDvel')) return 'breakout_chop_lowDvel';
  if (reason.startsWith('breakout highExh+highChop')) return 'breakout_highExh_highChop';
  if (reason.startsWith('breakout extremeChop')) return 'breakout_extremeChop';
  if (reason.startsWith('breakout extremeExhaustion')) return 'breakout_extremeExhaustion';
  if (reason.startsWith('breakout regime')) return 'breakout_regime';
  if (reason.startsWith('breakout atr')) return 'breakout_atr';
  if (reason.startsWith('bullish rangeExhaustion')) return 'bullish_rangeExhaustion';
  if (reason.startsWith('bullish dvel')) return 'bullish_dvel';
  if (reason.startsWith('bullish breakout')) return 'bullish_breakout_highExh_regime';
  // Inline backtest filters
  if (reason.startsWith('trend_exhausted_reverting')) return 'trend_exhausted_reverting';
  if (reason.startsWith('trend_max_exhaustion')) return 'trend_max_exhaustion';
  if (reason.startsWith('entry_window') || reason.startsWith('entry window blocked')) return 'entry_window';
  if (reason.startsWith('topology_trajectory')) return 'topology_trajectory';
  if (reason.startsWith('topology: REGIME fragmented') || reason.startsWith('topology: fragmented')) return 'topology_fragmented';
  if (reason.startsWith('topology:')) return 'topology_dimension';
  if (reason.startsWith('confidence ') && reason.includes('< ') && reason.endsWith('threshold')) return 'confidence_below_threshold';
  if (reason.startsWith('organic confidence')) return 'organic_floor';
  return reason.replace(/[^a-zA-Z_]/g, '').slice(0, 40);
}

// ── Price tracking for entry quality analysis ─────────────────────────────────

interface EntryRecord {
  time: string;
  timeET: string;
  direction: SignalDirection;
  alignment: AlignmentType;
  confidence: number;
  price: number;
  strengthScore: number;
  signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none';
  // Price moves after entry (from remaining bars)
  maxFavorable: number;   // max price move in signal direction ($)
  maxAdverse: number;     // max price move against signal direction ($)
  // Entry quality metrics (stock-price-based — accurate, no sim dependency)
  mfePct: number;         // max favorable excursion as % of entry price
  maePct: number;         // max adverse excursion as % of entry price
  mfeOverMae: number;     // MFE/MAE ratio (higher = better entry)
  directionCorrect: boolean;  // price moved favorably > 0.15% within 30min
  move5mPct: number | null;   // directional move at 5m as % of price
  move10mPct: number | null;  // directional move at 10m as % of price
  move15mPct: number | null;  // directional move at 15m as % of price
  move30mPct: number | null;  // directional move at 30m as % of price
  entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';  // stock-price-based grade
  priceAt5m: number | null;
  priceAt10m: number | null;
  priceAt15m: number | null;
  priceAt30m: number | null;
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
  atr: number;
  mfePeakMinutes: number;  // minutes after entry when MFE peaks
  // Sequence-aware grading (MFE-before-MAE)
  seqMfePct: number;       // MFE reached before stop threshold hit (%)
  seqMaePct: number;       // MAE at point of stop or end of window (%)
  stoppedOut: boolean;     // whether adverse hit stop threshold before MFE peaked
  stopThresholdPct: number; // ATR-based stop threshold used (%)
  // Simulated order-agent result (secondary — not fully accurate for options)
  sim: SimResult;
  breakdown: ConfidenceBreakdown;
  // Confirmation gate simulation
  gateResult: 'PASSED' | 'STAGE1_OBSERVE' | 'WEAKENING_BLOCK' | 'STALE_BLOCK' | 'HIGH_CONV_OVERRIDE' | 'PHASE_CHANGE_OVERRIDE';
  stage1Conf?: number;  // confidence at stage-1 (if applicable)
  // Regime context at entry time
  regimeScore?: number;
  rangeExhaustion?: number;
  displacementVelocity?: number;
  choppiness?: number;
  intradayTrendStrength?: number;
  // AI orchestrator fields (populated when --ai flag is used)
  aiDecision?: DecisionType;
  aiShouldExecute?: boolean;
  aiReasoning?: string;
  aiConfirmationCount?: number;
}

function utcToET(utcTime: string): string {
  // March 2026 is EDT (UTC-4)
  const d = new Date(utcTime);
  d.setHours(d.getHours() - 4);
  return d.toISOString().slice(11, 16);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  BACKTEST: ${TICKER} on ${TARGET_DATE} (Profile: ${PROFILE}, Threshold: ${MIN_CONFIDENCE}${USE_AI ? ', AI ORCHESTRATOR' : ', deterministic'}${USE_TOPO ? ', TOPOLOGY GATE' : ''})`);
  console.log(`  Walking market hours ${MARKET_OPEN_UTC}–${MARKET_CLOSE_UTC} UTC in 1-min intervals`);
  console.log(`  📊 Order flow: replayed from live DB snapshots when available`);
  console.log(`${'='.repeat(80)}\n`);

  // ── Step 1: Fetch historical bars ──────────────────────────────────────────
  // 2 days warmup for indicator computation
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 4); // go back 4 calendar days for 2 trading days
  const startStr = warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z';
  const endStr = TARGET_DATE + 'T23:59:59Z';

  console.log(`Fetching 1m bars: ${startStr} → ${endStr}`);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m', startStr, endStr);
  // Filter to regular-session bars only (9:30–16:00 ET), matching the live
  // stream's _isRegularSession filter. Pre/post-market bars would pollute
  // DMI/OBV/etc. and cause indicator divergence from live.
  const allOneMin = allOneMinRaw.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
  console.log(`  → ${allOneMinRaw.length} 1-min bars fetched (${allOneMin.length} regular-session)`);

  console.log(`Fetching daily bars for prior day levels...`);
  const dailyBars = await fetchBarsRange(TICKER, '1d', warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z', endStr);
  console.log(`  → ${dailyBars.length} daily bars fetched`);

  // Filter to only bars on or before target date
  const targetDateBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  console.log(`  → ${targetDateBars.length} bars on ${TARGET_DATE}`);

  if (targetDateBars.length === 0) {
    console.error(`No bars found for ${TARGET_DATE}. Was it a trading day?`);
    process.exit(1);
  }

  // Show price range for the day
  const dayHigh = Math.max(...targetDateBars.map(b => b.high));
  const dayLow = Math.min(...targetDateBars.map(b => b.low));
  const dayOpen = targetDateBars[0]!.open;
  const dayClose = targetDateBars[targetDateBars.length - 1]!.close;
  console.log(`\n  Day range: $${dayLow.toFixed(2)} – $${dayHigh.toFixed(2)} (Open: $${dayOpen.toFixed(2)}, Close: $${dayClose.toFixed(2)})`);
  console.log(`  Day change: ${((dayClose - dayOpen) / dayOpen * 100).toFixed(2)}%\n`);

  // ── Recent daily volatility (for range mode gating) ─────────────────────
  // Compute average daily range (high-low as % of close) over the last 3 daily bars.
  // High recent volatility = range levels unreliable → gate range entries.
  const recentDailyBars = dailyBars.slice(-3);
  const avgDailyRangePct = recentDailyBars.length >= 2
    ? recentDailyBars.reduce((s, b) => s + (b.high - b.low) / b.close * 100, 0) / recentDailyBars.length
    : 0;
  console.log(`  Recent daily volatility: ${avgDailyRangePct.toFixed(2)}% avg range (${recentDailyBars.length} days)\n`);

  // ── Load historical order flow from live signal snapshots (if available) ──
  // Replays the exact order flow data the live system used, keyed by minute.
  // Falls back to no-flow when snapshots aren't available for this date.
  const orderFlowByMinute = new Map<string, import('../types/indicators.js').OrderFlowResult>();
  try {
    const { getPool } = await import('../db/client.js');
    const pool = getPool();
    const { rows } = await pool.query<{ created_at: string; order_flow: unknown }>(
      `SELECT created_at, signal_payload->'orderFlow' as order_flow
       FROM trading.signal_snapshots
       WHERE trade_date = $1 AND ticker = $2 AND signal_payload->'orderFlow' IS NOT NULL
       ORDER BY created_at`,
      [TARGET_DATE, TICKER]
    );
    for (const row of rows) {
      if (!row.order_flow) continue;
      // Key by HH:MM UTC for minute-level lookup
      const minuteKey = new Date(row.created_at).toISOString().slice(11, 16);
      orderFlowByMinute.set(minuteKey, row.order_flow as import('../types/indicators.js').OrderFlowResult);
    }
    if (orderFlowByMinute.size > 0) {
      console.log(`  📊 Loaded ${orderFlowByMinute.size} order flow snapshots from live DB`);
    } else {
      console.log(`  ⚠ No order flow snapshots found for ${TARGET_DATE} — orderFlowBonus will be 0`);
    }
    await (await import('../db/client.js')).closePool();
  } catch {
    console.log(`  ⚠ Could not load order flow from DB — orderFlowBonus will be 0`);
  }

  // ── Step 2: Walk through market hours in 1-min intervals ──────────────────
  const entries: EntryRecord[] = [];
  const filterBlockedEntries: FilterBlockedEntry[] = [];
  const allTicks: { time: string; timeET: string; price: number; direction: SignalDirection; alignment: AlignmentType; confidence: number; meetsThreshold: boolean; signalMode: string }[] = [];

  // ── Leading override momentum persistence (shared with signal-agent) ──────
  const btPersistence = { dir: null as 'bullish' | 'bearish' | null, ts: 0 };

  // ── Trend persistence state ───────────────────────────────────────────────
  // Tracks recent signal direction+alignment for trend persistence bonus (mirrors live DB query)
  const signalHistory: Array<{ direction: SignalDirection; alignment: AlignmentType }> = [];

  // ── Confirmation gate state ────────────────────────────────────────────────
  // Simulates the 2-stage confirmation gate from decision-orchestrator.ts
  let confirmStage1: { direction: SignalDirection; confidence: number; time: string } | null = null;
  let lastEntryTs = 0; // track when last confirmed entry happened (for dedup)

  // ── Range mode state ──────────────────────────────────────────────────────
  let lastRangeEntryTs = 0;
  let rangeEntryCount = 0;
  const RANGE_COOLDOWN_MIN = 20;   // min minutes between range entries
  const MAX_RANGE_ENTRIES = 1;      // max 1 range entry per day — 2nd range entries were 3W/7L across Feb+Mar
  let dailyEntryCount = 0;  // total for reporting only
  let dailyPremiumDeployed = 0; // running total of entry_price * qty * 100 for risk budget gate
  const DAILY_RISK_BUDGET_PCT = TCFG.dailyRiskBudgetPct; // e.g. 0.05 = 5% of equity

  // ── Rolling state ─────────────────────────────────────────────────────────
  const rollingDecisionTs: number[] = [];   // every tick = one decision (WAIT or ENTRY)
  const rollingEntryTs: number[] = [];      // only confirmed entries
  const RANGE_WAIT_MIN = 45;       // don't range trade in first 45 min (let day establish)

  // ── VWAP reversion mode state ────────────────────────────────────────────
  let lastVwapRevEntryTs = 0;
  let vwapRevEntryCount = 0;

  // ── Breakout mode state ────────────────────────────────────────────────────
  let lastBreakoutEntryTs = 0;
  let breakoutEntryCount = 0;
  const BREAKOUT_COOLDOWN_MIN = 30;
  const MAX_BREAKOUT_ENTRIES = 1;   // was 2 — most 2nd breakout entries fail
  const BREAKOUT_WAIT_MIN = 45;

  // ── Trend mode state ────────────────────────────────────────────────────
  let lastTrendEntryTs = 0;
  let trendEntryCount = 0;
  const TREND_COOLDOWN_MIN = TCFG.trendCooldownMin;  // per-ticker (0 = no cooldown, matches live)
  // No hard trend cap — risk budget is the sole limiter for trend entries.

  // ── Regime score (display only — live strategy computes its own via detectMode) ──
  let regimeScore = 50;

  // ── Intraday trend tracking ────────────────────────────────────────────────
  let consecHigherCloses = 0;
  let consecLowerCloses = 0;
  let prevTickClose = 0;
  let intradayTrendStrength = 0;

  // ── Intraday loss tracker ────────────────────────────────────────────────
  // Tracks confirmed entries that go against within 5 min. After N quick losses,
  // dramatically raises the threshold — mimics a real trader stopping after losses.
  let intradayLosses = 0;
  const LOSS_THRESHOLD_BUMP = 0.06; // moderate bump after 2 losses
  const MAX_LOSSES_BEFORE_BUMP = 2; // need 2 losses before tightening

  // ── AI orchestrator state (when --ai flag is used) ────────────────────────
  const orchestrator = USE_AI ? new DecisionOrchestrator() : null;
  // Single AnalysisAgent instance — stateless, reused across all ticks.
  // Backtest invokes its run() with runtimeOpts to inject simulated time,
  // pre-tracked signal history, and to skip the Anthropic API call.
  const analysisAgent = new AnalysisAgent();
  // Track recent decisions for PositionContext.recentDecisions (newest first)
  const backtestRecentDecisions: PositionContext['recentDecisions'] = [];

  // Generate 1-min timestamps from market open to close
  const openTime = new Date(`${TARGET_DATE}T${MARKET_OPEN_UTC}:00Z`);
  const closeTime = new Date(`${TARGET_DATE}T${MARKET_CLOSE_UTC}:00Z`);
  const rangeEarliestTs = openTime.getTime() + RANGE_WAIT_MIN * 60_000;
  const breakoutEarliestTs = openTime.getTime() + BREAKOUT_WAIT_MIN * 60_000;

  // ── Simulate the live stream's ring buffer ───────────────────────────────
  // Live (post-b6f7945): alpaca-stream.ts seedHistoricalBars() now paginates
  // via page_token at limit=10000 until exhausted, fetching ALL 1m bars from
  // (Date.now() - 4 calendar days). These are filtered to regular session and
  // trimmed to BAR_CACHE_SIZE=800. The pre-fix behavior used limit=1000 which
  // silently truncated mid-window after extended-hours bars filled the page.
  //
  // Known limitation: the live stream may reconnect mid-session, purging and
  // re-seeding the cache from (reconnect_time - 4 days).  This shifts the bar
  // window and causes indicator recomputation with a different trajectory.
  // The backtest simulates the initial seed only; reconnection-induced
  // divergence cannot be reproduced.
  const BAR_CACHE_SIZE = 800;     // matches alpaca-stream.ts BAR_CACHE_SIZE
  const openTs = openTime.getTime();
  const warmupTs = new Date(TARGET_DATE);
  warmupTs.setDate(warmupTs.getDate() - 4);
  const warmupStartTs = warmupTs.getTime();
  const priorRawBars = allOneMinRaw.filter(b => {
    const ts = new Date(b.timestamp).getTime();
    return ts >= warmupStartTs && ts < openTs;
  });
  // Filter to regular session (same as _seedCache → _isRegularSession). No
  // chronological truncation — paginated fetch returns all bars in window.
  const seedFiltered = priorRawBars.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
  // Trim to BAR_CACHE_SIZE (newest kept)
  const streamCache: OHLCVBar[] = seedFiltered.slice(-BAR_CACHE_SIZE);
  console.log(`  Stream cache seed: ${priorRawBars.length} raw → ${seedFiltered.length} regular-session → ${streamCache.length} (cap ${BAR_CACHE_SIZE})`);

  // ── Reconnection simulation ─────────────────────────────────────────────
  // The live data stream may reconnect mid-session, purging and re-seeding
  // the bar cache.  A reconnection at time T re-seeds from (T - 4 days)
  // with limit=1000, shifting the bar window and causing indicator
  // recomputation with a different ADX trajectory.
  //
  // Detect reconnections from an environment variable:
  //   BT_RECONNECT_TIMES="11:20,14:05"  (ET times, comma-separated)
  // Each time triggers a cache purge + re-seed matching the live system's
  // seedHistoricalBars() behavior at that moment.
  const reconnectTimesET = (process.env.BT_RECONNECT_TIMES ?? '').split(',').filter(Boolean);
  const reconnectTimesMs = new Set(reconnectTimesET.map(et => {
    const [h, m] = et.trim().split(':').map(Number);
    // Convert ET to UTC: add 4 hours for EDT
    const utcDate = new Date(`${TARGET_DATE}T${String(h! + 4).padStart(2, '0')}:${String(m!).padStart(2, '0')}:00Z`);
    return utcDate.getTime();
  }));

  function reseedCache(atTs: number): void {
    // Purge cache (matches live alpaca-stream purgeCache)
    streamCache.length = 0;
    // Re-seed: paginated fetch from (atTs - 4 days), filter to regular session
    // (matches post-b6f7945 alpaca-stream behavior — no limit truncation).
    const reseedStart = atTs - 4 * 24 * 60 * 60 * 1000;
    const reseedRaw = allOneMinRaw.filter(b => {
      const ts = new Date(b.timestamp).getTime();
      return ts >= reseedStart && ts < atTs;
    });
    const reseedFiltered = reseedRaw.filter(b => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(b.timestamp));
      const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
      const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
      const mins = hour * 60 + minute;
      return mins >= 9 * 60 + 30 && mins < 16 * 60;
    });
    streamCache.push(...reseedFiltered.slice(-BAR_CACHE_SIZE));
    // Live purges today's pre-reconnection bars — they are NOT re-added.
    // Only the REST historical seed survives; new bars arrive after reconnection.
    if (streamCache.length > BAR_CACHE_SIZE) streamCache.splice(0, streamCache.length - BAR_CACHE_SIZE);
    console.log(`  ⚡ Reconnection at ${utcToET(new Date(atTs).toISOString())} ET: cache re-seeded → ${streamCache.length} bars`);
  }

  // Index for efficiently adding today's bars during the walk
  const todayBars = allOneMin.filter(b => b.timestamp.startsWith(TARGET_DATE));
  let todayBarIdx = 0;

  let tickCount = 0;
  for (let t = new Date(openTime); t <= closeTime; t.setMinutes(t.getMinutes() + 1)) {
    const currentTs = t.getTime();
    const timeStr = t.toISOString();
    const timeET = utcToET(timeStr);

    // Check for stream reconnection at this tick
    if (reconnectTimesMs.has(currentTs)) {
      reseedCache(currentTs);
      // Reset todayBarIdx to skip bars already in cache
      todayBarIdx = todayBars.findIndex(b => new Date(b.timestamp).getTime() >= currentTs);
      if (todayBarIdx < 0) todayBarIdx = todayBars.length;
    }

    // Add completed bars to the stream cache (bar at T is complete at T+60s)
    while (todayBarIdx < todayBars.length) {
      const barTs = new Date(todayBars[todayBarIdx]!.timestamp).getTime();
      if (barTs < currentTs) {
        streamCache.push(todayBars[todayBarIdx]!);
        if (streamCache.length > BAR_CACHE_SIZE) streamCache.splice(0, streamCache.length - BAR_CACHE_SIZE);
        todayBarIdx++;
      } else {
        break;
      }
    }

    if (streamCache.length < 20) continue; // need minimum bars for indicators

    // Derive timeframe bars from the stream cache (matching live behavior)
    const ltfBars = streamCache.slice(-500); // 1m bars, last 500 (matches BARS_LIMIT in signal-agent)
    const mtfBars = aggregate1mBars(streamCache, '3m', currentTs).slice(-500);
    const htfBars = aggregate1mBars(streamCache, '5m', currentTs).slice(-500);

    if (ltfBars.length < 14 || mtfBars.length < 14 || htfBars.length < 14) continue;

    // ── Direction detection (shared with signal-agent.ts) ───────────────────
    const { direction: detectedDir, reversalOverride, leadingSignalOverride } =
      detectDirection(ltfBars, mtfBars, htfBars, true, btPersistence, currentTs);
    let direction = detectedDir;

    // Second pass: full indicators
    const tfIndicators: TimeframeIndicators[] = [
      computeTimeframeIndicators(ltfBars, '1m', direction, true),   // LTF: shorter DMI period (8)
      computeTimeframeIndicators(mtfBars, '3m', direction, false),
      computeTimeframeIndicators(htfBars, '5m', direction, false),
    ];
    const alignment = classifyAlignment(tfIndicators, direction);
    const currentPrice = ltfBars[ltfBars.length - 1]!.close;
    const atr = tfIndicators[2]?.atr.atr ?? tfIndicators[0]?.atr.atr ?? 0;
    const atm = Math.round(currentPrice);
    const htfAdx = tfIndicators[2]?.dmi.adx ?? tfIndicators[1]?.dmi.adx ?? 0;
    const strengthScore = Math.min(100, Math.round(htfAdx * 2));
    const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
    const orb = computeORB(ltfBars, currentPrice);

    const signal: SignalPayload = {
      id: uuidv4(), ticker: TICKER, profile: PROFILE,
      timeframes: tfIndicators, ltf: '1m', mtf: '3m', htf: '5m',
      direction, alignment, currentPrice, atr, atm, strengthScore,
      priorDayLevels, orb,
      reversalOverride: reversalOverride || undefined,
      leadingSignalOverride: leadingSignalOverride || undefined,
      triggeredBy: 'AUTO', createdAt: timeStr,
      orderFlow: orderFlowByMinute.get(timeStr.slice(11, 16)) ?? undefined,
    };

    // ── Mode detection (parallel range + breakout) ────────────────────────────
    // Range and breakout are evaluated independently, then resolved by score.
    // This prevents widening one mode's thresholds from stealing ticks from the other.
    let signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none' = 'none';
    let rangeSupport = 0, rangeResistance = 0, rangeMidpoint = 0;
    let breakoutLevel = 0, breakoutBeyond = 0;
    const htfTfForRange = tfIndicators[2]!;

    {
      const trendCandidate = evaluateTrend(htfTfForRange);
      const rangeCandidate = evaluateRange(htfTfForRange, currentPrice);
      const breakoutCandidate = evaluateBreakout(htfTfForRange, tfIndicators, currentPrice);
      const ltfTfForVwap = tfIndicators[0]!;
      const vwapRevCandidate = evaluateVwapReversion(ltfTfForVwap, htfTfForRange, currentPrice);
      const modeResult = resolveMode(trendCandidate, rangeCandidate, breakoutCandidate, vwapRevCandidate);

      signalMode = modeResult.signalMode;
      // Only apply mode evaluator's direction when an override hasn't already set a faster direction.
      // Both leading indicators and reversal override detect direction changes before HTF DI catches up.
      if (modeResult.direction && !leadingSignalOverride && !reversalOverride) {
        direction = modeResult.direction;
        signal.direction = direction;
      }

      if (signalMode === 'range' && modeResult.rangeSupport !== undefined) {
        rangeSupport = modeResult.rangeSupport;
        rangeResistance = modeResult.rangeResistance!;
        // Enrich with prior day levels if nearby
        const { pdh, pdl } = priorDayLevels;
        if (pdl > 0 && Math.abs(pdl - rangeSupport) / currentPrice < 0.003) rangeSupport = Math.min(rangeSupport, pdl);
        if (pdh > 0 && Math.abs(pdh - rangeResistance) / currentPrice < 0.003) rangeResistance = Math.max(rangeResistance, pdh);
        rangeMidpoint = (rangeSupport + rangeResistance) / 2;
        signal.rangeSupport = rangeSupport;
        signal.rangeResistance = rangeResistance;
      }

      if (signalMode === 'breakout' && modeResult.breakoutLevel !== undefined) {
        breakoutLevel = modeResult.breakoutLevel;
        breakoutBeyond = modeResult.breakoutBeyond!;
        signal.signalMode = 'breakout';
        signal.breakoutLevel = breakoutLevel;
        signal.breakoutBeyond = breakoutBeyond;
      }

      if (signalMode === 'vwap_reversion') {
        signal.signalMode = 'vwap_reversion';
        signal.vwapReversionTarget = modeResult.vwapReversionTarget;
        signal.vwapDistance = modeResult.vwapDistance;
      }
    }

    // Leading signal mode rescue: force trend when mode=none but leading indicators confirm
    if (signalMode === 'none' && leadingSignalOverride && direction !== 'neutral') {
      signalMode = 'trend';
    }

    // No qualifying regime — skip this bar (no default fallback)
    if (signalMode === 'none') continue;

    // Set signalMode on the payload for downstream consumers (AnalysisAgent
    // routes confidence-fn selection on signal.signalMode). The conditional
    // assignments above only set it for 'breakout' / 'vwap_reversion'.
    signal.signalMode = signalMode;

    // ── Entry metrics — uses shared computeEntryMetrics() (same code as live) ──
    // Get today's bars up to the current tick for metrics computation.
    const todayBarsToNow = targetDateBars.filter(b => {
      const bt = new Date(b.timestamp).getTime();
      return bt <= currentTs;
    });
    const htfAtr = (tfIndicators[2] ?? tfIndicators[0])?.atr.atr ?? atr;
    const entryMetrics = computeEntryMetrics(todayBarsToNow, htfAtr);
    const displacementVelocity = entryMetrics?.displacementVelocity ?? 0;
    const rangeExhaustion = entryMetrics?.rangeExhaustion ?? 0;
    const choppiness = entryMetrics?.choppiness ?? 0;
    const trendConsolidationBreakout = entryMetrics?.trendConsolidationBreakout ?? false;
    const atrRatio = entryMetrics?.atrRatio;
    const minutesSinceOpen = (currentTs - openTime.getTime()) / 60_000;

    // Intraday trend tracking: consecutive directional closes
    if (prevTickClose > 0) {
      if (currentPrice > prevTickClose) {
        consecHigherCloses = Math.max(1, consecHigherCloses + 1);
        consecLowerCloses = 0;
      } else if (currentPrice < prevTickClose) {
        consecLowerCloses = Math.max(1, consecLowerCloses + 1);
        consecHigherCloses = 0;
      }
    }
    prevTickClose = currentPrice;
    intradayTrendStrength = consecHigherCloses >= 3 ? consecHigherCloses
      : consecLowerCloses >= 3 ? -consecLowerCloses : 0;

    // ── Regime score — call live per-ticker strategy's detectMode ──
    // This triggers computeRegimeScore() as a side effect in IWM/SPY/QQQ strategies,
    // which sets the module-level _lastRegimeScore used by shouldAllowEntry.
    // We call it here to keep regime in sync — same as the live signal-agent pipeline.
    LIVE_TICKER_CFG.strategy.detectMode(tfIndicators, direction, currentPrice);
    // Compute a display-only regime score for reporting (uses the same method as live strategies)
    {
      const ltfBars = tfIndicators[0]?.bars;
      const ltfVwapPriceVs = tfIndicators[0]?.vwap?.priceVsVwap ?? 0;
      const ltfAdx = tfIndicators[0]?.dmi?.adx ?? 0;
      if (ltfBars && ltfBars.length >= 20) {
        // Use the live strategy's regime computation via detectMode side effect.
        // For display, compute a simple composite from the shared metrics.
        const trendStrComponent = Math.min(10, Math.abs(intradayTrendStrength) * 2.5);
        const choppinessComponent = (1 - choppiness) * 15;
        const velocityComponent = Math.min(10, Math.max(-10, displacementVelocity * 15));
        const adxComponent = ltfAdx >= 20 ? Math.min(15, (ltfAdx - 20) * 1.0) : 0;
        const vwapComponent = Math.min(10, Math.abs(ltfVwapPriceVs) / 0.20 * 10);
        regimeScore = Math.round(Math.max(0, Math.min(100,
          50 + choppinessComponent + velocityComponent + trendStrComponent + adxComponent + vwapComponent
        )));
      }
    }

    const optionEval = mockOptionEval(signal);
    // Backtest theta-decay simulation. Live derives theta from
    // option.winnerCandidate; the mock has none, so we inject the precomputed
    // value into AnalysisAgent.run() via runtimeOpts.thetaOverride.
    const thetaOverride = (signalMode === 'trend') ? simulateThetaDecay(signal.createdAt, TARGET_DATE) : 0;

    // Single source of truth: live AnalysisAgent.run() handles cb compute,
    // theta injection, adjustConfidence, persistence bonus, organic floor,
    // entry-window check, shouldAllowEntry filter, and topology gate.
    // Backtest only injects: simulated `now` (last bar timestamp), pre-tracked
    // signal history, theta value, skip-AI flag, and skip-topology flag.
    const tickNow = new Date(currentTs);
    const recentSignalsHistory = signalHistory.slice().reverse().slice(0, 10);
    const analysis = await analysisAgent.run(signal, optionEval, true, LIVE_TICKER_CFG, {
      now: tickNow,
      recentSignals: recentSignalsHistory,
      skipAIExplanation: true,
      thetaOverride,
      skipTopology: !USE_TOPO,
    });
    let cb = analysis.confidenceBreakdown;
    let meetsThreshold = analysis.meetsEntryThreshold;
    const entryBlockReason = analysis.entryBlockReason;

    // Record this tick for next-tick persistence-bonus lookup.
    signalHistory.push({ direction, alignment });

    // Backtest-only intraday-loss-bump (live doesn't have this). When losses
    // accumulate, raise the threshold further on top of live's check.
    const hasActiveLeadingSignals = (cb.candlePatternBonus > 0 || cb.priceVelocityBonus > 0 || cb.volumeSurgeBonus > 0);
    const leadingOverrideActive = signal.leadingSignalOverride && hasActiveLeadingSignals;
    const effectiveThreshold = (leadingOverrideActive ? Math.max(MIN_CONFIDENCE - 0.05, 0.55) : MIN_CONFIDENCE)
      + (intradayLosses >= MAX_LOSSES_BEFORE_BUMP ? LOSS_THRESHOLD_BUMP : 0);
    if (meetsThreshold && cb.total < effectiveThreshold) {
      meetsThreshold = false;
    }

    tickCount++;
    rollingDecisionTs.push(currentTs);  // every processed tick = one decision (matches live pipeline)
    allTicks.push({ time: timeStr, timeET, price: currentPrice, direction, alignment, confidence: cb.total, meetsThreshold, signalMode });

    // Debug: dump confidence breakdown for ticks with conf >= 0.50 in afternoon
    if (process.env.BT_DEBUG && cb.total >= parseFloat(process.env.BT_DEBUG_MIN ?? '0.45')) {
      const factors = Object.entries(cb).filter(([k, v]) => k !== 'total' && k !== 'base' && typeof v === 'number' && Math.abs(v as number) >= 0.01).map(([k, v]) => `${k}=${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(3)}`).join(', ');
      const hardGates: string[] = [];
      const htfTf = tfIndicators[2]!;
      if (cb.structureBonus <= 0) hardGates.push(`struct≤0→cap0.68`);
      if (htfTf.dmi.adx < 15) hardGates.push(`adx<15→cap0.55`);
      else if (htfTf.dmi.adx < 20) hardGates.push(`adx<20→cap0.64`);
      if (cb.trContractionPenalty < 0 && cb.recentPriceActionBonus <= 0) hardGates.push(`TR+noPA→cap0.60`);
      if (cb.adxMaturityPenalty <= -0.15) hardGates.push(`adxMat≥0.15→cap`);
      if (cb.recentPriceActionBonus < 0) hardGates.push(`negPA→cap0.64`);
      if (cb.moveExhaustionPenalty <= -0.06 && cb.consolidationPenalty < 0) hardGates.push(`exh+consol→cap0.58`);
      if (cb.moveExhaustionPenalty <= -0.15) hardGates.push(`exh≥0.15→cap0.60`);
      if (cb.adxMaturityPenalty <= -0.08 && cb.moveExhaustionPenalty <= -0.06) hardGates.push(`adxMat+exh→cap0.62`);
      if (cb.adxMaturityPenalty <= -0.07) hardGates.push(`adxMat≥0.07→cap0.64`);
      const rp = htfTf.priceStructure.rangePosition;
      const nearExt = (direction === 'bullish' && rp >= 0.85) || (direction === 'bearish' && rp <= 0.15);
      if (nearExt) hardGates.push(`extreme_rp=${rp.toFixed(2)}`);
      const atrRatioDbg = atrRatio !== undefined ? atrRatio.toFixed(2) : 'na';
      process.stdout.write(`  DBG ${timeET} $${currentPrice.toFixed(2)} ${direction} [${signalMode}] conf=${cb.total.toFixed(3)} eff=${effectiveThreshold.toFixed(3)} | base=0.380 ${factors} | gates: ${hardGates.join(', ') || 'none'} | adx=${htfTf.dmi.adx.toFixed(1)} adxSlope=${htfTf.dmi.adxSlope.toFixed(1)} adxBars25=${htfTf.dmi.adxBarsAbove25} rp=${rp.toFixed(2)} atrR=${atrRatioDbg} dvel=${displacementVelocity.toFixed(3)}\n`);
    }

    // ── Entry decision ──────────────────────────────────────────────────────────

    // Forward price analysis helpers (shared by both deterministic and AI paths)
    const computeForwardMoves = () => {
      const futureBars = targetDateBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt > currentTs && bt <= currentTs + 120 * 60_000;
      });
      // All remaining bars until market close (for order-agent sim)
      const allFutureBars = targetDateBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt > currentTs;
      });
      let maxFavorable = 0, maxAdverse = 0;
      let mfePeakMinutes = 0; // minutes after entry when MFE peaks
      for (const fb of futureBars) {
        const move = direction === 'bullish' ? fb.high - currentPrice : currentPrice - fb.low;
        const adverse = direction === 'bullish' ? currentPrice - fb.low : fb.high - currentPrice;
        if (move > maxFavorable) {
          maxFavorable = move;
          mfePeakMinutes = Math.round((new Date(fb.timestamp).getTime() - currentTs) / 60_000);
        }
        if (adverse > maxAdverse) maxAdverse = adverse;
      }
      const findPriceAt = (mins: number): number | null => {
        const targetTime = currentTs + mins * 60_000;
        const bar = targetDateBars.find(b => {
          const bt = new Date(b.timestamp).getTime();
          return bt >= targetTime && bt < targetTime + 60_000;
        });
        return bar?.close ?? null;
      };

      // ── Entry quality metrics (stock-price-based — fully accurate) ──
      const mfePct = (maxFavorable / currentPrice) * 100;
      const maePct = (maxAdverse / currentPrice) * 100;
      const mfeOverMae = maePct > 0.01 ? mfePct / maePct : (mfePct > 0 ? 99.9 : 0);

      // Directional move at key intervals (as % of entry price, positive = favorable)
      const computeMovePct = (priceAtN: number | null): number | null => {
        if (priceAtN === null) return null;
        const move = direction === 'bullish' ? priceAtN - currentPrice : currentPrice - priceAtN;
        return (move / currentPrice) * 100;
      };
      const p5m = findPriceAt(5), p10m = findPriceAt(10), p15m = findPriceAt(15), p30m = findPriceAt(30);
      const move5mPct = computeMovePct(p5m);
      const move10mPct = computeMovePct(p10m);
      const move15mPct = computeMovePct(p15m);
      const move30mPct = computeMovePct(p30m);

      // ── Sequence-aware grading (MFE-before-MAE) ──
      // Walk 1m bar OPENS only — opens are the first price in each bar,
      // so the sequence is unambiguous (unlike high/low within a bar).
      // Grade is based on how much favorable move is reached BEFORE the
      // adverse move hits the stop threshold.
      //
      // Stop = 1.0x ATR as stock-price stop. This matches the live order-agent's
      // effective stop: 13% trailing floor on option premium with ~0.40 delta
      // → ~$0.975 stock move on a $3 SPY option → ~0.14% on $696 SPY.
      // At ATR=$0.65, 1.0x ATR = 0.093% which is close to the live stop.
      // Previous 0.40x ATR (0.037%) was too tight — normal 1-min noise triggered
      // stops on every entry, grading everything as F even when direction was correct.
      const stopThresholdPct = (atr / currentPrice) * 100 * 1.0; // 1.0x ATR as stop
      let seqMfePct = 0;   // running max favorable excursion (%)
      let seqMaePct = 0;   // running max adverse excursion (%)
      let stoppedOut = false;
      let seqMfePeakMin = 0;
      for (const fb of futureBars) {
        const favMove = direction === 'bullish'
          ? ((fb.open - currentPrice) / currentPrice) * 100
          : ((currentPrice - fb.open) / currentPrice) * 100;
        const advMove = favMove < 0 ? -favMove : 0;
        const favGain = favMove > 0 ? favMove : 0;
        if (advMove > seqMaePct) seqMaePct = advMove;
        if (seqMaePct >= stopThresholdPct) { stoppedOut = true; break; }
        if (favGain > seqMfePct) {
          seqMfePct = favGain;
          seqMfePeakMin = Math.round((new Date(fb.timestamp).getTime() - currentTs) / 60_000);
        }
      }

      // Direction correct: based on sequence-aware MFE (reached before stop)
      const directionCorrect = seqMfePct > 0.10;

      // Entry grade: sequence-aware (MFE-before-MAE)
      //   Measures favorable move reached BEFORE adverse hits stop threshold.
      //   A: reached +0.4% before stop — strong capturable move
      //   B: reached +0.25% before stop — good capturable move
      //   C: reached +0.15% before stop — modest move, direction correct
      //   D: direction correct but weak (< 0.15% before stop)
      //   F: stopped out before any meaningful favorable move, or wrong direction
      let entryGrade: 'A' | 'B' | 'C' | 'D' | 'F';
      if (seqMfePct > 0.40) entryGrade = 'A';
      else if (seqMfePct > 0.25) entryGrade = 'B';
      else if (seqMfePct > 0.15 && directionCorrect) entryGrade = 'C';
      else if (directionCorrect) entryGrade = 'D';
      else entryGrade = 'F';

      // Outcome based on entry quality (stock-price), NOT sim P&L
      let outcome: 'GOOD' | 'BAD' | 'MARGINAL' = 'MARGINAL';
      if (entryGrade === 'A' || entryGrade === 'B') outcome = 'GOOD';
      else if (entryGrade === 'F') outcome = 'BAD';

      // Recent 1m bars before entry for volatility measurement
      const recentBars = targetDateBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt <= currentTs && bt > currentTs - 10 * 60_000;
      });
      // Simulate order-agent trailing stop on remaining bars (secondary metric)
      const sim = TCFG.simulate(currentPrice, direction, atr, allFutureBars, {
        recentBars,
        trace: HTML_OUTPUT,
        ...(signalMode === 'vwap_reversion' ? { stopMult: 0.4, tpMult: 0.6 }
          : signalMode === 'range' ? { stopMult: 0.5, tpMult: 0.8 }
          : signalMode === 'breakout' ? { stopMult: TCFG.breakoutStopMult, tpMult: TCFG.breakoutTpMult } : {}),
      });
      return {
        maxFavorable, maxAdverse, mfePct, maePct, mfeOverMae, directionCorrect,
        move5mPct, move10mPct, move15mPct, move30mPct, entryGrade, outcome, sim,
        priceAt5m: p5m, priceAt10m: p10m, priceAt15m: p15m, priceAt30m: p30m,
        mfePeakMinutes,
        seqMfePct, seqMaePct, stoppedOut, stopThresholdPct,
      };
    };

    // Regime context snapshot for entry records
    const regimeCtx = { regimeScore, rangeExhaustion, displacementVelocity, choppiness, intradayTrendStrength };

    /** Push a filter-blocked entry with forward-move counterfactual analysis */
    const pushFilterBlocked = (filterRule: string) => {
      const fwd = computeForwardMoves();
      filterBlockedEntries.push({
        time: timeStr, timeET, direction, signalMode, confidence: cb.total,
        price: currentPrice, filterRule, filterCategory: filterCategory(filterRule),
        mfePct: fwd.mfePct, maePct: fwd.maePct, mfeOverMae: fwd.mfeOverMae, mfePeakMinutes: fwd.mfePeakMinutes,
        entryGrade: fwd.entryGrade, outcome: fwd.outcome,
        ...regimeCtx,
      });
    };

    if (USE_AI && orchestrator) {
      // ── AI Orchestrator path ──────────────────────────────────────────────
      // AnalysisAgent.run() above already enforced shouldAllowEntry, entry-window,
      // and topology — analysis.meetsEntryThreshold reflects all of those.
      // When the analysis blocks, push the filter-blocked record once per tick
      // for the rejected-goods miner.
      const aiMeetsThreshold = meetsThreshold && direction !== 'neutral';
      if (!aiMeetsThreshold && entryBlockReason && direction !== 'neutral') {
        pushFilterBlocked(entryBlockReason);
      }

      if (aiMeetsThreshold) {
        const analysis: AnalysisResult = {
          signalId: signal.id,
          confidence: cb.total,
          confidenceBreakdown: cb,
          meetsEntryThreshold: meetsThreshold,
          aiExplanation: '',
          keyFactors: [],
          risks: [],
          desiredRight: direction === 'bearish' ? 'put' : 'call',
          createdAt: timeStr,
        };

        // Match live context-builder: last 10 decisions from last 30 min
        const thirtyMinAgoISO = new Date(currentTs - 30 * 60_000).toISOString();
        const recentInWindow = backtestRecentDecisions.filter(d => d.createdAt >= thirtyMinAgoISO);
        const context: PositionContext = {
          openPositions: [],
          brokerPositions: [],
          brokerOpenOrders: [],
          recentDecisions: recentInWindow.slice(0, 10),
          confirmationStreaks: [],
          recentEvaluations: [],
          accountEquity: 100_000,
          accountBuyingPower: 100_000,
          dailyRealizedPnl: 0,
          dailyPremiumDeployed,
          lastTrailingStopExit: null,
        };

        const decision: DecisionResult = await orchestrator.run({
          signal, option: optionEval, analysis, context, timeGateOk: true,
        });

        // Track decision for future context
        backtestRecentDecisions.unshift({
          decisionType: decision.decisionType,
          ticker: decision.ticker,
          direction: decision.direction ?? null,
          confirmationCount: decision.confirmationCount,
          orchestrationConfidence: decision.orchestrationConfidence,
          createdAt: decision.createdAt,
          reasoning: decision.reasoning,
        });
        // Keep only last 20 decisions
        if (backtestRecentDecisions.length > 20) backtestRecentDecisions.length = 20;

        // Map AI decision to gate result for compatibility with existing reporting
        let gateResult: EntryRecord['gateResult'];
        if (decision.decisionType === 'NEW_ENTRY' && decision.shouldExecute) {
          if (decision.reasoning.includes('[PHASE-CHANGE OVERRIDE]')) {
            gateResult = 'PHASE_CHANGE_OVERRIDE';
          } else if (cb.total >= 0.92 && alignment === 'all_aligned') {
            gateResult = 'HIGH_CONV_OVERRIDE';
          } else {
            gateResult = 'PASSED';
          }
          lastEntryTs = currentTs;
          dailyEntryCount++;
          rollingEntryTs.push(currentTs);
          // Track premium deployed for risk budget
          const aiPremium = estimateEntryPremium(atr, 0.50, ltfBars).entryPremium;
          const aiQty = Math.max(1, Math.min(LIVE_TICKER_CFG.maxContracts, Math.floor(100_000 * LIVE_TICKER_CFG.maxRiskPct / (aiPremium * 100))));
          dailyPremiumDeployed += aiPremium * aiQty * 100;
        } else if (decision.reasoning.includes('[STAGE-1 OBSERVE]')) {
          gateResult = 'STAGE1_OBSERVE';
        } else if (decision.reasoning.includes('[WEAKENING-SIGNAL BLOCK]')) {
          gateResult = 'WEAKENING_BLOCK';
        } else if (decision.reasoning.includes('[STALE-SIGNAL BLOCK]')) {
          gateResult = 'STALE_BLOCK';
        } else {
          gateResult = 'STAGE1_OBSERVE'; // AI chose WAIT or other non-entry
        }

        const fwd = computeForwardMoves();

        entries.push({
          time: timeStr, timeET, direction, alignment, confidence: cb.total,
          price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
          gateResult,
          aiDecision: decision.decisionType,
          aiShouldExecute: decision.shouldExecute,
          aiReasoning: decision.reasoning,
          aiConfirmationCount: decision.confirmationCount,
        });
      }
    } else {
      // ── Deterministic confirmation gate simulation ─────────────────────────
      // Reset confirmation state when direction changes or signal drops well below threshold.
      // Allow stage-1 to survive brief dips (up to 3 ticks) if direction holds — on trending
      // days, confidence oscillates near threshold and shouldn't reset the gate every tick.
      if (confirmStage1) {
        if (direction === 'neutral' || confirmStage1.direction !== direction) {
          confirmStage1 = null; // direction change = hard reset
        } else if (!meetsThreshold) {
          // Brief dip grace: keep stage-1 alive for up to 3 ticks below threshold
          const stage1Age = (currentTs - new Date(confirmStage1.time).getTime()) / 60_000;
          if (stage1Age > 3 || cb.total < MIN_CONFIDENCE - 0.03) {
            confirmStage1 = null; // too old or too far below threshold
          }
          // else: keep stage-1 alive, skip this tick (no entry push)
        }
      }

      // AnalysisAgent.run() above already enforced shouldAllowEntry, entry-window,
      // and topology — analysis.meetsEntryThreshold reflects all of those.
      // When the analysis blocks, push the filter-blocked record once per tick
      // for the rejected-goods miner.
      if (!meetsThreshold && entryBlockReason && direction !== 'neutral') {
        pushFilterBlocked(entryBlockReason);
      }

      if (meetsThreshold && direction !== 'neutral') {
        // ── Shared entry gate — same function used by live DecisionOrchestrator ──
        const htfTf = tfIndicators[2] ?? tfIndicators[0];
        const minutesSinceOpenGate = (currentTs - openTime.getTime()) / 60_000;

        const gateInput: GateInput = {
          confidence: cb.total,
          alignment,
          direction,
          signalMode,
          strengthScore,
          trendPhaseBonus: cb.trendPhaseBonus,
          adxBonus: cb.adxBonus,
          recentPriceActionBonus: cb.recentPriceActionBonus,
          nearLevelPenalty: cb.nearLevelPenalty,
          htf: htfTf ? {
            adx: htfTf.dmi.adx,
            growthCrossUp: htfTf.dmi.growthCrossUp,
            growthCrossDown: htfTf.dmi.growthCrossDown,
            rangePosition: htfTf.priceStructure.rangePosition,
          } : null,
          ltfVwapPriceVsVwap: tfIndicators[0]?.vwap?.priceVsVwap ?? null,
          orbFormed: signal.orb.orbFormed,
          orbBreakoutDirection: signal.orb.breakoutDirection,
          rangeExhaustion: rangeExhaustion ?? null,
          priorCount: confirmStage1 ? 1 : 0,
          minutesSinceOpen: minutesSinceOpenGate,
          rangeEntryCount,
          lastRangeEntryAgeMin: lastRangeEntryTs === 0 ? null : (currentTs - lastRangeEntryTs) / 60_000,
          breakoutEntryCount,
          lastBreakoutEntryAgeMin: lastBreakoutEntryTs === 0 ? null : (currentTs - lastBreakoutEntryTs) / 60_000,
          vwapRevEntryCount,
          lastVwapRevEntryAgeMin: lastVwapRevEntryTs === 0 ? null : (currentTs - lastVwapRevEntryTs) / 60_000,
          atrRatio,
          ticker: TICKER,
          // Risk budget checked outside the gate (below), matching live safety-gates approach.
          hasRecentPhaseChangeEntry: false, // backtest doesn't track phase-change history
          trendConsolidationBreakout,
          sameSideTrailingStopAgeSec: null, // backtest does not simulate position lifecycle / exits
        };

        const gate = evaluateEntryGate(gateInput);

        // Map gate result to backtest entry record
        let gateResult: EntryRecord['gateResult'];
        let stage1ConfValue: number | undefined;

        // Risk budget check (replaces old hard entry-count cap)
        const estPremium = estimateEntryPremium(atr, 0.50, ltfBars).entryPremium;
        const estQty = Math.max(1, Math.min(LIVE_TICKER_CFG.maxContracts, Math.floor(100_000 * LIVE_TICKER_CFG.maxRiskPct / (estPremium * 100))));
        const estCost = estPremium * estQty * 100;
        const budgetExceeded = dailyPremiumDeployed + estCost > 100_000 * DAILY_RISK_BUDGET_PCT;

        if (budgetExceeded) {
          // Risk budget exhausted — don't push entry
        } else if (gate.result === 'STAGE1_OBSERVE') {
          gateResult = 'STAGE1_OBSERVE';
          if (!confirmStage1) {
            confirmStage1 = { direction, confidence: cb.total, time: timeStr };
          }
          // Push as blocked entry for reporting
          const fwd = computeForwardMoves();
          entries.push({
            time: timeStr, timeET, direction, alignment, confidence: cb.total,
            price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
            gateResult,
          });
        } else {
          // Entry confirmed — map bypass to gateResult
          if (gate.result === 'HIGH_CONV_OVERRIDE') gateResult = 'HIGH_CONV_OVERRIDE';
          else if (gate.result === 'PHASE_CHANGE_OVERRIDE') gateResult = 'PHASE_CHANGE_OVERRIDE';
          else gateResult = 'PASSED';

          if (confirmStage1) {
            stage1ConfValue = confirmStage1.confidence;
          }
          confirmStage1 = null;
          lastEntryTs = currentTs;

          const fwd = computeForwardMoves();

          // Update mode-specific counters
          if (signalMode === 'range') { lastRangeEntryTs = currentTs; rangeEntryCount++; }
          else if (signalMode === 'breakout') { lastBreakoutEntryTs = currentTs; breakoutEntryCount++; }
          else if (signalMode === 'vwap_reversion') { lastVwapRevEntryTs = currentTs; vwapRevEntryCount++; }
          else { lastTrendEntryTs = currentTs; trendEntryCount++; }
          dailyEntryCount++;
          dailyPremiumDeployed += estCost;
          rollingEntryTs.push(currentTs);
          if (fwd.entryGrade === 'F' || fwd.entryGrade === 'D') intradayLosses++;

          entries.push({
            time: timeStr, timeET, direction, alignment, confidence: cb.total,
            price: currentPrice, strengthScore, signalMode, atr, ...fwd, breakdown: cb, ...regimeCtx,
            gateResult, stage1Conf: stage1ConfValue,
          });
        }
      }
    }

    // Progress indicator every 30 ticks
    if (tickCount % 30 === 0) {
      process.stdout.write(`  Processed ${tickCount} ticks (${timeET} ET, $${currentPrice.toFixed(2)}, ${direction} ${alignment} conf=${cb.total.toFixed(2)} regime=${regimeScore.toFixed(0)})\n`);
    }


  }

  // ── Step 3: Report ─────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  RESULTS: ${tickCount} ticks processed, ${entries.length} potential entries found`);
  console.log(`${'='.repeat(80)}\n`);

  // Deduplicate and enforce cooldowns — matches live system behavior.
  // Live scheduler runs every ~3 min, so entries < 3 min apart can't happen in production.
  // Within a cooldown window: keep the first confirmed entry, skip duplicates.
  // Position-aware: after a confirmed entry, skip re-entries until the sim position
  // would have exited. This matches live behavior where the OrderAgent holds the
  // position and subsequent signals become CONFIRM_HOLD, not NEW_ENTRY.
  // Fallback to mode-based cooldown when sim hold duration is unavailable.
  const isConfirmed = (e: EntryRecord) => e.gateResult === 'PASSED' || e.gateResult === 'HIGH_CONV_OVERRIDE' || e.gateResult === 'PHASE_CHANGE_OVERRIDE';
  const cooldownByMode: Record<string, number> = {
    trend: TREND_COOLDOWN_MIN * 60_000,
    range: RANGE_COOLDOWN_MIN * 60_000,
    breakout: BREAKOUT_COOLDOWN_MIN * 60_000,
    vwap_reversion: RANGE_COOLDOWN_MIN * 60_000,
  };
  // Track when the current simulated position exits (position-aware cooldown)
  let positionExitTs = 0;
  const lastConfirmedByMode = new Map<string, number>();
  const dedupedEntries: EntryRecord[] = [];
  for (const entry of entries) {
    const currTs = new Date(entry.time).getTime();
    // Same-bar dedup: within 1 min of previous entry with same direction, keep best
    const prev = dedupedEntries[dedupedEntries.length - 1];
    if (prev && prev.direction === entry.direction) {
      const prevTs = new Date(prev.time).getTime();
      if (currTs - prevTs < 1 * 60_000) {
        if (isConfirmed(entry) && !isConfirmed(prev)) {
          dedupedEntries[dedupedEntries.length - 1] = entry;
          if (isConfirmed(entry)) {
            lastConfirmedByMode.set(entry.signalMode, currTs);
            positionExitTs = currTs + entry.sim.holdMinutes * 60_000;
          }
        }
        continue;
      }
    }
    // Position-aware cooldown: skip entries while a simulated position is still open.
    // Matches live behavior where OrderAgent owns the position lifecycle.
    if (isConfirmed(entry) && positionExitTs > 0 && currTs < positionExitTs) {
      continue; // position still open — live would send CONFIRM_HOLD, not NEW_ENTRY
    }
    // Fallback: mode-based cooldown when no position is active
    if (isConfirmed(entry)) {
      const lastTs = lastConfirmedByMode.get(entry.signalMode) ?? 0;
      const cooldown = cooldownByMode[entry.signalMode] ?? 0;
      if (cooldown > 0 && lastTs > 0 && currTs - lastTs < cooldown) {
        continue;
      }
      lastConfirmedByMode.set(entry.signalMode, currTs);
      positionExitTs = currTs + entry.sim.holdMinutes * 60_000;
    }
    dedupedEntries.push(entry);
  }

  // Gate statistics
  const confirmedEntries = dedupedEntries.filter(e => isConfirmed(e));
  const blockedEntries = dedupedEntries.filter(e => !isConfirmed(e));

  // ── Entry Validation (proof of correctness) ──────────────────────────────────
  const validationErrors: string[] = [];
  {
    // 1. Validate daily risk budget wasn't exceeded
    // (approximate — actual budget is checked during entry, this is a sanity check)
    const budgetUsd = 100_000 * DAILY_RISK_BUDGET_PCT;
    if (dailyPremiumDeployed > budgetUsd * 1.1) { // 10% tolerance for estimation drift
      validationErrors.push(`RISK BUDGET WARNING: deployed $${dailyPremiumDeployed.toFixed(0)} > budget $${budgetUsd.toFixed(0)} (${(DAILY_RISK_BUDGET_PCT * 100).toFixed(1)}%)`);
    }

    // 2. Validate per-mode entry counts
    const confirmedRange = confirmedEntries.filter(e => e.signalMode === 'range').length;
    const confirmedBreakout = confirmedEntries.filter(e => e.signalMode === 'breakout').length;
    const confirmedTrend = confirmedEntries.filter(e => e.signalMode === 'trend').length;
    const confirmedVwapRev = confirmedEntries.filter(e => e.signalMode === 'vwap_reversion').length;
    // Per-mode caps: relaxed since strongSignalBypass can produce entries beyond mode limits
    // (matches live: DecisionOrchestrator strongSignalBypass ignores per-mode limits).
    // Only log as warnings, not errors.
    if (confirmedRange > MAX_RANGE_ENTRIES + 2) {
      validationErrors.push(`RANGE CAP WARNING: ${confirmedRange} range entries > MAX_RANGE_ENTRIES=${MAX_RANGE_ENTRIES}+2`);
    }
    if (confirmedBreakout > MAX_BREAKOUT_ENTRIES) {
      validationErrors.push(`BREAKOUT CAP VIOLATED: ${confirmedBreakout} breakout entries > MAX_BREAKOUT_ENTRIES=${MAX_BREAKOUT_ENTRIES}`);
    }
    // Trend has no hard cap — risk budget is the limiter.
    if (confirmedVwapRev > 2) {
      validationErrors.push(`VWAP_REV CAP WARNING: ${confirmedVwapRev} vwap_reversion entries > 2`);
    }

    // 3. Validate entry times within market hours
    for (let i = 0; i < confirmedEntries.length; i++) {
      const e = confirmedEntries[i]!;
      const eTs = new Date(e.time).getTime();
      if (eTs < openTime.getTime() || eTs > closeTime.getTime()) {
        validationErrors.push(`MARKET HOURS VIOLATED: Entry #${i + 1} at ${e.timeET} ET is outside market hours`);
      }
    }

    // 4. Entry time window — soft annotation only (matches live: DecisionOrchestrator ignores it).
    //    No longer a validation error since backtest now allows entries outside window.

    // 5. Validate cooldowns between consecutive entries of same mode
    const byMode = new Map<string, typeof confirmedEntries>();
    for (const e of confirmedEntries) {
      if (!byMode.has(e.signalMode)) byMode.set(e.signalMode, []);
      byMode.get(e.signalMode)!.push(e);
    }
    const cooldownMins: Record<string, number> = {
      range: RANGE_COOLDOWN_MIN,
      breakout: BREAKOUT_COOLDOWN_MIN,
      trend: TREND_COOLDOWN_MIN,
      vwap_reversion: 15,
    };
    for (const [mode, modeEntries] of byMode) {
      const cooldown = cooldownMins[mode] ?? 0;
      for (let i = 1; i < modeEntries.length; i++) {
        const prevTs = new Date(modeEntries[i - 1]!.time).getTime();
        const currTs = new Date(modeEntries[i]!.time).getTime();
        const gapMin = (currTs - prevTs) / 60_000;
        if (gapMin < cooldown) {
          validationErrors.push(`COOLDOWN VIOLATED: ${mode} entries ${i} and ${i + 1} are ${gapMin.toFixed(0)}m apart (min=${cooldown}m)`);
        }
      }
    }

    // 6. Validate wait periods (range/breakout not in first N minutes)
    for (const e of confirmedEntries) {
      const eTs = new Date(e.time).getTime();
      if (e.signalMode === 'range' && eTs < rangeEarliestTs) {
        validationErrors.push(`RANGE WAIT VIOLATED: Range entry at ${e.timeET} ET before ${RANGE_WAIT_MIN}m wait period`);
      }
      if (e.signalMode === 'breakout' && eTs < breakoutEarliestTs) {
        validationErrors.push(`BREAKOUT WAIT VIOLATED: Breakout entry at ${e.timeET} ET before ${BREAKOUT_WAIT_MIN}m wait period`);
      }
    }

    // Print validation results
    console.log(`  ── Entry Validation ──`);
    console.log(`  Entry counts: ${confirmedEntries.length} total | Risk budget: $${dailyPremiumDeployed.toFixed(0)}/$${budgetUsd.toFixed(0)} (${(DAILY_RISK_BUDGET_PCT * 100).toFixed(1)}%) | Range: ${confirmedRange}/${MAX_RANGE_ENTRIES} | Breakout: ${confirmedBreakout}/${MAX_BREAKOUT_ENTRIES} | Trend: ${confirmedTrend} | VWAP Rev: ${confirmedVwapRev}/1`);

    if (confirmedEntries.length > 0) {
      const firstEntry = confirmedEntries[0]!;
      const lastEntry = confirmedEntries[confirmedEntries.length - 1]!;
      console.log(`  Entry time span: ${firstEntry.timeET} ET → ${lastEntry.timeET} ET (window: ${TCFG.entryWindowStartMin}-${TCFG.entryWindowEndMin}m after open)`);
      console.log(`  Entry times:     ${confirmedEntries.map((e, i) => `#${i + 1} ${e.timeET} ET [${e.signalMode}]`).join('  |  ')}`);
    }

    // Cooldown proof
    for (const [mode, modeEntries] of byMode) {
      if (modeEntries.length >= 2) {
        const gaps: string[] = [];
        for (let i = 1; i < modeEntries.length; i++) {
          const gapMin = (new Date(modeEntries[i]!.time).getTime() - new Date(modeEntries[i - 1]!.time).getTime()) / 60_000;
          gaps.push(`${gapMin.toFixed(0)}m`);
        }
        console.log(`  ${mode} cooldown gaps: ${gaps.join(', ')} (min=${cooldownMins[mode] ?? 0}m)`);
      }
    }

    if (validationErrors.length === 0) {
      console.log(`  ✅ All entry validations passed`);
    } else {
      for (const err of validationErrors) {
        console.log(`  ❌ ${err}`);
      }
    }
    console.log('');
  }

  // ── Confirmed Entries (what would actually trade) ──
  console.log(`  Confirmed entries: ${confirmedEntries.length} (of ${dedupedEntries.length} signals)\n`);

  for (let i = 0; i < confirmedEntries.length; i++) {
    const e = confirmedEntries[i]!;
    const gradeIcon = { A: '🟢 A', B: '🔵 B', C: '🟡 C', D: '🟠 D', F: '🔴 F' }[e.entryGrade];
    const gateTag = e.gateResult === 'PASSED' ? '🟢 CONFIRMED'
      : e.gateResult === 'HIGH_CONV_OVERRIDE' ? '⚡ HIGH-CONV OVERRIDE'
      : '⚡ PHASE-CHANGE OVERRIDE';
    const modeTag = e.signalMode === 'vwap_reversion' ? ' [VWAP_REV]' : e.signalMode === 'range' ? ' [RANGE]' : e.signalMode === 'breakout' ? ' [BREAKOUT]' : '';
    const dirTag = e.directionCorrect ? '✅' : '❌';
    console.log(`  Entry #${i + 1}: Grade ${gradeIcon} | ${gateTag}${modeTag}`);
    console.log(`    Time:       ${e.timeET} ET (${e.time.slice(11, 19)} UTC)`);
    console.log(`    Direction:  ${e.direction.toUpperCase()} ${dirTag} | Alignment: ${e.alignment} | Strength: ${e.strengthScore}${e.signalMode === 'range' ? ' | Mode: RANGE' : ''}`);
    console.log(`    Price:      $${e.price.toFixed(2)} | Confidence: ${(e.confidence * 100).toFixed(1)}%${e.stage1Conf !== undefined ? ` (Stage-1 was ${(e.stage1Conf * 100).toFixed(1)}%)` : ''}`);
    console.log(`    ATR: $${e.atr.toFixed(3)} | Regime: ${e.regimeScore ?? '-'} | RangeExh: ${e.rangeExhaustion?.toFixed(1) ?? '-'} | DispVel: ${e.displacementVelocity?.toFixed(3) ?? '-'} | Chop: ${e.choppiness?.toFixed(2) ?? '-'} | TrendStr: ${e.intradayTrendStrength ?? '-'}`);
    // Entry quality — sequence-aware (MFE reached before stop hit)
    const seqTag = e.stoppedOut ? '🛑 stopped' : '✅ held';
    console.log(`    Entry Quality: SeqMFE=${e.seqMfePct.toFixed(2)}% ${seqTag} | Stop@${e.stopThresholdPct.toFixed(2)}% | SeqMAE=${e.seqMaePct.toFixed(2)}%`);
    console.log(`    Raw 2h window: MFE=${e.mfePct.toFixed(2)}% | MAE=${e.maePct.toFixed(2)}% | MFE/MAE=${e.mfeOverMae.toFixed(1)} | Fav=$${e.maxFavorable.toFixed(2)} | Adv=$${e.maxAdverse.toFixed(2)}`);
    // Directional moves at intervals
    const fmtMove = (label: string, pct: number | null, price: number | null) => {
      if (pct === null || price === null) return '';
      return `    ${label}:  $${price.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%)`;
    };
    const moveLines = [
      fmtMove('5m ', e.move5mPct, e.priceAt5m),
      fmtMove('10m', e.move10mPct, e.priceAt10m),
      fmtMove('15m', e.move15mPct, e.priceAt15m),
      fmtMove('30m', e.move30mPct, e.priceAt30m),
    ].filter(l => l);
    if (moveLines.length > 0) console.log(moveLines.join('\n'));
    // Sim trade (secondary — approximate)
    const simIcon = e.sim.pnlPct >= 0 ? '📈' : '📉';
    const simExitTag = e.sim.exitReason === 'TP' ? '🎯 TP'
      : e.sim.exitReason === 'STOP' ? '🛑 STOP'
      : e.sim.exitReason === 'CLOSE' ? '🔔 CLOSE'
      : e.sim.exitReason;
    const deltaInfo = e.sim.entryDelta != null ? ` | Delta: ${e.sim.entryDelta.toFixed(2)}` : '';
    const premInfo = e.sim.entryPremium != null ? ` | Prem: $${e.sim.entryPremium.toFixed(2)}→$${(e.sim.exitPremium ?? 0).toFixed(2)}` : '';
    console.log(`    Sim (approx): ${simIcon} P&L ${e.sim.pnlPct >= 0 ? '+' : ''}${e.sim.pnlPct.toFixed(1)}% | Exit: ${simExitTag} after ${e.sim.holdMinutes}m | Peak: +${e.sim.peakPnlPct.toFixed(1)}% | DD: -${e.sim.maxDrawdownPct.toFixed(1)}%${deltaInfo}${premInfo}`);
    // All confidence factors (matches live analysis-agent.ts 29-factor breakdown)
    const cb = e.breakdown;
    const factors = [
      { name: 'DI Spread', val: cb.diSpreadBonus },
      { name: 'ADX', val: cb.adxBonus },
      { name: 'DI Cross', val: cb.diCrossBonus },
      { name: 'Alignment', val: cb.alignmentBonus },
      { name: 'TD', val: cb.tdAdjustment },
      { name: 'VWAP', val: cb.vwapBonus },
      { name: 'OBV', val: cb.obvBonus },
      { name: 'OI/Vol', val: cb.oiVolumeBonus },
      { name: 'Structure', val: cb.structureBonus },
      { name: 'ORB', val: cb.orbBonus },
      { name: 'Price Action', val: cb.recentPriceActionBonus },
      { name: 'Trend Phase', val: cb.trendPhaseBonus },
      { name: 'Momentum', val: cb.momentumAccelBonus },
      { name: 'PricePos', val: cb.pricePositionAdjustment },
      { name: 'ADX Maturity', val: cb.adxMaturityPenalty },
      { name: 'TR Contract', val: cb.trContractionPenalty },
      { name: 'Low Vol', val: cb.lowVolPenalty },
      { name: 'Exhaustion', val: cb.moveExhaustionPenalty },
      { name: 'Consolidation', val: cb.consolidationPenalty },
      { name: 'Near Level', val: cb.nearLevelPenalty },
      { name: 'Theta', val: cb.thetaDecayPenalty },
      { name: 'Narrow Range', val: cb.narrowRangePenalty },
      { name: 'Candle', val: cb.candlePatternBonus },
      { name: 'PriceVel', val: cb.priceVelocityBonus },
      { name: 'VolSurge', val: cb.volumeSurgeBonus },
      { name: 'MACD', val: cb.macdBonus },
      { name: 'Conv/Div', val: cb.convergenceDurationBonus },
      { name: 'OrderFlow', val: cb.orderFlowBonus },
      { name: 'Persistence', val: cb.trendPersistenceBonus },
    ].filter(f => Math.abs(f.val) >= 0.005);
    const factorStr = factors.map(f => `${f.name}=${f.val >= 0 ? '+' : ''}${f.val.toFixed(3)}`).join(', ');
    console.log(`    Factors:    base=0.380, ${factorStr}`);
    if (e.aiDecision) {
      console.log(`    AI Decision: ${e.aiDecision} (execute=${e.aiShouldExecute}, count=${e.aiConfirmationCount})`);
      const reason = e.aiReasoning ?? '';
      console.log(`    AI Reason:  ${reason.length > 200 ? reason.slice(0, 200) + '...' : reason}`);
    }
    console.log('');
  }

  // ── Entry Quality Summary (PRIMARY — stock-price-based, fully accurate) ──
  const confirmedGood = confirmedEntries.filter(e => e.outcome === 'GOOD').length;
  const confirmedBad = confirmedEntries.filter(e => e.outcome === 'BAD').length;
  const confirmedMarginal = confirmedEntries.length - confirmedGood - confirmedBad;
  const dirCorrectCount = confirmedEntries.filter(e => e.directionCorrect).length;
  const dirAccuracy = confirmedEntries.length > 0 ? (dirCorrectCount / confirmedEntries.length * 100) : 0;
  const avgSeqMfePct = confirmedEntries.length > 0 ? confirmedEntries.reduce((s, e) => s + e.seqMfePct, 0) / confirmedEntries.length : 0;
  const avgSeqMaePct = confirmedEntries.length > 0 ? confirmedEntries.reduce((s, e) => s + e.seqMaePct, 0) / confirmedEntries.length : 0;
  const stoppedOutCount = confirmedEntries.filter(e => e.stoppedOut).length;
  const gradeA = confirmedEntries.filter(e => e.entryGrade === 'A').length;
  const gradeB = confirmedEntries.filter(e => e.entryGrade === 'B').length;
  const gradeC = confirmedEntries.filter(e => e.entryGrade === 'C').length;
  const gradeD = confirmedEntries.filter(e => e.entryGrade === 'D').length;
  const gradeF = confirmedEntries.filter(e => e.entryGrade === 'F').length;

  console.log(`${'─'.repeat(80)}`);
  console.log(`  ENTRY QUALITY (sequence-aware — MFE before stop hit)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Entries:      ${confirmedEntries.length} confirmed | ${blockedEntries.length} blocked`);
  console.log(`  Direction:    ${dirCorrectCount}/${confirmedEntries.length} correct (${dirAccuracy.toFixed(0)}%)`);
  console.log(`  Avg SeqMFE:   ${avgSeqMfePct.toFixed(3)}% | Avg SeqMAE: ${avgSeqMaePct.toFixed(3)}% | Stopped out: ${stoppedOutCount}/${confirmedEntries.length}`);
  console.log(`  Grades:       🟢 A:${gradeA}  🔵 B:${gradeB}  🟡 C:${gradeC}  🟠 D:${gradeD}  🔴 F:${gradeF}`);
  console.log(`  Outcome:      ✅ ${confirmedGood} good (A+B) | ❌ ${confirmedBad} bad (F) | ⚠️  ${confirmedMarginal} marginal (C+D)`);

  // ── Mode breakdown by entry quality ──
  const rangeEntries = confirmedEntries.filter(e => e.signalMode === 'range');
  const trendEntries = confirmedEntries.filter(e => e.signalMode === 'trend');
  const breakoutEntries = confirmedEntries.filter(e => e.signalMode === 'breakout');
  if (rangeEntries.length > 0 || breakoutEntries.length > 0) {
    const modeSummary = (label: string, entries: typeof confirmedEntries) => {
      const correct = entries.filter(e => e.directionCorrect).length;
      const mfe = entries.reduce((s, e) => s + e.seqMfePct, 0) / (entries.length || 1);
      const mae = entries.reduce((s, e) => s + e.seqMaePct, 0) / (entries.length || 1);
      const grades = entries.map(e => e.entryGrade).join('');
      return `${label}: ${correct}/${entries.length} dir (${mfe.toFixed(2)}/${mae.toFixed(2)} SeqMFE/MAE) [${grades}]`;
    };
    const parts = [];
    if (rangeEntries.length > 0) parts.push(modeSummary('RANGE', rangeEntries));
    if (breakoutEntries.length > 0) parts.push(modeSummary('BREAKOUT', breakoutEntries));
    if (trendEntries.length > 0) parts.push(modeSummary('TREND', trendEntries));
    console.log(`  By mode:      ${parts.join(' | ')}`);
  }

  // ── Sim Summary (SECONDARY — approximate, option P&L not fully accurate) ──
  const confirmedSims = confirmedEntries.map(e => e.sim);
  const simWins = confirmedSims.filter(s => s.pnlPct > 0).length;
  const simLosses = confirmedSims.filter(s => s.pnlPct <= 0).length;
  const avgPnl = confirmedSims.reduce((sum, s) => sum + s.pnlPct, 0) / (confirmedSims.length || 1);
  const totalPnl = confirmedSims.reduce((sum, s) => sum + s.pnlPct, 0);
  const avgHold = confirmedSims.reduce((sum, s) => sum + s.holdMinutes, 0) / (confirmedSims.length || 1);
  const avgPeak = confirmedSims.reduce((sum, s) => sum + s.peakPnlPct, 0) / (confirmedSims.length || 1);
  const tpExits = confirmedSims.filter(s => s.exitReason === 'TP').length;
  const stopExits = confirmedSims.filter(s => s.exitReason === 'STOP').length;
  const closeExits = confirmedSims.filter(s => s.exitReason === 'CLOSE').length;
  console.log(`\n  SIM (approximate — option premium not fully modeled)`);
  console.log(`  Sim W/L:      ${simWins}W / ${simLosses}L (${confirmedSims.length > 0 ? ((simWins / confirmedSims.length) * 100).toFixed(0) : 0}%) | Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}% | Total: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`);
  console.log(`  Avg hold:     ${avgHold.toFixed(0)}m | Avg peak: +${avgPeak.toFixed(1)}%`);
  console.log(`  Exits:        🎯 TP: ${tpExits} | 🛑 STOP: ${stopExits} | 🔔 CLOSE: ${closeExits}`);

  // ── Blocked signals (brief) ──
  if (blockedEntries.length > 0) {
    const blockedGood = blockedEntries.filter(e => e.outcome === 'GOOD').length;
    const blockedBad = blockedEntries.filter(e => e.outcome === 'BAD').length;
    console.log(`\n  ── Blocked Signals ──`);
    console.log(`  ${blockedEntries.length} blocked (${blockedGood} good missed [A/B], ${blockedBad} bad avoided [F])`);
    for (const blocked of blockedEntries) {
      const gradeIcon = { A: '🟢A', B: '🔵B', C: '🟡C', D: '🟠D', F: '🔴F' }[blocked.entryGrade];
      const outcomeIcon = blocked.outcome === 'GOOD' ? '⚠️  MISSED' : blocked.outcome === 'BAD' ? '✅ AVOIDED' : '── MARGINAL';
      const blockTag = blocked.gateResult === 'STAGE1_OBSERVE' ? 'STAGE-1'
        : blocked.gateResult === 'WEAKENING_BLOCK' ? 'WEAKENING'
        : blocked.gateResult === 'STALE_BLOCK' ? 'STALE' : blocked.gateResult;
      const bcb = blocked.breakdown;
      const bFactors = [
        { name: 'DI Spread', val: bcb.diSpreadBonus }, { name: 'ADX', val: bcb.adxBonus },
        { name: 'DI Cross', val: bcb.diCrossBonus }, { name: 'Alignment', val: bcb.alignmentBonus },
        { name: 'TD', val: bcb.tdAdjustment }, { name: 'VWAP', val: bcb.vwapBonus },
        { name: 'OBV', val: bcb.obvBonus }, { name: 'OI/Vol', val: bcb.oiVolumeBonus },
        { name: 'Structure', val: bcb.structureBonus }, { name: 'ORB', val: bcb.orbBonus },
        { name: 'PA', val: bcb.recentPriceActionBonus }, { name: 'Trend', val: bcb.trendPhaseBonus },
        { name: 'Mom', val: bcb.momentumAccelBonus }, { name: 'PricePos', val: bcb.pricePositionAdjustment },
        { name: 'Maturity', val: bcb.adxMaturityPenalty }, { name: 'TRContract', val: bcb.trContractionPenalty },
        { name: 'LowVol', val: bcb.lowVolPenalty }, { name: 'Exhaust', val: bcb.moveExhaustionPenalty },
        { name: 'Consol', val: bcb.consolidationPenalty }, { name: 'NearLvl', val: bcb.nearLevelPenalty },
        { name: 'Theta', val: bcb.thetaDecayPenalty }, { name: 'NarrowRng', val: bcb.narrowRangePenalty },
        { name: 'Candle', val: bcb.candlePatternBonus }, { name: 'PriceVel', val: bcb.priceVelocityBonus },
        { name: 'VolSurge', val: bcb.volumeSurgeBonus },
        { name: 'MACD', val: bcb.macdBonus }, { name: 'Conv/Div', val: bcb.convergenceDurationBonus },
        { name: 'OrderFlow', val: bcb.orderFlowBonus }, { name: 'Persist', val: bcb.trendPersistenceBonus },
      ].filter(f => Math.abs(f.val) >= 0.005);
      const bFactorStr = bFactors.map(f => `${f.name}=${f.val >= 0 ? '+' : ''}${f.val.toFixed(3)}`).join(', ');
      console.log(`     ${blocked.timeET} ET ${blocked.direction} ${blockTag} → ${outcomeIcon} ${gradeIcon} (conf=${(blocked.confidence * 100).toFixed(1)}%, MFE=${blocked.mfePct.toFixed(2)}% MAE=${blocked.maePct.toFixed(2)}%)`);
      console.log(`       Factors: base=0.380, ${bFactorStr}`);
    }
  }

  // ── Filter Counterfactual Analysis (what filter-blocked entries would have done) ──
  if (filterBlockedEntries.length > 0) {
    // Deduplicate: within 5-min windows of same direction, keep best grade
    const dedupedFiltered: FilterBlockedEntry[] = [];
    for (const fb of filterBlockedEntries) {
      const prev = dedupedFiltered[dedupedFiltered.length - 1];
      if (prev && prev.direction === fb.direction) {
        const prevTs = new Date(prev.time).getTime();
        const currTs = new Date(fb.time).getTime();
        if (currTs - prevTs < 5 * 60_000) {
          // Keep higher confidence / better grade within same window
          const gradeRank = { A: 5, B: 4, C: 3, D: 2, F: 1 };
          if (gradeRank[fb.entryGrade] > gradeRank[prev.entryGrade] || (gradeRank[fb.entryGrade] === gradeRank[prev.entryGrade] && fb.confidence > prev.confidence)) {
            dedupedFiltered[dedupedFiltered.length - 1] = fb;
          }
          continue;
        }
      }
      dedupedFiltered.push(fb);
    }

    const fbGood = dedupedFiltered.filter(e => e.outcome === 'GOOD').length;
    const fbBad = dedupedFiltered.filter(e => e.outcome === 'BAD').length;
    const fbMarginal = dedupedFiltered.length - fbGood - fbBad;
    console.log(`\n  ── Filter Counterfactual Analysis ──`);
    console.log(`  ${dedupedFiltered.length} filter-blocked entries (from ${filterBlockedEntries.length} raw ticks)`);
    console.log(`  Would have been: ${fbGood} good (A/B) | ${fbBad} bad (F) | ${fbMarginal} marginal (C/D)`);

    // Per-filter category stats
    const categoryStats = new Map<string, { count: number; good: number; bad: number; marginal: number; avgMfe: number; avgMae: number; entries: FilterBlockedEntry[] }>();
    for (const fb of dedupedFiltered) {
      const cat = fb.filterCategory;
      if (!categoryStats.has(cat)) categoryStats.set(cat, { count: 0, good: 0, bad: 0, marginal: 0, avgMfe: 0, avgMae: 0, entries: [] });
      const s = categoryStats.get(cat)!;
      s.count++;
      if (fb.outcome === 'GOOD') s.good++;
      else if (fb.outcome === 'BAD') s.bad++;
      else s.marginal++;
      s.avgMfe += fb.mfePct;
      s.avgMae += fb.maePct;
      s.entries.push(fb);
    }

    console.log(`\n  Per-filter breakdown:`);
    console.log(`  ${'Filter Rule'.padEnd(35)} Count  Good  Bad  Marg  AvgMFE  AvgMAE  Net Value`);
    console.log(`  ${'─'.repeat(95)}`);

    for (const [cat, s] of [...categoryStats.entries()].sort((a, b) => b[1].good - a[1].good)) {
      const avgMfe = s.avgMfe / s.count;
      const avgMae = s.avgMae / s.count;
      // Net value: positive = filter is costing money (blocking good entries), negative = filter is saving money
      const netValue = s.good - s.bad;
      const netIcon = netValue > 0 ? '⚠️  COSTLY' : netValue < 0 ? '✅ HELPFUL' : '── NEUTRAL';
      console.log(`  ${cat.padEnd(35)} ${String(s.count).padStart(5)}  ${String(s.good).padStart(4)}  ${String(s.bad).padStart(3)}  ${String(s.marginal).padStart(4)}  ${avgMfe.toFixed(3)}%  ${avgMae.toFixed(3)}%  ${netValue >= 0 ? '+' : ''}${netValue} ${netIcon}`);
    }

    // Detail: show each deduped blocked entry
    console.log(`\n  Filter-blocked entries (deduped):`);
    for (const fb of dedupedFiltered) {
      const gradeIcon = { A: '🟢A', B: '🔵B', C: '🟡C', D: '🟠D', F: '🔴F' }[fb.entryGrade];
      const outcomeIcon = fb.outcome === 'GOOD' ? '⚠️  MISSED' : fb.outcome === 'BAD' ? '✅ AVOIDED' : '── MARGINAL';
      console.log(`     ${fb.timeET} ET ${fb.direction} [${fb.signalMode}] conf=${(fb.confidence * 100).toFixed(0)}% → ${outcomeIcon} ${gradeIcon} MFE=${fb.mfePct.toFixed(2)}% MAE=${fb.maePct.toFixed(2)}% | ${fb.filterRule}`);
    }
  }

  // Show direction distribution
  const bullishTicks = allTicks.filter(t => t.direction === 'bullish').length;
  const bearishTicks = allTicks.filter(t => t.direction === 'bearish').length;
  const neutralTicks = allTicks.filter(t => t.direction === 'neutral').length;
  console.log(`\n  Direction distribution: ${bullishTicks} bullish, ${bearishTicks} bearish, ${neutralTicks} neutral ticks`);

  // Confidence distribution
  const aboveThreshold = allTicks.filter(t => t.meetsThreshold).length;
  console.log(`  Above threshold (${(MIN_CONFIDENCE * 100).toFixed(0)}%): ${aboveThreshold}/${tickCount} ticks (${(aboveThreshold / tickCount * 100).toFixed(1)}%)`);

  // Show price chart with confirmed entry markers only
  console.log(`\n  Price timeline with confirmed entries:`);
  const step = Math.max(1, Math.floor(allTicks.length / 60)); // ~60 data points
  for (let i = 0; i < allTicks.length; i += step) {
    const tick = allTicks[i]!;
    const entryHere = confirmedEntries.find(e => {
      const eDiff = Math.abs(new Date(e.time).getTime() - new Date(tick.time).getTime());
      return eDiff < step * 60_000;
    });
    const marker = entryHere
      ? ` ${({ A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' })[entryHere.entryGrade]} ${entryHere.entryGrade} SeqMFE=${entryHere.seqMfePct.toFixed(2)}%${entryHere.stoppedOut ? '🛑' : ''}`
      : '';
    const dir = tick.direction === 'bullish' ? '▲' : tick.direction === 'bearish' ? '▼' : '─';
    const confBar = '█'.repeat(Math.round(tick.confidence * 20));
    console.log(`    ${tick.timeET} ${dir} $${tick.price.toFixed(2)} [${confBar.padEnd(20)}] ${(tick.confidence * 100).toFixed(0)}%${marker}`);
  }

  console.log(`\n${'='.repeat(80)}\n`);

  if (gradeF > 0) {
    console.log(`  ⚠️  ${gradeF} F-grade entry(s) — wrong direction. Review filters to block these.\n`);
  } else if (gradeD > 0) {
    console.log(`  🟠 ${gradeD} D-grade entry(s) — direction correct but weak move. Consider tighter filters.\n`);
  } else if (confirmedEntries.length > 0) {
    console.log(`  ✅ All confirmed entries graded C or better on ${TARGET_DATE}.\n`);
  } else {
    console.log(`  ── No confirmed entries on ${TARGET_DATE}.\n`);
  }

  // ── Market Move Scanner: detect missed entries from price action ────────────
  // Scans 1m bars for significant directional moves, then checks whether
  // the system had a matching signal at or near the move start.
  // This catches moves the system was completely blind to (neutral direction,
  // no mode, wrong direction, low confidence).
  {
    interface MarketMove {
      startIdx: number;
      startTime: string;
      startTimeET: string;
      startPrice: number;
      direction: 'bullish' | 'bearish';
      mfePct: number;          // max favorable excursion %
      maePct: number;          // max adverse excursion %
      mfePeakMinutes: number;
      peakPrice: number;
      peakTime: string;
      peakTimeET: string;
    }

    // Scan each bar as a potential move start; compute forward MFE/MAE over 120 min
    const MIN_MFE_PCT = 0.30; // only flag moves with MFE > 0.30% (meaningful for options)
    const LOOKAHEAD_BARS = 120; // 120 minutes forward window
    const moves: MarketMove[] = [];

    // Skip first 15 minutes (market open noise) and last 30 minutes (EOD theta)
    const scanStart = 15;
    const scanEnd = Math.max(0, targetDateBars.length - 30);

    for (let i = scanStart; i < scanEnd; i++) {
      const bar = targetDateBars[i]!;
      const entryPrice = bar.close;
      const entryTs = new Date(bar.timestamp).getTime();

      // Compute forward MFE for both directions
      let bullMfe = 0, bullMae = 0, bullPeakMin = 0, bullPeakPrice = entryPrice, bullPeakTs = bar.timestamp;
      let bearMfe = 0, bearMae = 0, bearPeakMin = 0, bearPeakPrice = entryPrice, bearPeakTs = bar.timestamp;

      for (let j = i + 1; j < Math.min(i + 1 + LOOKAHEAD_BARS, targetDateBars.length); j++) {
        const fb = targetDateBars[j]!;
        const mins = Math.round((new Date(fb.timestamp).getTime() - entryTs) / 60_000);

        // Bullish: favorable = price going up
        const bullFav = fb.high - entryPrice;
        const bullAdv = entryPrice - fb.low;
        if (bullFav > bullMfe) { bullMfe = bullFav; bullPeakMin = mins; bullPeakPrice = fb.high; bullPeakTs = fb.timestamp; }
        if (bullAdv > bullMae) bullMae = bullAdv;

        // Bearish: favorable = price going down
        const bearFav = entryPrice - fb.low;
        const bearAdv = fb.high - entryPrice;
        if (bearFav > bearMfe) { bearMfe = bearFav; bearPeakMin = mins; bearPeakPrice = fb.low; bearPeakTs = fb.timestamp; }
        if (bearAdv > bearMae) bearMae = bearAdv;
      }

      const bullMfePct = (bullMfe / entryPrice) * 100;
      const bearMfePct = (bearMfe / entryPrice) * 100;
      const bullMaePct = (bullMae / entryPrice) * 100;
      const bearMaePct = (bearMae / entryPrice) * 100;

      // Pick the stronger direction
      const bestDir = bullMfePct >= bearMfePct ? 'bullish' : 'bearish';
      const mfePct = bestDir === 'bullish' ? bullMfePct : bearMfePct;
      const maePct = bestDir === 'bullish' ? bullMaePct : bearMaePct;
      const mfePeakMin = bestDir === 'bullish' ? bullPeakMin : bearPeakMin;
      const peakPrice = bestDir === 'bullish' ? bullPeakPrice : bearPeakPrice;
      const peakTs = bestDir === 'bullish' ? bullPeakTs : bearPeakTs;

      if (mfePct >= MIN_MFE_PCT && (maePct < 0.01 || mfePct / maePct > 1.2)) {
        moves.push({
          startIdx: i,
          startTime: bar.timestamp,
          startTimeET: utcToET(bar.timestamp),
          startPrice: entryPrice,
          direction: bestDir,
          mfePct, maePct, mfePeakMinutes: mfePeakMin, peakPrice,
          peakTime: peakTs, peakTimeET: utcToET(peakTs),
        });
      }
    }

    // Deduplicate: within 10-min windows of same direction, keep best MFE
    const dedupedMoves: MarketMove[] = [];
    for (const mv of moves) {
      const prev = dedupedMoves[dedupedMoves.length - 1];
      if (prev && prev.direction === mv.direction) {
        const prevTs = new Date(prev.startTime).getTime();
        const currTs = new Date(mv.startTime).getTime();
        if (currTs - prevTs < 10 * 60_000) {
          if (mv.mfePct > prev.mfePct) dedupedMoves[dedupedMoves.length - 1] = mv;
          continue;
        }
      }
      dedupedMoves.push(mv);
    }

    // For each move, classify system awareness
    interface MoveAwareness {
      move: MarketMove;
      status: 'CAUGHT' | 'FILTER_BLOCKED' | 'LOW_CONFIDENCE' | 'WRONG_DIRECTION' | 'NO_SIGNAL' | 'WRONG_MODE';
      systemDirection: SignalDirection | null;
      systemConf: number | null;
      systemMode: string | null;
      filterRule?: string;
    }

    const awareness: MoveAwareness[] = [];

    for (const mv of dedupedMoves) {
      const mvTs = new Date(mv.startTime).getTime();

      // Find the system's tick at or just before this move
      // Use widening search: try +/- 2min first, then +/- 5min (covers early-day gaps
      // where streamCache < 20 bars or timeframes < 14 bars cause skipped ticks)
      let tick: typeof allTicks[0] | null = null;
      for (const window of [2 * 60_000, 5 * 60_000, 10 * 60_000]) {
        const matchingTicks = allTicks.filter(t => {
          const tTs = new Date(t.time).getTime();
          return Math.abs(tTs - mvTs) <= window;
        });
        if (matchingTicks.length > 0) {
          tick = matchingTicks.reduce((best, t) => Math.abs(new Date(t.time).getTime() - mvTs) < Math.abs(new Date(best.time).getTime() - mvTs) ? t : best);
          break;
        }
      }

      // Check if a confirmed entry covers this move.
      // An entry "catches" a move if it occurs between the move start and peak time
      // (i.e., the entry happened while the move was still running).
      // Also allow entries up to 5 min before the move start (early entry).
      const mvPeakTs = new Date(mv.peakTime).getTime();
      const caughtByEntry = confirmedEntries.some(e => {
        const eTs = new Date(e.time).getTime();
        return e.direction === mv.direction && eTs >= mvTs - 5 * 60_000 && eTs <= mvPeakTs;
      });

      if (caughtByEntry) {
        // Find the earliest matching entry to report delay
        const matchingEntry = confirmedEntries
          .filter(e => e.direction === mv.direction && new Date(e.time).getTime() >= mvTs - 5 * 60_000 && new Date(e.time).getTime() <= mvPeakTs)
          .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())[0];
        const entryDelay = matchingEntry ? Math.round((new Date(matchingEntry.time).getTime() - mvTs) / 60_000) : 0;
        awareness.push({
          move: mv, status: 'CAUGHT',
          systemDirection: tick?.direction ?? null,
          systemConf: matchingEntry?.confidence ?? tick?.confidence ?? null,
          systemMode: tick?.signalMode ?? null,
          filterRule: matchingEntry ? `entry@${utcToET(matchingEntry.time)} delay=${entryDelay}m` : undefined,
        });
        continue;
      }

      // Check if filter-blocked (signal existed during the move but was blocked by a filter)
      const filteredMatch = filterBlockedEntries.find(fb => {
        const fbTs = new Date(fb.time).getTime();
        return fb.direction === mv.direction && fbTs >= mvTs - 5 * 60_000 && fbTs <= mvPeakTs;
      });
      if (filteredMatch) {
        awareness.push({
          move: mv, status: 'FILTER_BLOCKED',
          systemDirection: tick?.direction ?? null,
          systemConf: tick?.confidence ?? null,
          systemMode: tick?.signalMode ?? null,
          filterRule: filteredMatch.filterRule,
        });
        continue;
      }

      // Check if blocked by confirmation gate (signal existed during move but gate blocked)
      const gateBlocked = blockedEntries.some(e => {
        const eTs = new Date(e.time).getTime();
        return e.direction === mv.direction && eTs >= mvTs - 5 * 60_000 && eTs <= mvPeakTs;
      });
      if (gateBlocked) {
        awareness.push({
          move: mv, status: 'FILTER_BLOCKED',
          systemDirection: tick?.direction ?? null,
          systemConf: tick?.confidence ?? null,
          systemMode: tick?.signalMode ?? null,
          filterRule: 'confirmation_gate',
        });
        continue;
      }

      if (!tick) {
        // No tick even within 10 min — truly no data (very early in session, cache warming)
        awareness.push({ move: mv, status: 'NO_SIGNAL', systemDirection: null, systemConf: null, systemMode: null });
        continue;
      }

      // System had a tick but didn't enter — classify why
      if (tick.direction === 'neutral') {
        awareness.push({ move: mv, status: 'NO_SIGNAL', systemDirection: 'neutral', systemConf: tick.confidence, systemMode: tick.signalMode });
      } else if (tick.direction !== mv.direction) {
        awareness.push({ move: mv, status: 'WRONG_DIRECTION', systemDirection: tick.direction, systemConf: tick.confidence, systemMode: tick.signalMode });
      } else if (tick.signalMode === 'none') {
        awareness.push({ move: mv, status: 'WRONG_MODE', systemDirection: tick.direction, systemConf: tick.confidence, systemMode: 'none' });
      } else {
        awareness.push({ move: mv, status: 'LOW_CONFIDENCE', systemDirection: tick.direction, systemConf: tick.confidence, systemMode: tick.signalMode });
      }
    }

    // Report
    const caught = awareness.filter(a => a.status === 'CAUGHT');
    const missed = awareness.filter(a => a.status !== 'CAUGHT');

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  MARKET MOVE SCANNER (auto-detected from price data)`);
    console.log(`${'─'.repeat(80)}`);
    console.log(`  Significant moves found: ${dedupedMoves.length} (MFE >= ${MIN_MFE_PCT}%, MFE/MAE > 1.2)`);
    console.log(`  System caught: ${caught.length} | Missed: ${missed.length}`);

    // Summary table of all moves with time ranges
    console.log(`\n  #   Time Range (ET)     Dir     Price Range             MFE    MAE    R       Status`);
    console.log(`  ${'─'.repeat(95)}`);
    for (let mi = 0; mi < awareness.length; mi++) {
      const a = awareness[mi]!;
      const mv = a.move;
      const dirIcon = mv.direction === 'bullish' ? '▲' : '▼';
      const mfeOverMae = mv.maePct > 0.01 ? (mv.mfePct / mv.maePct).toFixed(1) : '∞';
      let statusLabel = '';
      switch (a.status) {
        case 'CAUGHT': statusLabel = `✅ CAUGHT${a.filterRule ? ` (${a.filterRule})` : ''}`; break;
        case 'LOW_CONFIDENCE': statusLabel = `❌ low conf (${((a.systemConf ?? 0) * 100).toFixed(0)}%)`; break;
        case 'WRONG_DIRECTION': statusLabel = `❌ wrong dir`; break;
        case 'NO_SIGNAL': statusLabel = '❌ no signal'; break;
        case 'FILTER_BLOCKED': statusLabel = `❌ filter`; break;
        case 'WRONG_MODE': statusLabel = '❌ wrong mode'; break;
      }
      const num = String(mi + 1).padStart(2);
      const timeRange = `${mv.startTimeET}→${mv.peakTimeET}`.padEnd(18);
      const dir = `${dirIcon} ${mv.direction}`.padEnd(9);
      const priceRange = `$${mv.startPrice.toFixed(2)} → $${mv.peakPrice.toFixed(2)}`.padEnd(23);
      const mfe = `${mv.mfePct.toFixed(2)}%`.padStart(5);
      const mae = `${mv.maePct.toFixed(2)}%`.padStart(5);
      const ratio = String(mfeOverMae).padStart(5);
      console.log(`  ${num}  ${timeRange} ${dir} ${priceRange} ${mfe}  ${mae}  ${ratio}   ${statusLabel}`);
    }

    // Helper: find system ticks within a move's time range
    const getSystemTicksForMove = (mv: MarketMove) => {
      const startTs = new Date(mv.startTime).getTime();
      const peakTs = new Date(mv.peakTime).getTime();
      return allTicks.filter(t => {
        const tTs = new Date(t.time).getTime();
        return tTs >= startTs && tTs <= peakTs;
      });
    };

    const formatMoveTicks = (ticks: typeof allTicks, moveDir: string) => {
      if (ticks.length === 0) return '        System: no ticks in range';
      // Sample up to 6 ticks evenly spaced
      const sampled: typeof allTicks = [];
      if (ticks.length <= 6) {
        sampled.push(...ticks);
      } else {
        const step = (ticks.length - 1) / 5;
        for (let k = 0; k < 6; k++) sampled.push(ticks[Math.round(k * step)]!);
      }
      const lines = sampled.map(t => {
        const dirMatch = t.direction === moveDir ? '✓' : '✗';
        const confPct = (t.confidence * 100).toFixed(0);
        return `${t.timeET} ${t.direction} ${confPct}%${dirMatch}`;
      });
      return `        System: ${lines.join(' | ')}`;
    };

    if (missed.length > 0) {
      // Group by miss reason
      const byReason = new Map<string, MoveAwareness[]>();
      for (const m of missed) {
        const list = byReason.get(m.status) ?? [];
        list.push(m);
        byReason.set(m.status, list);
      }

      console.log(`\n  Miss breakdown:`);
      const reasonLabels: Record<string, string> = {
        NO_SIGNAL: 'Direction neutral / no signal generated',
        WRONG_DIRECTION: 'Signal pointed wrong direction',
        LOW_CONFIDENCE: 'Right direction, confidence too low',
        WRONG_MODE: 'Right direction, mode=none (no regime detected)',
        FILTER_BLOCKED: 'Right signal, blocked by filter/gate',
      };
      for (const [reason, items] of byReason) {
        console.log(`    ${reasonLabels[reason] ?? reason}: ${items.length}`);
      }

      console.log(`\n  Missed moves detail:`);
      for (const a of missed) {
        const mv = a.move;
        const dirIcon = mv.direction === 'bullish' ? '▲' : '▼';
        const mfeOverMae = mv.maePct > 0.01 ? (mv.mfePct / mv.maePct).toFixed(1) : '∞';
        let reason = '';
        switch (a.status) {
          case 'NO_SIGNAL':
            reason = a.systemDirection === 'neutral'
              ? `system was NEUTRAL (conf=${((a.systemConf ?? 0) * 100).toFixed(0)}%, mode=${a.systemMode})`
              : 'no tick — insufficient bars for indicators (cache gap)';
            break;
          case 'WRONG_DIRECTION':
            reason = `system said ${a.systemDirection?.toUpperCase()} (conf=${((a.systemConf ?? 0) * 100).toFixed(0)}%, mode=${a.systemMode})`;
            break;
          case 'LOW_CONFIDENCE':
            reason = `right dir, conf=${((a.systemConf ?? 0) * 100).toFixed(0)}% < threshold (mode=${a.systemMode})`;
            break;
          case 'WRONG_MODE':
            reason = `right dir (conf=${((a.systemConf ?? 0) * 100).toFixed(0)}%), but mode=none`;
            break;
          case 'FILTER_BLOCKED':
            reason = `filter: ${a.filterRule}`;
            break;
        }
        console.log(`    ⚠️  ${mv.startTimeET}→${mv.peakTimeET} ET ${dirIcon} ${mv.direction} $${mv.startPrice.toFixed(2)} → $${mv.peakPrice.toFixed(2)} MFE=${mv.mfePct.toFixed(2)}% MAE=${mv.maePct.toFixed(2)}% R=${mfeOverMae} peak@${mv.mfePeakMinutes}m`);
        console.log(`        WHY MISSED: ${reason}`);
        const moveTicks = getSystemTicksForMove(mv);
        console.log(formatMoveTicks(moveTicks, mv.direction));
      }
    }

    if (caught.length > 0) {
      console.log(`\n  Caught moves:`);
      for (const a of caught) {
        const mv = a.move;
        const dirIcon = mv.direction === 'bullish' ? '▲' : '▼';
        console.log(`    ✅ ${mv.startTimeET}→${mv.peakTimeET} ET ${dirIcon} ${mv.direction} $${mv.startPrice.toFixed(2)} → $${mv.peakPrice.toFixed(2)} MFE=${mv.mfePct.toFixed(2)}%`);
        const moveTicks = getSystemTicksForMove(mv);
        console.log(formatMoveTicks(moveTicks, mv.direction));
      }
    }

    const captureRate = dedupedMoves.length > 0 ? (caught.length / dedupedMoves.length * 100).toFixed(0) : 'N/A';
    console.log(`\n  Move capture rate: ${captureRate}%`);

    // ── Entry Delay Analysis ─────────────────────────────────────────────────
    // For each detected move, find when the system first generated a matching
    // signal (right direction + mode ≠ none + confidence ≥ threshold). Measures
    // detection lag and the price already given up before entry.
    {
      interface DelayRecord {
        move: MarketMove;
        status: 'CAUGHT' | 'CAUGHT_LATE' | 'MISSED';
        delayMinutes: number | null;       // minutes from move start to first matching signal
        entryCostPct: number | null;       // % price already moved by signal time
        remainingMfePct: number | null;    // MFE from signal time forward
        captureRatio: number | null;       // remainingMfe / fullMfe
        signalTime: string | null;
        signalTimeET: string | null;
        signalConf: number | null;
        signalMode: string | null;
      }

      const delayRecords: DelayRecord[] = [];

      for (const mv of dedupedMoves) {
        const mvStartTs = new Date(mv.startTime).getTime();
        const mvStartIdx = mv.startIdx;

        // Search allTicks from move start to move peak + 30min for first matching signal
        const searchEndTs = new Date(mv.peakTime).getTime() + 30 * 60_000;

        let firstMatchTick: typeof allTicks[0] | null = null;
        for (const t of allTicks) {
          const tTs = new Date(t.time).getTime();
          if (tTs < mvStartTs) continue;
          if (tTs > searchEndTs) break;
          if (t.direction === mv.direction && t.signalMode !== 'none' && t.confidence >= MIN_CONFIDENCE) {
            firstMatchTick = t;
            break;
          }
        }

        if (!firstMatchTick) {
          delayRecords.push({
            move: mv, status: 'MISSED', delayMinutes: null,
            entryCostPct: null, remainingMfePct: null, captureRatio: null,
            signalTime: null, signalTimeET: null, signalConf: null, signalMode: null,
          });
          continue;
        }

        const signalTs = new Date(firstMatchTick.time).getTime();
        const delayMin = Math.round((signalTs - mvStartTs) / 60_000);

        // Find the bar index closest to signal time to compute remaining MFE
        let signalBarIdx = mvStartIdx;
        for (let bi = mvStartIdx; bi < targetDateBars.length; bi++) {
          if (new Date(targetDateBars[bi]!.timestamp).getTime() >= signalTs) {
            signalBarIdx = bi;
            break;
          }
        }
        const signalPrice = targetDateBars[signalBarIdx]?.close ?? mv.startPrice;

        // Entry cost: how much price already moved from move start to signal
        const entryCostPct = Math.abs(signalPrice - mv.startPrice) / mv.startPrice * 100;

        // Remaining MFE: max favorable from signal bar forward (120 bars)
        let remainingMfe = 0;
        for (let j = signalBarIdx + 1; j < Math.min(signalBarIdx + 121, targetDateBars.length); j++) {
          const fb = targetDateBars[j]!;
          const fav = mv.direction === 'bullish'
            ? fb.high - signalPrice
            : signalPrice - fb.low;
          if (fav > remainingMfe) remainingMfe = fav;
        }
        const remainingMfePct = (remainingMfe / signalPrice) * 100;
        const captureRatio = mv.mfePct > 0.01 ? remainingMfePct / mv.mfePct : 0;

        delayRecords.push({
          move: mv,
          status: delayMin <= 3 ? 'CAUGHT' : 'CAUGHT_LATE',
          delayMinutes: delayMin,
          entryCostPct,
          remainingMfePct,
          captureRatio,
          signalTime: firstMatchTick.time,
          signalTimeET: firstMatchTick.timeET,
          signalConf: firstMatchTick.confidence,
          signalMode: firstMatchTick.signalMode,
        });
      }

      // Report
      const caughtDelay = delayRecords.filter(d => d.status !== 'MISSED');
      const missedDelay = delayRecords.filter(d => d.status === 'MISSED');
      const avgDelay = caughtDelay.length > 0 ? caughtDelay.reduce((s, d) => s + (d.delayMinutes ?? 0), 0) / caughtDelay.length : 0;
      const medianDelay = (() => {
        const sorted = caughtDelay.map(d => d.delayMinutes ?? 0).sort((a, b) => a - b);
        if (sorted.length === 0) return 0;
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      })();
      const avgCapture = caughtDelay.length > 0 ? caughtDelay.reduce((s, d) => s + (d.captureRatio ?? 0), 0) / caughtDelay.length : 0;
      const overHalfLost = caughtDelay.filter(d => (d.captureRatio ?? 0) < 0.50).length;

      console.log(`\n${'─'.repeat(80)}`);
      console.log(`  ENTRY DELAY ANALYSIS (detection lag from move start to first matching signal)`);
      console.log(`${'─'.repeat(80)}`);
      console.log(`  Moves: ${dedupedMoves.length} | Detected: ${caughtDelay.length} | Missed: ${missedDelay.length} | Avg delay: ${avgDelay.toFixed(1)}m | Median: ${medianDelay}m`);

      console.log(`\n  #   Move Start   Dir     Full MFE  Delay  Entry Cost  Remaining MFE  Capture  Signal`);
      console.log(`  ${'─'.repeat(95)}`);
      for (let di = 0; di < delayRecords.length; di++) {
        const d = delayRecords[di]!;
        const mv = d.move;
        const dirIcon = mv.direction === 'bullish' ? '▲' : '▼';
        const num = String(di + 1).padStart(2);
        const timeStr = mv.startTimeET.padEnd(8);
        const dir = `${dirIcon} ${mv.direction.slice(0, 4)}`.padEnd(8);
        const fullMfe = `${mv.mfePct.toFixed(2)}%`.padStart(6);

        if (d.status === 'MISSED') {
          console.log(`  ${num}  ${timeStr}   ${dir} ${fullMfe}     —      MISSED         —           0%   ❌`);
        } else {
          const delay = `${d.delayMinutes}m`.padStart(4);
          const cost = `${d.entryCostPct!.toFixed(2)}%`.padStart(6);
          const remaining = `${d.remainingMfePct!.toFixed(2)}%`.padStart(6);
          const capture = `${(d.captureRatio! * 100).toFixed(0)}%`.padStart(4);
          const warn = d.captureRatio! < 0.50 ? ' ⚠️' : d.captureRatio! >= 0.80 ? ' ✅' : '';
          const sig = `${d.signalTimeET} ${d.signalMode} ${((d.signalConf ?? 0) * 100).toFixed(0)}%`;
          console.log(`  ${num}  ${timeStr}   ${dir} ${fullMfe}   ${delay}    ${cost}        ${remaining}       ${capture}${warn}   ${sig}`);
        }
      }

      console.log(`\n  Summary:`);
      console.log(`    Avg capture ratio:                   ${(avgCapture * 100).toFixed(0)}% (detected moves only)`);
      console.log(`    Moves where delay cost >50% of MFE:  ${overHalfLost}/${dedupedMoves.length}`);
      console.log(`    Missed entirely:                     ${missedDelay.length}/${dedupedMoves.length}`);
      if (avgDelay > 10) {
        console.log(`    ⚠️  Avg delay ${avgDelay.toFixed(0)}m — a faster detection path (e.g., spike detector) could improve capture`);
      }

      // ── Miss Classification: Reasonable vs Tunable ──────────────────────────
      // Classify each non-caught move as either "reasonable" (no action needed)
      // or "tunable" (system should improve) with specific remediation hints.
      type MissClass =
        | 'CAUGHT'            // not a miss
        // Reasonable — system correctly avoided or cannot improve
        | 'FAST_REVERSAL'     // MFE/MAE < 2.0 or peak < 5 min — choppy, not tradeable
        | 'COUNTER_TREND'     // counter-move against a sustained system direction
        | 'NO_DATA'           // cache gap, insufficient bars
        // Tunable — system should improve here
        | 'NEAR_MISS'         // right dir + mode, confidence within 5% of threshold
        | 'FILTER_COST'       // blocked by filter on a good (A/B grade) move
        | 'DELAY_COST'        // detected but delay ate >50% of MFE
        | 'WRONG_DIR_LATE'    // system pointed wrong dir for a sustained high-R move
        | 'LOW_CONF_GOOD';    // right dir, conf far below threshold, but high MFE

      interface ClassifiedMove {
        move: MarketMove;
        delayRecord: typeof delayRecords[0];
        awarenessRecord: typeof awareness[0];
        classification: MissClass;
        actionHint: string;           // what to tune
        priority: 'HIGH' | 'MEDIUM' | 'LOW';  // impact priority
      }

      const classified: ClassifiedMove[] = [];

      for (let mi = 0; mi < awareness.length; mi++) {
        const aw = awareness[mi]!;
        const dr = delayRecords[mi]!;
        const mv = aw.move;
        const mfeOverMae = mv.maePct > 0.01 ? mv.mfePct / mv.maePct : 999;

        // Already caught
        if (aw.status === 'CAUGHT') {
          // Check if caught late (delay cost > 50%)
          if (dr.status === 'CAUGHT_LATE' && dr.captureRatio != null && dr.captureRatio < 0.50) {
            classified.push({
              move: mv, delayRecord: dr, awarenessRecord: aw,
              classification: 'DELAY_COST',
              actionHint: `Delay ${dr.delayMinutes}m ate ${(100 - dr.captureRatio * 100).toFixed(0)}% of MFE. Faster detection (spike detector, lower DMI lag) would help.`,
              priority: mv.mfePct >= 0.50 ? 'HIGH' : 'MEDIUM',
            });
          } else {
            classified.push({ move: mv, delayRecord: dr, awarenessRecord: aw, classification: 'CAUGHT', actionHint: '', priority: 'LOW' });
          }
          continue;
        }

        // ── Reasonable miss checks ──────────────────────────────────────────

        // Fast reversal / choppy move: low MFE/MAE ratio or very short peak time
        if (mfeOverMae < 2.0 || (mv.mfePeakMinutes <= 3 && mv.mfePct < 0.40)) {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'FAST_REVERSAL',
            actionHint: `R=${mfeOverMae.toFixed(1)}, peak@${mv.mfePeakMinutes}m — too choppy for clean entry.`,
            priority: 'LOW',
          });
          continue;
        }

        // No data / cache gap
        if (aw.status === 'NO_SIGNAL' && aw.systemDirection === null) {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'NO_DATA',
            actionHint: 'Cache gap — insufficient bars for indicator computation. Normal at session start.',
            priority: 'LOW',
          });
          continue;
        }

        // Counter-trend: system was consistently in opposite direction AND the move is
        // a short-lived counter-move (< 20 min peak) against a larger trend
        if (aw.status === 'WRONG_DIRECTION' && mv.mfePeakMinutes <= 20 && mv.mfePct < 0.50) {
          // Check if system direction was sustained (same direction for surrounding ticks)
          const moveTicks = getSystemTicksForMove(mv);
          const oppositeCount = moveTicks.filter(t => t.direction !== mv.direction && t.direction !== 'neutral').length;
          if (oppositeCount > moveTicks.length * 0.7) {
            classified.push({
              move: mv, delayRecord: dr, awarenessRecord: aw,
              classification: 'COUNTER_TREND',
              actionHint: `System held ${aw.systemDirection} (${oppositeCount}/${moveTicks.length} ticks) — this was a counter-move.`,
              priority: 'LOW',
            });
            continue;
          }
        }

        // ── Tunable miss checks ─────────────────────────────────────────────

        // Filter-blocked with good underlying move
        if (aw.status === 'FILTER_BLOCKED') {
          // Look up the grade for this move from filter-blocked entries
          const fbMatch = filterBlockedEntries.find(fb => {
            const fbTs = new Date(fb.time).getTime();
            return Math.abs(fbTs - new Date(mv.startTime).getTime()) <= 5 * 60_000 && fb.direction === mv.direction;
          }) ?? blockedEntries.find(e => {
            const eTs = new Date(e.time).getTime();
            return Math.abs(eTs - new Date(mv.startTime).getTime()) <= 5 * 60_000 && e.direction === mv.direction;
          });
          const grade = fbMatch?.entryGrade ?? '?';
          const isGoodGrade = grade === 'A' || grade === 'B';
          const rule = aw.filterRule ?? 'unknown';

          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'FILTER_COST',
            actionHint: isGoodGrade
              ? `Grade ${grade} move blocked by "${rule}". This filter cost a good entry — review rule.`
              : `Grade ${grade} move blocked by "${rule}". Filter may be correct here.`,
            priority: isGoodGrade && mv.mfePct >= 0.40 ? 'HIGH' : 'MEDIUM',
          });
          continue;
        }

        // Near-miss: right direction + mode but confidence just below threshold
        if ((aw.status === 'LOW_CONFIDENCE' || aw.status === 'WRONG_MODE') && aw.systemDirection === mv.direction) {
          const gap = MIN_CONFIDENCE - (aw.systemConf ?? 0);
          if (gap <= 0.05 && gap > 0) {
            classified.push({
              move: mv, delayRecord: dr, awarenessRecord: aw,
              classification: 'NEAR_MISS',
              actionHint: `Conf ${((aw.systemConf ?? 0) * 100).toFixed(0)}% — just ${(gap * 100).toFixed(1)}% below ${(MIN_CONFIDENCE * 100).toFixed(0)}%. ` +
                `Review confidence bonuses (DI spread, alignment, PA) for this pattern.`,
              priority: mv.mfePct >= 0.50 ? 'HIGH' : 'MEDIUM',
            });
            continue;
          }
        }

        // Wrong direction on a sustained, high-R move
        if (aw.status === 'WRONG_DIRECTION' && mv.mfePeakMinutes > 15 && mfeOverMae >= 3.0) {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'WRONG_DIR_LATE',
            actionHint: `System was ${aw.systemDirection?.toUpperCase()} while ${mv.direction} move ran ${mv.mfePeakMinutes}m (R=${mfeOverMae.toFixed(1)}). ` +
              `DMI lag or missing reversal detection.`,
            priority: mv.mfePct >= 0.60 ? 'HIGH' : 'MEDIUM',
          });
          continue;
        }

        // Right direction, but confidence too low on a good move
        if (aw.systemDirection === mv.direction && mv.mfePct >= 0.40) {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'LOW_CONF_GOOD',
            actionHint: `Right dir, conf=${((aw.systemConf ?? 0) * 100).toFixed(0)}% on ${mv.mfePct.toFixed(2)}% move. ` +
              `Indicators underweighted this pattern — check which bonuses were missing.`,
            priority: mv.mfePct >= 0.60 ? 'HIGH' : 'MEDIUM',
          });
          continue;
        }

        // Caught late (delay-based) for non-caught awareness statuses
        if (dr.status !== 'MISSED' && dr.captureRatio != null && dr.captureRatio < 0.50) {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'DELAY_COST',
            actionHint: `Delay ${dr.delayMinutes}m ate ${(100 - dr.captureRatio * 100).toFixed(0)}% of MFE.`,
            priority: mv.mfePct >= 0.50 ? 'HIGH' : 'MEDIUM',
          });
          continue;
        }

        // Default: classify based on awareness status
        if (aw.status === 'WRONG_DIRECTION') {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'COUNTER_TREND',
            actionHint: `System was ${aw.systemDirection?.toUpperCase()} — may be correct trend call.`,
            priority: 'LOW',
          });
        } else {
          classified.push({
            move: mv, delayRecord: dr, awarenessRecord: aw,
            classification: 'LOW_CONF_GOOD',
            actionHint: `Conf=${((aw.systemConf ?? 0) * 100).toFixed(0)}%, mode=${aw.systemMode}`,
            priority: 'LOW',
          });
        }
      }

      // Report
      const tunableClasses: MissClass[] = ['NEAR_MISS', 'FILTER_COST', 'DELAY_COST', 'WRONG_DIR_LATE', 'LOW_CONF_GOOD'];
      const reasonableClasses: MissClass[] = ['FAST_REVERSAL', 'COUNTER_TREND', 'NO_DATA'];
      const tunable = classified.filter(c => tunableClasses.includes(c.classification));
      const reasonable = classified.filter(c => reasonableClasses.includes(c.classification));
      const highPriority = tunable.filter(c => c.priority === 'HIGH');

      console.log(`\n${'─'.repeat(80)}`);
      console.log(`  MISS CLASSIFICATION (reasonable vs tunable)`);
      console.log(`${'─'.repeat(80)}`);
      console.log(`  Total moves: ${classified.length} | Caught: ${classified.filter(c => c.classification === 'CAUGHT').length} | Tunable: ${tunable.length} | Reasonable: ${reasonable.length}`);
      console.log(`  High priority tunable: ${highPriority.length}`);

      // Classification breakdown
      const classCounts = new Map<MissClass, number>();
      for (const c of classified) classCounts.set(c.classification, (classCounts.get(c.classification) ?? 0) + 1);
      console.log(`\n  Classification breakdown:`);
      const classLabels: Record<string, string> = {
        CAUGHT: '✅ Caught',
        FAST_REVERSAL: '✓  Fast reversal (choppy, not tradeable)',
        COUNTER_TREND: '✓  Counter-trend (system on right side of bigger move)',
        NO_DATA: '✓  No data (cache gap)',
        NEAR_MISS: '⚠️  Near-miss threshold (conf within 5% of threshold)',
        FILTER_COST: '⚠️  Filter blocked good move',
        DELAY_COST: '⚠️  Delay cost (>50% MFE lost to lag)',
        WRONG_DIR_LATE: '⚠️  Wrong direction on sustained move',
        LOW_CONF_GOOD: '⚠️  Low confidence on good move',
      };
      for (const [cls, count] of classCounts) {
        const totalMfe = classified.filter(c => c.classification === cls).reduce((s, c) => s + c.move.mfePct, 0);
        console.log(`    ${classLabels[cls] ?? cls}: ${count} (${totalMfe.toFixed(2)}% total MFE)`);
      }

      // Tunable detail
      if (tunable.length > 0) {
        console.log(`\n  Tunable misses detail (sorted by priority + MFE):`);
        const sorted = [...tunable].sort((a, b) => {
          const priOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          const priDiff = (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2);
          return priDiff !== 0 ? priDiff : b.move.mfePct - a.move.mfePct;
        });
        console.log(`  #   Time     Dir     MFE    R     Class                Priority  Action`);
        console.log(`  ${'─'.repeat(110)}`);
        for (let ti = 0; ti < sorted.length; ti++) {
          const c = sorted[ti]!;
          const mv = c.move;
          const dirIcon = mv.direction === 'bullish' ? '▲' : '▼';
          const mfeOverMae = mv.maePct > 0.01 ? (mv.mfePct / mv.maePct).toFixed(1) : '∞';
          const priIcon = c.priority === 'HIGH' ? '🔴' : c.priority === 'MEDIUM' ? '🟡' : '⚪';
          const classLabel = c.classification.replace(/_/g, ' ').toLowerCase();
          console.log(`  ${String(ti + 1).padStart(2)}  ${mv.startTimeET}  ${dirIcon} ${mv.direction.slice(0, 4).padEnd(5)} ${mv.mfePct.toFixed(2).padStart(5)}%  ${String(mfeOverMae).padStart(5)}  ${classLabel.padEnd(22)} ${priIcon} ${c.priority.padEnd(8)} ${c.actionHint}`);
        }
      }

      // Actionable summary
      const nearMissCount = tunable.filter(c => c.classification === 'NEAR_MISS').length;
      const filterCostCount = tunable.filter(c => c.classification === 'FILTER_COST').length;
      const filterCostGoodCount = tunable.filter(c => c.classification === 'FILTER_COST' && c.priority === 'HIGH').length;
      const delayCostCount = tunable.filter(c => c.classification === 'DELAY_COST').length;
      const wrongDirCount = tunable.filter(c => c.classification === 'WRONG_DIR_LATE').length;

      if (tunable.length > 0) {
        console.log(`\n  Actionable recommendations:`);
        if (nearMissCount > 0)      console.log(`    📊 Threshold: ${nearMissCount} near-miss(es) — lowering by 3-5% would capture these`);
        if (filterCostGoodCount > 0) console.log(`    🔧 Filters: ${filterCostGoodCount} good grade (A/B) moves blocked — review filter rules`);
        if (delayCostCount > 0)      console.log(`    ⏱️  Detection speed: ${delayCostCount} move(s) caught too late — spike detector or faster indicators needed`);
        if (wrongDirCount > 0)       console.log(`    🔄 Direction: ${wrongDirCount} sustained move(s) missed — DMI lag or reversal detection gap`);
      }

      // Store for JSON output
      (globalThis as any).__btDelayAnalysis = {
        totalMoves: dedupedMoves.length,
        detected: caughtDelay.length,
        missed: missedDelay.length,
        avgDelayMinutes: Math.round(avgDelay * 10) / 10,
        medianDelayMinutes: medianDelay,
        avgCaptureRatio: Math.round(avgCapture * 1000) / 1000,
        movesOverHalfLost: overHalfLost,
        moves: delayRecords.map(d => ({
          startTime: d.move.startTime, startTimeET: d.move.startTimeET,
          direction: d.move.direction, startPrice: d.move.startPrice,
          fullMfePct: d.move.mfePct,
          status: d.status,
          delayMinutes: d.delayMinutes,
          entryCostPct: d.entryCostPct != null ? Math.round(d.entryCostPct * 1000) / 1000 : null,
          remainingMfePct: d.remainingMfePct != null ? Math.round(d.remainingMfePct * 1000) / 1000 : null,
          captureRatio: d.captureRatio != null ? Math.round(d.captureRatio * 1000) / 1000 : null,
          signalTime: d.signalTime, signalTimeET: d.signalTimeET,
          signalConf: d.signalConf, signalMode: d.signalMode,
        })),
        classification: {
          tunable: tunable.length,
          reasonable: reasonable.length,
          highPriority: highPriority.length,
          breakdown: Object.fromEntries(classCounts),
          tunableMoves: tunable.map(c => ({
            startTime: c.move.startTime, startTimeET: c.move.startTimeET,
            direction: c.move.direction, mfePct: c.move.mfePct,
            classification: c.classification,
            priority: c.priority,
            actionHint: c.actionHint,
          })),
        },
      };
    }

    // ── Suppression & Threshold Analysis ──────────────────────────────────────
    // For each missed move, find the system's best opportunity within the move range
    // and analyze what suppressed it (threshold, gates, filters, wrong direction)
    {
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`  SUPPRESSION & THRESHOLD ANALYSIS`);
      console.log(`${'─'.repeat(80)}`);

      // 1) Threshold sensitivity: how many moves would be caught at each threshold level
      const thresholds = [0.70, 0.65, 0.60, 0.55, 0.50, 0.45, 0.40, 0.30, 0.20];
      console.log(`\n  Threshold sensitivity (right-direction moves only):`);
      console.log(`  Threshold   Catchable   Of Total    Avg MFE of caught    Moves`);
      console.log(`  ${'─'.repeat(75)}`);

      // For each move where system had right direction at some point, find max conf
      const rightDirMoves = awareness.map(a => {
        const ticks = getSystemTicksForMove(a.move);
        const rightDirTicks = ticks.filter(t => t.direction === a.move.direction);
        const maxConf = rightDirTicks.length > 0 ? Math.max(...rightDirTicks.map(t => t.confidence)) : 0;
        const maxConfTick = rightDirTicks.find(t => t.confidence === maxConf);
        return { ...a, maxConf, maxConfTick, rightDirTicks };
      });

      for (const th of thresholds) {
        const catchable = rightDirMoves.filter(m => m.maxConf >= th);
        const avgMfe = catchable.length > 0 ? catchable.reduce((s, m) => s + m.move.mfePct, 0) / catchable.length : 0;
        const marker = th === MIN_CONFIDENCE ? ' ◄ CURRENT' : '';
        const moveNums = catchable.map(m => {
          const idx = rightDirMoves.indexOf(m);
          return `#${idx + 1}`;
        }).join(', ');
        console.log(`  ${(th * 100).toFixed(0)}%         ${String(catchable.length).padStart(2)}/${dedupedMoves.length}        ${(catchable.length / dedupedMoves.length * 100).toFixed(0).padStart(3)}%       ${avgMfe.toFixed(2)}%               ${moveNums}${marker}`);
      }

      // 2) Gate & filter cost/benefit for moves where system had right direction
      console.log(`\n  Per-move suppression detail (right direction only):`);
      console.log(`  #   Time Range          MaxConf  Needed   Gap     Suppressor                         MFE    Grade`);
      console.log(`  ${'─'.repeat(100)}`);

      for (let mi = 0; mi < awareness.length; mi++) {
        const a = awareness[mi]!;
        const rdm = rightDirMoves[mi]!;
        const mv = a.move;

        // Skip wrong-direction and caught moves for this section
        if (a.status === 'CAUGHT') {
          const confPct = (rdm.maxConf * 100).toFixed(0);
          console.log(`  ${String(mi + 1).padStart(2)}  ${mv.startTimeET}→${mv.peakTimeET}    ${confPct.padStart(3)}%     ---      ---     ✅ CAUGHT                              ${mv.mfePct.toFixed(2)}%  ${mv.direction}`);
          continue;
        }
        if (a.status === 'WRONG_DIRECTION' && rdm.maxConf === 0) {
          console.log(`  ${String(mi + 1).padStart(2)}  ${mv.startTimeET}→${mv.peakTimeET}      0%     ---      ---     ❌ Wrong direction entire range         ${mv.mfePct.toFixed(2)}%  ${mv.direction}`);
          continue;
        }
        if (a.status === 'NO_SIGNAL' && rdm.rightDirTicks.length === 0) {
          console.log(`  ${String(mi + 1).padStart(2)}  ${mv.startTimeET}→${mv.peakTimeET}      -%     ---      ---     ❌ No signal / cache gap                ${mv.mfePct.toFixed(2)}%  ${mv.direction}`);
          continue;
        }

        const maxConfPct = (rdm.maxConf * 100).toFixed(0);
        const threshPct = (MIN_CONFIDENCE * 100).toFixed(0);
        const gap = rdm.maxConf >= MIN_CONFIDENCE ? 'PASS' : `${((MIN_CONFIDENCE - rdm.maxConf) * 100).toFixed(0)}%`;

        // Determine primary suppressor
        let suppressor = '';
        if (a.status === 'FILTER_BLOCKED') {
          suppressor = `Filter: ${a.filterRule ?? 'unknown'}`;
        } else if (a.status === 'WRONG_DIRECTION') {
          // Had right dir ticks but initial tick was wrong
          suppressor = `Wrong dir at start, right later (max ${maxConfPct}%)`;
        } else if (rdm.maxConf >= MIN_CONFIDENCE) {
          // Had enough confidence at some point — blocked by gate or filter
          const filterMatch = filterBlockedEntries.find(fb => {
            const fbTs = new Date(fb.time).getTime();
            const mvStart = new Date(mv.startTime).getTime();
            const mvPeak = new Date(mv.peakTime).getTime();
            return fbTs >= mvStart && fbTs <= mvPeak && fb.direction === mv.direction;
          });
          const gateMatch = blockedEntries.find(e => {
            const eTs = new Date(e.time).getTime();
            const mvStart = new Date(mv.startTime).getTime();
            const mvPeak = new Date(mv.peakTime).getTime();
            return eTs >= mvStart && eTs <= mvPeak && e.direction === mv.direction;
          });
          if (filterMatch) {
            suppressor = `Filter: ${filterMatch.filterRule}`;
          } else if (gateMatch) {
            suppressor = `Gate: ${gateMatch.gateResult}`;
          } else {
            suppressor = `Conf ≥${threshPct}% but no entry tick aligned`;
          }
        } else {
          // Confidence too low — identify how far off and likely hard gate
          const shortfall = MIN_CONFIDENCE - rdm.maxConf;
          if (shortfall <= 0.05) {
            suppressor = `Near-miss: ${maxConfPct}% (${gap} short of ${threshPct}%)`;
          } else if (shortfall <= 0.15) {
            suppressor = `Moderate gap: ${maxConfPct}% (${gap} short)`;
          } else {
            suppressor = `Large gap: ${maxConfPct}% (${gap} short)`;
          }
          // Check if a hard gate likely capped it
          if (rdm.maxConf > 0.50 && rdm.maxConf < MIN_CONFIDENCE) {
            suppressor += ' — likely hard-gate capped';
          }
        }

        // Find grade for the best tick
        const gradeForMove = (() => {
          // Check if any filter-blocked entry covers this move and has a grade
          const fb = filterBlockedEntries.find(f => {
            const fTs = new Date(f.time).getTime();
            return fTs >= new Date(mv.startTime).getTime() && fTs <= new Date(mv.peakTime).getTime() && f.direction === mv.direction;
          });
          if (fb) return fb.entryGrade;
          // Check blocked entries
          const be = blockedEntries.find(e => {
            const eTs = new Date(e.time).getTime();
            return eTs >= new Date(mv.startTime).getTime() && eTs <= new Date(mv.peakTime).getTime() && e.direction === mv.direction;
          });
          if (be) return be.entryGrade;
          return '?';
        })();

        console.log(`  ${String(mi + 1).padStart(2)}  ${mv.startTimeET}→${mv.peakTimeET}    ${maxConfPct.padStart(3)}%     ${threshPct}%      ${gap.padStart(5)}   ${suppressor.padEnd(38)} ${mv.mfePct.toFixed(2)}%  ${gradeForMove}`);
      }

      // 3) Summary: opportunity cost
      const rightDirLowConf = rightDirMoves.filter(m => m.status === 'LOW_CONFIDENCE' || (m.status === 'FILTER_BLOCKED'));
      const nearMisses = rightDirLowConf.filter(m => m.maxConf >= MIN_CONFIDENCE - 0.05);
      const totalMissedMfe = rightDirLowConf.reduce((s, m) => s + m.move.mfePct, 0);
      const filterBlocked = rightDirMoves.filter(m => m.status === 'FILTER_BLOCKED');

      console.log(`\n  Summary:`);
      console.log(`    Right direction, suppressed:  ${rightDirLowConf.length} moves (total MFE: ${totalMissedMfe.toFixed(2)}%)`);
      console.log(`    Near-misses (within 5%):      ${nearMisses.length} moves (max conf ${nearMisses.map(m => (m.maxConf * 100).toFixed(0) + '%').join(', ') || 'none'})`);
      console.log(`    Filter-blocked:               ${filterBlocked.length} moves`);
      console.log(`    Wrong direction:              ${rightDirMoves.filter(m => m.status === 'WRONG_DIRECTION' && m.maxConf === 0).length} moves (no optimization path)`);

      // 4) Recommendation
      if (nearMisses.length > 0) {
        const nearMissMfe = nearMisses.reduce((s, m) => s + m.move.mfePct, 0);
        console.log(`\n    💡 Lowering threshold by 5% (${(MIN_CONFIDENCE * 100).toFixed(0)}%→${((MIN_CONFIDENCE - 0.05) * 100).toFixed(0)}%) would catch ${nearMisses.length} more moves (${nearMissMfe.toFixed(2)}% total MFE)`);
      }
      if (filterBlocked.length > 0) {
        const fbMfe = filterBlocked.reduce((s, m) => s + m.move.mfePct, 0);
        console.log(`    💡 Relaxing filters would catch ${filterBlocked.length} more moves (${fbMfe.toFixed(2)}% total MFE)`);
      }
    }

    // Add to JSON output
    if (JSON_OUTPUT) {
      // Will be merged into jsonSummary below
      (globalThis as any).__btMoveScanner = {
        totalMoves: dedupedMoves.length,
        caught: caught.length,
        missed: missed.length,
        captureRate: dedupedMoves.length > 0 ? caught.length / dedupedMoves.length : null,
        missedMoves: missed.map(a => ({
          time: a.move.startTime, timeET: a.move.startTimeET,
          direction: a.move.direction, startPrice: a.move.startPrice,
          mfePct: a.move.mfePct, maePct: a.move.maePct, mfePeakMinutes: a.move.mfePeakMinutes,
          missReason: a.status, systemDirection: a.systemDirection,
          systemConf: a.systemConf, systemMode: a.systemMode,
          filterRule: a.filterRule,
        })),
      };
    }
  }

  // ── JSON output for machine-readable aggregation (backtest-audit.ts) ──
  if (JSON_OUTPUT) {
    // Deduplicate filter-blocked entries (same logic as console report)
    const dedupedFiltered: FilterBlockedEntry[] = [];
    for (const fb of filterBlockedEntries) {
      const prev = dedupedFiltered[dedupedFiltered.length - 1];
      if (prev && prev.direction === fb.direction) {
        const prevTs = new Date(prev.time).getTime();
        const currTs = new Date(fb.time).getTime();
        if (currTs - prevTs < 5 * 60_000) {
          const gradeRank: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };
          if ((gradeRank[fb.entryGrade] ?? 0) > (gradeRank[prev.entryGrade] ?? 0) || ((gradeRank[fb.entryGrade] ?? 0) === (gradeRank[prev.entryGrade] ?? 0) && fb.confidence > prev.confidence)) {
            dedupedFiltered[dedupedFiltered.length - 1] = fb;
          }
          continue;
        }
      }
      dedupedFiltered.push(fb);
    }

    const jsonSummary = {
      date: TARGET_DATE,
      ticker: TICKER,
      confirmed: confirmedEntries.map(e => ({
        time: e.time, timeET: e.timeET, direction: e.direction, alignment: e.alignment,
        mode: e.signalMode, confidence: e.confidence, price: e.price, strength: e.strengthScore,
        grade: e.entryGrade, outcome: e.outcome, gate: e.gateResult,
        mfePct: e.mfePct, maePct: e.maePct, mfeOverMae: e.mfeOverMae, mfePeakMinutes: e.mfePeakMinutes,
        move5m: e.move5mPct, move10m: e.move10mPct, move15m: e.move15mPct, move30m: e.move30mPct,
        dirCorrect: e.directionCorrect, atr: e.atr,
        sim: { pnlPct: e.sim.pnlPct, exitReason: e.sim.exitReason, holdMin: e.sim.holdMinutes, peakPnl: e.sim.peakPnlPct },
        breakdown: e.breakdown,
      })),
      blocked: blockedEntries.map(e => ({
        time: e.time, timeET: e.timeET, direction: e.direction, alignment: e.alignment,
        mode: e.signalMode, confidence: e.confidence, price: e.price,
        grade: e.entryGrade, outcome: e.outcome, gate: e.gateResult,
        mfePct: e.mfePct, maePct: e.maePct, mfeOverMae: e.mfeOverMae, mfePeakMinutes: e.mfePeakMinutes,
        move5m: e.move5mPct, move10m: e.move10mPct, move15m: e.move15mPct, move30m: e.move30mPct,
        dirCorrect: e.directionCorrect,
      })),
      filtered: dedupedFiltered.map(fb => ({
        time: fb.time, timeET: fb.timeET, direction: fb.direction, mode: fb.signalMode,
        confidence: fb.confidence, price: fb.price,
        grade: fb.entryGrade, outcome: fb.outcome,
        filterRule: fb.filterRule, filterCategory: fb.filterCategory,
        mfePct: fb.mfePct, maePct: fb.maePct, mfeOverMae: fb.mfeOverMae, mfePeakMinutes: fb.mfePeakMinutes,
      })),
    };
    // Merge move scanner data if available
    const moveScanner = (globalThis as any).__btMoveScanner;
    if (moveScanner) {
      (jsonSummary as any).moveScanner = moveScanner;
      delete (globalThis as any).__btMoveScanner;
    }
    // Merge delay analysis data if available
    const delayAnalysis = (globalThis as any).__btDelayAnalysis;
    if (delayAnalysis) {
      (jsonSummary as any).delayAnalysis = delayAnalysis;
      delete (globalThis as any).__btDelayAnalysis;
    }
    console.log(`\n__JSON_START__${JSON.stringify(jsonSummary)}__JSON_END__`);
  }

  // ── HTML Visualizer Output ──
  if (HTML_OUTPUT) {
    const visEntries: VisEntry[] = confirmedEntries.map((e, i) => ({
      index: i + 1,
      time: e.time,
      timeET: e.timeET,
      direction: e.direction,
      price: e.price,
      confidence: e.confidence,
      entryGrade: e.entryGrade,
      signalMode: e.signalMode,
      sim: e.sim,
    }));
    const visBars: VisBar[] = targetDateBars.map(b => ({
      time: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const htmlPath = `backtest-${TICKER.toLowerCase()}-${TARGET_DATE}.html`;
    writeVisualizerHTML({ ticker: TICKER, date: TARGET_DATE, bars: visBars, entries: visEntries }, htmlPath);
    console.log(`\n  HTML visualizer written to: ${htmlPath}`);
  }
}

main()
  .then(() => { _saveCache(); })
  .catch(err => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
