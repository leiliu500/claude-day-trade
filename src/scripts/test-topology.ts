#!/usr/bin/env npx tsx
/**
 * test-topology.ts — Self-contained test of the topology engine.
 *
 * Fetches SPY 1m bars for April 14 2026 directly from Alpaca REST,
 * then runs every topology module independently.  No dependency on
 * existing agents, signal pipeline, or backtest infrastructure.
 *
 * Usage:  npx tsx src/scripts/test-topology.ts
 */

import 'dotenv/config';
import {
  computePersistentHomology,
  superLevelPersistence,
  bottleneckDistance,
} from '../topology/persistent-homology.js';
import { takensEmbedding, computePriceTopology } from '../topology/price-topology.js';
import { computeChainTopology } from '../topology/chain-topology.js';
import { computeIVTopology } from '../topology/iv-topology.js';
import { computeTopologyEntry, computeTopologyExit, formatEntrySignal } from '../topology/entry-model.js';
import { simulateChain, resetSessionOI } from '../topology/chain-simulator.js';
import { simulateOrderAgentSpy } from '../lib/order-agent-sim-spy.js';
import type { OHLCVBar } from '../types/market.js';
import type { OHLCVBar as SimOHLCVBar } from '../lib/order-agent-sim.js';
import type { ChainContract, PriceTopology, TopologySignal } from '../topology/types.js';

// ── Alpaca fetch (inline, no shared helpers) ─────────────────────────────────

const TARGET_DATE = process.argv[2] || '2026-04-14';
const TICKER = process.argv[3] || 'SPY';

const API_KEY = process.env.ALPACA_API_KEY!;
const SECRET  = process.env.ALPACA_SECRET_KEY!;
const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

