// mine-rejected-pool.ts
//
// Rejected-pool sub-discrimination: among entries the system filtered (gate
// rejection / filter chain), what distinguishes the grade-AB "ideal misses we
// should have caught" from the noise we correctly suppressed?
//
// Inputs:
//   • corpus JSONL  — produced by build-missed-corpus.ts (rows for ideal entries
//                     with their matched bt entry; filter to ideal_grade∈{A,B}
//                     bt_status='filtered' to identify MISS-pool by (date, bt_time_et, dir)).
//   • cache dir     — per-day backtest JSON dumps (SPY-{date}.json etc).
//                     We re-extract every filtered[] entry from each day, label
//                     it MISS if it's in the corpus index, NOISE otherwise.
//
// Output: per-direction Cohen's d ranking of breakdown factors, MISS vs NOISE,
// limited to entries with confidence in [conf-min, conf-max] so we mine WITHIN
// the threshold-pass-fail band rather than across the gate gap.
//
// Usage:
//   npx tsx src/scripts/mine-rejected-pool.ts \
//     --corpus /tmp/missed-corpus-spy.jsonl \
//     --cache-dir /tmp/missed-corpus-cache \
//     --ticker SPY [--conf-min 0.45 --conf-max 0.65 --top 12]

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

interface Args {
  corpus: string;
  cacheDir: string;
  ticker: string;
  confMin: number;
  confMax: number;
  topN: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, v] = a.replace(/^--/, '').split('=');
    if (v !== undefined) { flags.set(k!, v); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(k!, next); i++; }
    else flags.set(k!, 'true');
  }
  const num = (k: string, d: number) => {
    const v = flags.get(k);
    if (v === undefined || v === 'true') return d;
    const n = Number(v);
    if (!isFinite(n)) { console.error(`--${k} bad`); process.exit(1); }
    return n;
  };
  return {
    corpus: flags.get('corpus') ?? '/tmp/missed-corpus-spy.jsonl',
    cacheDir: flags.get('cache-dir') ?? '/tmp/missed-corpus-cache',
    ticker: (flags.get('ticker') ?? 'SPY').toUpperCase(),
    confMin: num('conf-min', 0.45),
    confMax: num('conf-max', 0.65),
    topN: num('top', 12),
  };
}

interface CorpusRow {
  ticker: string; date: string;
  ideal_grade: 'A' | 'B' | 'C';
  bt_status: 'confirmed' | 'blocked' | 'filtered' | null;
  bt_time_et: string | null;
  bt_direction: 'bullish' | 'bearish' | null;
}
function loadCorpus(path: string): CorpusRow[] {
  const out: CorpusRow[] = [];
  for (const ln of readFileSync(path, 'utf8').split('\n')) {
    const s = ln.trim(); if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

interface FilteredEntry {
  date: string;
  timeET: string;
  direction: 'bullish' | 'bearish' | string;
  confidence: number;
  grade: string;
  filterRule: string;
  breakdown: Record<string, number> | null;
}

function loadCachedFilteredEntries(cacheDir: string, ticker: string): FilteredEntry[] {
  const out: FilteredEntry[] = [];
  for (const f of readdirSync(cacheDir)) {
    if (!f.startsWith(`${ticker}-`) || !f.endsWith('.json')) continue;
    const date = f.slice(ticker.length + 1, f.length - 5);
    const raw = readFileSync(join(cacheDir, f), 'utf8');
    const m = raw.match(/__JSON_START__([\s\S]*?)__JSON_END__/);
    if (!m) continue;
    let data: any;
    try { data = JSON.parse(m[1]!); } catch { continue; }
    for (const e of data.filtered ?? []) {
      out.push({
        date,
        timeET: e.timeET ?? e.time ?? '',
        direction: e.direction,
        confidence: Number(e.confidence) || 0,
        grade: e.grade ?? '',
        filterRule: e.filterRule ?? '',
        breakdown: e.breakdown ?? null,
      });
    }
  }
  return out;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0; for (const x of xs) s += x;
  return s / xs.length;
}
function stdev(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  let s = 0; for (const x of xs) { const d = x - mu; s += d * d; }
  return Math.sqrt(s / (xs.length - 1));
}
function cohensD(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  const sa = stdev(a, ma), sb = stdev(b, mb);
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return 0;
  const sp = Math.sqrt(((na - 1) * sa * sa + (nb - 1) * sb * sb) / (na + nb - 2));
  if (sp === 0) return 0;
  return (ma - mb) / sp;
}

interface Stats {
  field: string;
  meanMiss: number; meanNoise: number;
  delta: number; d: number;
  nMiss: number; nNoise: number;
}

function rankFactors(missed: FilteredEntry[], noise: FilteredEntry[], fields: string[]): Stats[] {
  const out: Stats[] = [];
  for (const f of fields) {
    const mv = missed.map(r => r.breakdown![f]).filter((x): x is number => typeof x === 'number');
    const nv = noise.map(r => r.breakdown![f]).filter((x): x is number => typeof x === 'number');
    if (mv.length < 5 || nv.length < 5) continue;
    out.push({
      field: f,
      meanMiss: mean(mv), meanNoise: mean(nv),
      delta: mean(mv) - mean(nv),
      d: cohensD(mv, nv),
      nMiss: mv.length, nNoise: nv.length,
    });
  }
  out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return out;
}
function fmt(n: number, w = 7): string {
  return ((n >= 0 ? ' ' : '') + n.toFixed(4)).padStart(w);
}
function printSection(title: string, st: Stats[], topN: number, missLabel = 'MISS', noiseLabel = 'NOISE'): void {
  console.log(`\n=== ${title} ===`);
  console.log(`  rank  factor                       mean(${missLabel.padEnd(5)})  mean(${noiseLabel.padEnd(5)})    Δ        d      n_${missLabel}   n_${noiseLabel}`);
  for (let i = 0; i < Math.min(topN, st.length); i++) {
    const s = st[i]!;
    console.log(`  ${String(i + 1).padStart(2)}    ${s.field.padEnd(28)} ${fmt(s.meanMiss)}    ${fmt(s.meanNoise)}    ${fmt(s.delta)}  ${fmt(s.d)}     ${String(s.nMiss).padStart(4)}    ${String(s.nNoise).padStart(4)}`);
  }
}

(async () => {
  const args = parseArgs();
  console.log(`[mine-rejected] ticker=${args.ticker} corpus=${args.corpus} cache=${args.cacheDir}`);
  console.log(`[mine-rejected] conf band: [${args.confMin}, ${args.confMax})\n`);

  // Build MISS index: corpus rows where ideal_grade ∈ {A,B} and bt_status='filtered'
  // → key = (date, bt_time_et, bt_direction).
  const corpus = loadCorpus(args.corpus).filter(r => r.ticker === args.ticker);
  const missKey = new Set<string>();
  // Also build "any-ideal" set for excluding ideal-C from NOISE.
  const anyIdealKey = new Set<string>();
  // Normalize HH:MM:SS → HH:MM to match cached JSON's timeET format.
  const hhmm = (s: string) => s.slice(0, 5);
  for (const r of corpus) {
    if (r.bt_status !== 'filtered' || !r.bt_time_et || !r.bt_direction) continue;
    const k = `${r.date}|${hhmm(r.bt_time_et)}|${r.bt_direction}`;
    anyIdealKey.add(k);
    if (r.ideal_grade === 'A' || r.ideal_grade === 'B') missKey.add(k);
  }
  console.log(`[mine-rejected] corpus rows for ${args.ticker}: ${corpus.length}`);
  console.log(`[mine-rejected] MISS-index (filtered+ideal-AB): ${missKey.size}`);
  console.log(`[mine-rejected] any-ideal-index (any grade): ${anyIdealKey.size}`);

  // Walk cached backtests, pull every filtered entry with breakdown.
  const allFiltered = loadCachedFilteredEntries(args.cacheDir, args.ticker);
  const withBd = allFiltered.filter(e => e.breakdown != null);
  console.log(`[mine-rejected] cached filtered entries: ${allFiltered.length} (${withBd.length} with breakdown)`);

  // Apply confidence band filter — mining only within near-threshold pool.
  const inBand = withBd.filter(e => e.confidence >= args.confMin && e.confidence < args.confMax);
  console.log(`[mine-rejected] in conf band: ${inBand.length}`);

  // Label each as MISS / NOISE / ideal-C-borderline
  const miss: FilteredEntry[] = [];
  const noise: FilteredEntry[] = [];
  const borderline: FilteredEntry[] = [];
  for (const e of inBand) {
    const k = `${e.date}|${e.timeET}|${e.direction}`;
    if (missKey.has(k)) miss.push(e);
    else if (anyIdealKey.has(k)) borderline.push(e);
    else noise.push(e);
  }
  console.log(`[mine-rejected] MISS=${miss.length}  NOISE=${noise.length}  ideal-C-borderline-excluded=${borderline.length}\n`);

  // Discover factor field set
  const fieldSet = new Set<string>();
  for (const e of inBand) for (const k of Object.keys(e.breakdown!)) fieldSet.add(k);
  const factorFields = [...fieldSet].filter(k => k !== 'total' && k !== 'base').sort();

  // Per-direction mining
  for (const dir of ['bullish', 'bearish'] as const) {
    const m = miss.filter(x => x.direction === dir);
    const n = noise.filter(x => x.direction === dir);
    console.log(`[${dir.toUpperCase()}] miss=${m.length}  noise=${n.length}`);
    if (m.length < 5 || n.length < 5) {
      console.log(`  [${dir}] skip — need >=5/each`);
      continue;
    }
    const stats = rankFactors(m, n, factorFields);
    printSection(`${dir.toUpperCase()} — MISS vs NOISE within filtered conf [${args.confMin}, ${args.confMax})`, stats, args.topN);

    const tM = m.map(r => r.breakdown!['total']!);
    const tN = n.map(r => r.breakdown!['total']!);
    console.log(`  total: miss mean=${mean(tM).toFixed(3)}  noise mean=${mean(tN).toFixed(3)}  Δ=${(mean(tM) - mean(tN)).toFixed(3)}`);

    // Cell scan: for top-3 factors, compute MISS-rate / lift at threshold cuts.
    const top3 = stats.slice(0, 3);
    if (top3.length) {
      console.log(`\n  [${dir}] threshold-cut lift on top-3 factors:`);
      for (const s of top3) {
        const allVals = [...m, ...n].map(r => r.breakdown![s.field]!);
        const sorted = [...allVals].sort((a, b) => a - b);
        const baseRate = m.length / (m.length + n.length);
        // Try a handful of percentile thresholds
        for (const p of [0.5, 0.6, 0.7, 0.8]) {
          const cutHigh = sorted[Math.floor(sorted.length * p)]!;
          // Determine sign of effect — if d > 0, cut is "factor >= cutHigh" pulls MISS up.
          const direction = s.d > 0 ? '>=' : '<=';
          const cut = direction === '>=' ? cutHigh : sorted[Math.floor(sorted.length * (1 - p))]!;
          const passM = direction === '>=' ? m.filter(r => r.breakdown![s.field]! >= cut).length
                                            : m.filter(r => r.breakdown![s.field]! <= cut).length;
          const passN = direction === '>=' ? n.filter(r => r.breakdown![s.field]! >= cut).length
                                            : n.filter(r => r.breakdown![s.field]! <= cut).length;
          const cellTotal = passM + passN;
          if (cellTotal < 5) continue;
          const cellMissRate = passM / cellTotal;
          const lift = cellMissRate - baseRate;
          console.log(`    ${s.field.padEnd(28)} ${direction} ${cut.toFixed(4)}  cell n=${String(cellTotal).padStart(3)}  miss=${String(passM).padStart(2)}  noise=${String(passN).padStart(3)}  miss-rate=${(cellMissRate * 100).toFixed(1)}%  baseRate=${(baseRate * 100).toFixed(1)}%  lift=${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)}pp`);
        }
      }
    }
  }
})();