async function fetchBars(
  ticker: string, start: string, end: string,
): Promise<OHLCVBar[]> {
  const out: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const u = new URL(`${DATA_URL}/v2/stocks/${ticker}/bars`);
    u.searchParams.set('timeframe', '1Min');
    u.searchParams.set('start', start);
    u.searchParams.set('end', end);
    u.searchParams.set('limit', '10000');
    u.searchParams.set('adjustment', 'raw');
    u.searchParams.set('feed', 'sip');
    if (pageToken) u.searchParams.set('page_token', pageToken);
    const r = await fetch(u.toString(), {
      headers: { 'APCA-API-KEY-ID': API_KEY, 'APCA-API-SECRET-KEY': SECRET },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`);
    const d = (await r.json()) as any;
    for (const b of d.bars ?? []) {
      out.push({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw });
    }
    if (d.next_page_token) pageToken = d.next_page_token; else break;
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeET(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  });
}

function aggregate5m(bars: OHLCVBar[], upTo: number): OHLCVBar[] {
  const bucketMs = 5 * 60_000;
  const cur = Math.floor(upTo / bucketMs) * bucketMs;
  const groups = new Map<number, OHLCVBar[]>();
  for (const b of bars) {
    const ts = new Date(b.timestamp).getTime();
    if (ts > upTo) continue;
    const bk = Math.floor(ts / bucketMs) * bucketMs;
    if (bk >= cur) continue;
    let g = groups.get(bk);
    if (!g) { g = []; groups.set(bk, g); }
    g.push(b);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([bk, bs]) => ({
      timestamp: new Date(bk).toISOString(),
      open: bs[0]!.open,
      high: Math.max(...bs.map(b => b.high)),
      low: Math.min(...bs.map(b => b.low)),
      close: bs[bs.length - 1]!.close,
      volume: bs.reduce((s, b) => s + b.volume, 0),
    }));
}

function hbar(val: number, max: number, w = 25): string {
  const n = Math.round((val / Math.max(max, 1e-9)) * w);
  return '█'.repeat(Math.min(n, w)) + '░'.repeat(Math.max(0, w - n));
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  TOPOLOGY ENGINE TEST — ${TICKER} ${TARGET_DATE}`);
  console.log(`${'═'.repeat(62)}\n`);

  // Fetch bars: 3 warmup days + target
  const warmupStart = new Date(TARGET_DATE);
  warmupStart.setDate(warmupStart.getDate() - 4);
  const bars1m = await fetchBars(TICKER, warmupStart.toISOString(), `${TARGET_DATE}T23:59:59Z`);
  const target = bars1m.filter(b => b.timestamp.startsWith(TARGET_DATE));
  console.log(`  Fetched ${bars1m.length} total 1m bars, ${target.length} on target date`);
  if (target.length === 0) { console.error('  No bars on target date'); process.exit(1); }

  const dayOpen = target[0]!.open;
  const dayClose = target[target.length - 1]!.close;
  const dayHigh = Math.max(...target.map(b => b.high));
  const dayLow  = Math.min(...target.map(b => b.low));
  console.log(`  O=$${dayOpen}  H=$${dayHigh}  L=$${dayLow}  C=$${dayClose}  Range=$${(dayHigh - dayLow).toFixed(2)}\n`);

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 1 — Raw persistent homology on Takens-embedded close prices
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`${'─'.repeat(62)}`);
  console.log(`  TEST 1: Persistent Homology on Takens Point Cloud`);
  console.log(`${'─'.repeat(62)}`);

  const closes = bars1m.map(b => b.close);
  const cloud = takensEmbedding(closes, 3, 2);

  // normalize
  const mu = [0, 0, 0], sig = [0, 0, 0];
  for (const p of cloud) for (let i = 0; i < 3; i++) mu[i] += p[i]!;
  for (let i = 0; i < 3; i++) mu[i] /= cloud.length;
  for (const p of cloud) for (let i = 0; i < 3; i++) sig[i] += (p[i]! - mu[i]!) ** 2;
  for (let i = 0; i < 3; i++) sig[i] = Math.sqrt(sig[i]! / cloud.length) || 1;
  const norm = cloud.map(p => p.map((v, i) => (v - mu[i]!) / sig[i]!));

  // farthest-point subsample to 60
  const N = 60;
  const sel = [0];
  const md = new Array(norm.length).fill(Infinity);
  for (let k = 1; k < Math.min(N, norm.length); k++) {
    const last = sel[sel.length - 1]!;
    for (let i = 0; i < norm.length; i++) {
      let d = 0;
      for (let j = 0; j < 3; j++) d += (norm[i]![j]! - norm[last]![j]!) ** 2;
      d = Math.sqrt(d);
      if (d < md[i]!) md[i] = d;
    }
    let bi = 0, bd = -1;
    for (let i = 0; i < norm.length; i++) { if (!sel.includes(i) && md[i]! > bd) { bd = md[i]!; bi = i; } }
    sel.push(bi);
  }
  const pts = sel.map(i => norm[i]!);

  console.log(`  ${closes.length} closes → ${cloud.length} embedded → ${pts.length} subsampled`);

  const t0 = performance.now();
  const diag = computePersistentHomology(pts, 1);
  console.log(`  Computed in ${(performance.now() - t0).toFixed(0)}ms`);

  const h0 = diag.pairs.filter(p => p.dimension === 0 && isFinite(p.persistence)).sort((a, b) => b.persistence - a.persistence);
  const h1 = diag.pairs.filter(p => p.dimension === 1 && isFinite(p.persistence)).sort((a, b) => b.persistence - a.persistence);

  console.log(`\n  β₀=${diag.betti[0]}  β₁=${diag.betti[1]}  essential=[${diag.essentialCount}]`);
  console.log(`  Total persistence: ${diag.totalPersistence.toFixed(4)}  Max: ${diag.maxPersistence.toFixed(4)}`);

  console.log(`\n  H0 (${h0.length} pairs) — component merges:`);
  const mH0 = h0[0]?.persistence ?? 1;
  for (const p of h0.slice(0, 6))
    console.log(`    b=${p.birth.toFixed(3)} d=${p.death.toFixed(3)}  ${hbar(p.persistence, mH0)} ${p.persistence.toFixed(4)}`);

  console.log(`\n  H1 (${h1.length} pairs) — loops/cycles:`);
  const mH1 = h1[0]?.persistence ?? 1;
  for (const p of h1.slice(0, 6))
    console.log(`    b=${p.birth.toFixed(3)} d=${p.death.toFixed(3)}  ${hbar(p.persistence, mH1)} ${p.persistence.toFixed(4)}`);

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 2 — Price topology evolution through the day (15-min steps)
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 2: Price Topology Evolution (15-min steps)`);
  console.log(`${'─'.repeat(62)}`);

  const firstTs = new Date(target[0]!.timestamp).getTime();
  const lastTs  = new Date(target[target.length - 1]!.timestamp).getTime();
  const snaps: { time: string; price: number; t: PriceTopology }[] = [];

  for (let ts = firstTs + 30 * 60_000; ts <= lastTs; ts += 15 * 60_000) {
    const window = bars1m.filter(b => new Date(b.timestamp).getTime() <= ts).slice(-200);
    if (window.length < 50) continue;
    const price = window[window.length - 1]!.close;
    const t = computePriceTopology(window, TICKER);
    snaps.push({ time: timeET(new Date(ts).toISOString()), price, t });
  }

  console.log(`\n  Time    Price    Regime          Stab  Cyclic   Dim   β₀ β₁  Bottleneck`);
  console.log(`  ${'─'.repeat(78)}`);
  for (const s of snaps) {
    const { regime, regimeStability, cyclicalStrength, effectiveDimension, bottleneckDistance: bn } = s.t;
    const [b0, b1] = s.t.diagram.betti;
    console.log(
      `  ${s.time}  $${s.price.toFixed(2).padStart(7)}  ${regime.padEnd(14)}  ${regimeStability.toFixed(2)}  ${cyclicalStrength.toFixed(3).padStart(6)}  ${effectiveDimension.toFixed(1).padStart(4)}  ${String(b0).padStart(2)} ${String(b1).padStart(2)}  ${bn.toFixed(4).padStart(10)}`
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 3 — Super-level persistence on intraday volume profile
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 3: Volume Profile Super-level Persistence`);
  console.log(`${'─'.repeat(62)}`);

  const bk = 0.50;
  const vp = new Map<number, number>();
  for (const b of target) {
    const k = Math.round(((b.high + b.low + b.close) / 3) / bk) * bk;
    vp.set(k, (vp.get(k) ?? 0) + b.volume);
  }
  const vpArr = Array.from(vp.entries()).sort(([a], [b]) => a - b).map(([p, v]) => ({ position: p, value: v }));
  const vpPairs = superLevelPersistence(vpArr);
  const sigPeaks = vpPairs.filter(p => p.persistence > 0);

  console.log(`\n  ${vpArr.length} price buckets ($${bk}), ${sigPeaks.length} peaks detected`);
  console.log(`\n  Top volume nodes (high-volume = support/resistance):`);
  const mVP = sigPeaks[0]?.persistence ?? 1;
  for (const p of sigPeaks.slice(0, 10)) {
    const match = vpArr.find(e => Math.abs(e.value - p.birth) < 1);
    const lvl = match ? `$${match.position.toFixed(2)}` : '?';
    console.log(`    ${lvl.padEnd(9)} vol=${p.birth.toFixed(0).padStart(10)}  ${hbar(p.persistence, mVP)} ${p.persistence.toFixed(0)}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 4 — 5-min topology
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 4: 5-min Bar Topology`);
  console.log(`${'─'.repeat(62)}`);

  const b5 = aggregate5m(bars1m, lastTs + 60_000);
  console.log(`\n  ${b5.length} 5-min bars`);
  if (b5.length >= 30) {
    const t5 = computePriceTopology(b5, 'SPY_5m', 3, 1);
    console.log(`  Regime: ${t5.regime}   Stability: ${t5.regimeStability.toFixed(3)}`);
    console.log(`  Cyclical: ${t5.cyclicalStrength.toFixed(3)}   Dim: ${t5.effectiveDimension.toFixed(2)}`);
    console.log(`  β₀=${t5.diagram.betti[0]}  β₁=${t5.diagram.betti[1]}`);
    const h1_5 = t5.diagram.pairs.filter(p => p.dimension === 1 && isFinite(p.persistence)).sort((a, b) => b.persistence - a.persistence);
    if (h1_5.length > 0) {
      console.log(`  Top H1 cycles:`);
      for (const p of h1_5.slice(0, 5))
        console.log(`    b=${p.birth.toFixed(3)} d=${p.death.toFixed(3)} persist=${p.persistence.toFixed(3)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 5 — Regime transitions (bottleneck spikes)
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 5: Regime Transitions`);
  console.log(`${'─'.repeat(62)}`);

  const trans = snaps.filter(s => s.t.bottleneckDistance > 0.1);
  if (trans.length === 0) {
    console.log(`\n  No significant transitions (bottleneck > 0.1). Stable attractor all day.`);
  } else {
    console.log(`\n  ${trans.length} transition(s):`);
    for (const s of trans)
      console.log(`    ${s.time} ET  $${s.price.toFixed(2)}  bn=${s.t.bottleneckDistance.toFixed(4)}  regime=${s.t.regime}`);
  }
  const maxBn = snaps.reduce((m, s) => s.t.bottleneckDistance > m.v ? { v: s.t.bottleneckDistance, s } : m, { v: 0, s: snaps[0]! });
  console.log(`  Largest structural change: ${maxBn.s.time} ET  bn=${maxBn.v.toFixed(4)}`);

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 6 — Chain + IV topology with synthetic data
  //           (no live option chain on historical date, so we simulate)
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 6: Chain + IV Topology (synthetic chain around day close)`);
  console.log(`${'─'.repeat(62)}`);

  const atm = Math.round(dayClose);
  const synCalls: ChainContract[] = [];
  const synPuts:  ChainContract[] = [];
  for (let k = atm - 15; k <= atm + 15; k++) {
    const dist = Math.abs(k - atm);
    // Simulate realistic-ish volume: ATM peak + random, plus a "sweep" cluster
    const baseVol = Math.max(0, Math.round(2000 * Math.exp(-dist * 0.15) + Math.random() * 200));
    const sweepBoost = (k >= atm + 5 && k <= atm + 8) ? 3000 : 0; // call sweep $5-$8 OTM
    const putBlock   = (k === atm - 3) ? 5000 : 0;                // put block $3 OTM
    const callVol = baseVol + sweepBoost;
    const putVol  = baseVol + putBlock;
    // IV smile: ATM vol ~0.25, wings higher, plus anomaly at sweep strike
    const baseIV = 0.25 + 0.0003 * dist * dist + (k < atm ? 0.002 * (atm - k) : 0);
    const callIV = baseIV + (sweepBoost > 0 ? 0.04 : 0); // IV elevated at sweep
    const putIV  = baseIV + (putBlock > 0 ? 0.06 : 0);
    const delta = k >= atm ? Math.max(0.05, 0.5 - dist * 0.04) : Math.min(-0.05, -0.5 + dist * 0.04);

    synCalls.push({
      strike: k, expiration: '2026-04-15', side: 'call',
      volume: callVol, openInterest: Math.round(callVol * 3 + Math.random() * 1000),
      iv: callIV, delta: Math.abs(delta), gamma: 0.02, bid: 1.5, ask: 1.7, mid: 1.6,
    });
    synPuts.push({
      strike: k, expiration: '2026-04-15', side: 'put',
      volume: putVol, openInterest: Math.round(putVol * 3 + Math.random() * 1000),
      iv: putIV, delta: -Math.abs(delta), gamma: 0.02, bid: 1.4, ask: 1.6, mid: 1.5,
    });
  }

  // Chain topology
  const chain = computeChainTopology(synCalls, synPuts, dayClose);
  console.log(`\n  Call clusters (β₀=${chain.callBeta0}):`);
  for (const c of chain.callClusters)
    console.log(`    $${c.strikes[0]}–$${c.strikes[c.strikes.length - 1]}  vol=${c.totalVolume}  persist=${c.persistence.toFixed(0)}  ecc=${c.eccentricity.toFixed(2)}  centroid=$${c.centroid.toFixed(1)}`);
  console.log(`  Put clusters (β₀=${chain.putBeta0}):`);
  for (const c of chain.putClusters)
    console.log(`    $${c.strikes[0]}–$${c.strikes[c.strikes.length - 1]}  vol=${c.totalVolume}  persist=${c.persistence.toFixed(0)}  ecc=${c.eccentricity.toFixed(2)}  centroid=$${c.centroid.toFixed(1)}`);
  console.log(`  P/C concentration: ${chain.putCallConcentration.toFixed(3)}   OI: ${chain.oiAccumulation}`);

  // IV topology
  const iv = computeIVTopology(synCalls, synPuts, dayClose);
  console.log(`\n  IV curvature: call=${iv.callIntegratedCurvature.toFixed(6)}  put=${iv.putIntegratedCurvature.toFixed(6)}`);
  console.log(`  Skew slope:   call=${iv.callSkewSlope.toFixed(6)}  put=${iv.putSkewSlope.toFixed(6)}`);
  if (iv.anomalies.length > 0) {
    console.log(`  IV anomalies (${iv.anomalies.length}):`);
    for (const a of iv.anomalies)
      console.log(`    $${a.strike} ${a.side}  z=${a.zScore.toFixed(2)}  residual=${(a.residual * 100).toFixed(2)}%  ${a.direction}`);
  } else {
    console.log(`  No IV anomalies detected.`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 7 — Bottleneck distance between two windows
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 7: Bottleneck Distance — Morning vs Afternoon`);
  console.log(`${'─'.repeat(62)}`);

  const midTs = firstTs + (lastTs - firstTs) / 2;
  const morningBars = bars1m.filter(b => {
    const t = new Date(b.timestamp).getTime();
    return t >= firstTs && t < midTs;
  });
  const afternoonBars = bars1m.filter(b => {
    const t = new Date(b.timestamp).getTime();
    return t >= midTs && t <= lastTs;
  });

  if (morningBars.length >= 50 && afternoonBars.length >= 50) {
    const mTopo = computePriceTopology(morningBars.slice(-150), 'SPY_am', 3, 2, 50);
    const aTopo = computePriceTopology(afternoonBars.slice(-150), 'SPY_pm', 3, 2, 50);

    const bn0 = bottleneckDistance(mTopo.diagram, aTopo.diagram, 0);
    const bn1 = bottleneckDistance(mTopo.diagram, aTopo.diagram, 1);

    console.log(`\n  Morning:   regime=${mTopo.regime}  stab=${mTopo.regimeStability.toFixed(3)}  cyclic=${mTopo.cyclicalStrength.toFixed(3)}  β=[${mTopo.diagram.betti}]`);
    console.log(`  Afternoon: regime=${aTopo.regime}  stab=${aTopo.regimeStability.toFixed(3)}  cyclic=${aTopo.cyclicalStrength.toFixed(3)}  β=[${aTopo.diagram.betti}]`);
    console.log(`  Bottleneck H0: ${bn0.toFixed(4)}   H1: ${bn1.toFixed(4)}`);

    if (bn0 > 0.3 || bn1 > 0.3) {
      console.log(`  → Significant structural change between sessions`);
    } else {
      console.log(`  → Similar attractor shape across sessions`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 8 — Entry Model: walk through the day, fire entries and exits
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 8: Entry Model — Entries & Exits Through the Day`);
  console.log(`${'─'.repeat(62)}`);

  // Simulate a walk through market hours (9:30–16:00 ET = 13:30–20:00 UTC)
  // using real price topology + synthetic option chain at each step
  const marketOpenTs = firstTs + 4 * 3600_000; // ~4h after premarket start
  const marketCloseTs = lastTs;
  const entryStepMs = 1 * 60_000; // 1-min steps — matches live data feed

  // Helpers for order simulation (same approach as backtest-day.ts)

  /** Aggregate 1m bars into N-minute bars for ATR calculation */
  function aggregateNm(bars1: OHLCVBar[], minutes: number): OHLCVBar[] {
    const bucketMs = minutes * 60_000;
    const groups = new Map<number, OHLCVBar[]>();
    for (const b of bars1) {
      const ts = new Date(b.timestamp).getTime();
      const bk = Math.floor(ts / bucketMs) * bucketMs;
      let g = groups.get(bk);
      if (!g) { g = []; groups.set(bk, g); }
      g.push(b);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([bk, bs]) => ({
        timestamp: new Date(bk).toISOString(),
        open: bs[0]!.open,
        high: Math.max(...bs.map(b => b.high)),
        low: Math.min(...bs.map(b => b.low)),
        close: bs[bs.length - 1]!.close,
        volume: bs.reduce((s, b) => s + b.volume, 0),
      }));
  }

  /** Compute ATR from 5-minute aggregated bars (matches backtest-day.ts multi-timeframe ATR) */
  function computeATR5m(bars1: OHLCVBar[], period = 14): number {
    const bars5 = aggregateNm(bars1, 5);
    if (bars5.length < 2) return 0;
    const trs: number[] = [];
    for (let i = 1; i < bars5.length; i++) {
      const b = bars5[i]!, prev = bars5[i - 1]!;
      trs.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
    }
    const slice = trs.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  }

  /** Convert OHLCVBar (market type) to SimOHLCVBar (sim type) */
  function toSimBar(b: OHLCVBar): SimOHLCVBar {
    return { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  }

  const ENTRY_COOLDOWN_MS = 3 * 60_000; // 3-min cooldown between entries (matches live scheduler cycle)

  let inPosition = false;
  let posDir: 'bullish' | 'bearish' = 'bullish';
  let entryTime = '';
  let entryUnderlying = 0;
  let consecutiveStops = 0;
  let skipUntilTs = 0; // skip bars while sim holds the position + cooldown

  interface TradeRecord {
    time: string; dir: string; underlying: number;
    conviction: number; regime: string; action: 'ENTER' | 'EXIT'; gates: string;
    exitReason?: string; pnl?: number; pnlPct?: number; holdBars?: number;
    entryPremium?: number; exitPremium?: number; atr?: number;
    peakPnlPct?: number;
  }
  const trades: TradeRecord[] = [];

  resetSessionOI(TICKER);

  for (let ts = firstTs + 30 * 60_000; ts <= lastTs; ts += entryStepMs) {
    if (ts < skipUntilTs) continue; // skip bars consumed by the order sim
    const window = bars1m.filter(b => new Date(b.timestamp).getTime() <= ts).slice(-200);
    if (window.length < 50) continue;
    const price = window[window.length - 1]!.close;
    const time = timeET(new Date(ts).toISOString());

    // Price topology
    const priceTopo = computePriceTopology(window, 'SPY_entry');

    // Option chain from Black-Scholes + price dynamics
    const nextDay = new Date(TARGET_DATE); nextDay.setDate(nextDay.getDate() + 1);
    const expiry = nextDay.toISOString().slice(0, 10);
    const { callChain: simCalls, putChain: simPuts } = simulateChain(window, TICKER, expiry);

    const chainTopo = computeChainTopology(simCalls, simPuts, price);
    const ivTopo = computeIVTopology(simCalls, simPuts, price);

    // Classify actions from chain topology
    const actions: TopologySignal['actions'] = [];
    for (const cl of [...chainTopo.callClusters, ...chainTopo.putClusters]) {
      if (cl.eccentricity > 0.4 && cl.strikes.length >= 3) {
        actions.push({ type: 'sweep', direction: cl.side === 'call' ? 'bullish' : 'bearish',
          strikes: cl.strikes, sides: [cl.side], confidence: Math.min(1, cl.persistence / 1000),
          description: `${cl.side} sweep $${cl.strikes[0]}-$${cl.strikes[cl.strikes.length-1]}`,
          invariants: ['volume_β₀'] });
      } else if (cl.totalVolume > 3000 && cl.strikes.length <= 2) {
        actions.push({ type: 'block', direction: cl.side === 'call' ? 'bullish' : 'bearish',
          strikes: cl.strikes, sides: [cl.side], confidence: Math.min(1, cl.persistence / 500),
          description: `${cl.side} block at $${cl.centroid.toFixed(0)} vol=${cl.totalVolume}`,
          invariants: ['volume_β₀'] });
      }
    }
    for (const a of ivTopo.anomalies) {
      actions.push({ type: 'iv_dislocation',
        direction: a.direction === 'bid_up' ? (a.side === 'call' ? 'bullish' : 'bearish') : 'neutral',
        strikes: [a.strike], sides: [a.side], confidence: Math.min(1, Math.abs(a.zScore) / 3),
        description: `IV ${a.direction} $${a.strike} ${a.side} z=${a.zScore.toFixed(1)}`,
        invariants: ['iv_curvature'] });
    }

    const topoSignal: TopologySignal = {
      ticker: TICKER, timestamp: new Date(ts).toISOString(),
      price: priceTopo, chain: chainTopo, iv: ivTopo, actions, anomalyScore: 0,
    };

    if (!inPosition) {
      // Try to enter
      const entry = computeTopologyEntry(topoSignal, 'bullish', consecutiveStops);
      if (entry.action === 'ENTER' && entry.conviction > 0.02) {
        posDir = entry.direction as 'bullish' | 'bearish';
        entryTime = time;
        entryUnderlying = price;

        const gateStr = entry.gates.map(g => `${g.name}(${g.strength.toFixed(2)})`).join(' × ');

        // Run order simulation on remaining bars (same as backtest-day.ts)
        const futureBars = target.filter(b => new Date(b.timestamp).getTime() > ts).map(toSimBar);
        const recentBars = target.filter(b => {
          const bt = new Date(b.timestamp).getTime();
          return bt <= ts && bt > ts - 10 * 60_000;
        }).map(toSimBar);
        const atr = computeATR5m(window); // 5m ATR matches backtest-day multi-timeframe

        const sim = simulateOrderAgentSpy(price, posDir, atr, futureBars, { recentBars });

        // Record entry
        trades.push({
          time, dir: entry.direction, underlying: price,
          conviction: entry.conviction, regime: entry.regime, action: 'ENTER', gates: gateStr,
          entryPremium: sim.entryPremium, atr,
        });

        // Record exit from sim result
        const exitTs = ts + sim.holdMinutes * 60_000;
        const exitTime = timeET(new Date(exitTs).toISOString());
        const exitPremium = sim.exitPremium ?? (sim.entryPremium ? sim.entryPremium * (1 + sim.pnlPct / 100) : 0);

        trades.push({
          time: exitTime, dir: posDir, underlying: sim.exitPrice,
          conviction: 1.0, regime: entry.regime, action: 'EXIT',
          gates: sim.exitReason, exitReason: sim.exitReason,
          pnl: sim.entryPremium ? exitPremium - sim.entryPremium : undefined,
          pnlPct: sim.pnlPct, holdBars: sim.holdMinutes, peakPnlPct: sim.peakPnlPct,
          entryPremium: sim.entryPremium, exitPremium,
        });

        // Track consecutive stops for topology entry model
        if (sim.exitReason === 'STOP' || sim.exitReason === 'BAD_ENTRY' || sim.exitReason === 'EARLY_EXIT') {
          consecutiveStops++;
        } else if (sim.pnlPct > 0) {
          consecutiveStops = 0;
        }

        // Skip ahead past the sim hold period + cooldown (matches live 3-min scheduler cycle)
        skipUntilTs = exitTs + ENTRY_COOLDOWN_MS;
      }
    }
  }

  // Print trades
  const entryTrades = trades.filter(t => t.action === 'ENTER');
  const exitTrades = trades.filter(t => t.action === 'EXIT');

  console.log(`\n  ENTRIES & EXITS (${entryTrades.length} round-trips):`);
  if (entryTrades.length === 0) console.log(`    No entries fired.`);
  for (let i = 0; i < entryTrades.length; i++) {
    const e = entryTrades[i]!;
    const x = exitTrades[i];
    const atrStr = e.atr ? `ATR=$${e.atr.toFixed(3)}` : '';
    const premStr = e.entryPremium ? `Prem=$${e.entryPremium.toFixed(2)}` : '';
    console.log(`    Entry #${i + 1}: ${e.time} ET  ${e.dir.toUpperCase().padEnd(7)}  ${TICKER} $${e.underlying.toFixed(2)}  ${atrStr}  ${premStr}  conv=${e.conviction.toFixed(3)}  [${e.regime}]`);
    console.log(`      Gates: ${e.gates}`);
    if (x) {
      const icon = (x.pnlPct ?? 0) >= 0 ? '📈' : '📉';
      const pctStr = (x.pnlPct ?? 0) >= 0 ? `+${(x.pnlPct ?? 0).toFixed(1)}%` : `${(x.pnlPct ?? 0).toFixed(1)}%`;
      const peakStr = x.peakPnlPct != null ? `Peak: +${x.peakPnlPct.toFixed(1)}%` : '';
      const ePrem = e.entryPremium?.toFixed(2) ?? '?';
      const xPrem = x.exitPremium?.toFixed(2) ?? '?';
      console.log(`      Sim: ${icon} P&L ${pctStr} | Exit: ${x.exitReason} after ${x.holdBars}m | ${peakStr} | Prem: $${ePrem}→$${xPrem}`);
    }
  }

  // Summary
  const totalPremiumPnl = exitTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  console.log(`\n  TRADE SUMMARY:`);
  console.log(`    Round-trips: ${exitTrades.length}   Win: ${exitTrades.filter(t => (t.pnl ?? 0) > 0).length}   Loss: ${exitTrades.filter(t => (t.pnl ?? 0) <= 0).length}`);
  if (exitTrades.length > 0) {
    const avgPnlPct = exitTrades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / exitTrades.length;
    console.log(`    Closed premium P&L: ${totalPremiumPnl >= 0 ? '+' : ''}$${totalPremiumPnl.toFixed(2)} per contract`);
    console.log(`    Per 1 contract (×100): ${totalPremiumPnl >= 0 ? '+' : ''}$${(totalPremiumPnl * 100).toFixed(0)}`);
    console.log(`    Avg P&L%: ${avgPnlPct >= 0 ? '+' : ''}${avgPnlPct.toFixed(1)}%`);
    // Exit reason breakdown
    const reasons: Record<string, number> = {};
    for (const t of exitTrades) reasons[t.exitReason ?? '?'] = (reasons[t.exitReason ?? '?'] ?? 0) + 1;
    console.log(`    Exit reasons: ${Object.entries(reasons).map(([r, n]) => `${r}=${n}`).join('  ')}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  TEST 9 — Compare: topology entry model vs confidence model
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  TEST 9: Gate Architecture vs Additive Model Comparison`);
  console.log(`${'─'.repeat(62)}`);

  // Show what each gate contributes at a few key moments
  const keyMoments = [
    snaps[0],   // start of day
    snaps[Math.floor(snaps.length * 0.25)],  // 25% through
    snaps[Math.floor(snaps.length * 0.5)],   // midday
    snaps[Math.floor(snaps.length * 0.75)],  // 75% through
    snaps[snaps.length - 1],                 // end of day
  ].filter(Boolean) as typeof snaps;

  for (const s of keyMoments) {
    const topoSig: TopologySignal = {
      ticker: TICKER, timestamp: '', price: s.t, chain: null, iv: null,
      actions: [], anomalyScore: 0,
    };
    const entry = computeTopologyEntry(topoSig, 'bullish');
    console.log(`\n  ${s.time} ET  $${s.price.toFixed(2)}`);
    console.log(`    Action: ${entry.action}  Direction: ${entry.direction}  Conviction: ${entry.conviction.toFixed(4)}`);
    for (const g of entry.gates) {
      const icon = g.passed ? '+' : 'x';
      console.log(`    ${icon} ${g.name.padEnd(12)} str=${g.strength.toFixed(2)}  ${g.reason}`);
    }
    if (entry.action !== 'ENTER') {
      console.log(`    → ${entry.reasoning.split('\n')[0]}`);
    }
  }

  console.log(`\n  KEY DIFFERENCE from additive confidence model:`);
  console.log(`    Additive:      0.38 base + 0.05 ADX + 0.03 cross + ... = 0.72 → ENTER`);
  console.log(`    Multiplicative: REGIME(0.85) × STRUCTURE(0.70) × FLOW(0.50) × IV(0.60) = 0.179 → precision`);
  console.log(`    A single failed gate → 0.00 conviction.  No false entries from bonus stacking.`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  SUMMARY`);
  console.log(`${'═'.repeat(62)}`);

  const regimes: Record<string, number> = {};
  for (const s of snaps) regimes[s.t.regime] = (regimes[s.t.regime] ?? 0) + 1;
  console.log(`\n  Regime distribution:`);
  for (const [r, c] of Object.entries(regimes))
    console.log(`    ${r.padEnd(15)} ${c}/${snaps.length} (${(c / snaps.length * 100).toFixed(0)}%)`);

  const avg = (fn: (s: typeof snaps[0]) => number) => snaps.reduce((a, s) => a + fn(s), 0) / snaps.length;
  console.log(`\n  Day averages:`);
  console.log(`    Stability:  ${avg(s => s.t.regimeStability).toFixed(3)}`);
  console.log(`    Cyclical:   ${avg(s => s.t.cyclicalStrength).toFixed(3)}`);
  console.log(`    Dimension:  ${avg(s => s.t.effectiveDimension).toFixed(2)}`);

  const b0changes = snaps.filter((s, i) => i > 0 && s.t.diagram.betti[0] !== snaps[i - 1]!.t.diagram.betti[0]).length;
  const b1changes = snaps.filter((s, i) => i > 0 && s.t.diagram.betti[1] !== snaps[i - 1]!.t.diagram.betti[1]).length;
  console.log(`\n  Betti changes:  β₀ changed ${b0changes}x   β₁ changed ${b1changes}x`);

  console.log(`\n  Entry model results (order sim: simulateOrderAgentSpy):`);
  console.log(`    Entries: ${entryTrades.length}   Exits: ${exitTrades.length}`);
  const closedPnl = exitTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  console.log(`    Closed premium P&L: ${closedPnl >= 0 ? '+' : ''}$${closedPnl.toFixed(2)} per contract`);
  console.log(`    Per 1 contract (×100): ${closedPnl >= 0 ? '+' : ''}$${(closedPnl * 100).toFixed(0)}`);

  console.log(`\nDone.\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
