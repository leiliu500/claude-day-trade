// mine-missed-corpus.ts
//
// Read the JSONL produced by build-missed-corpus.ts and mine which
// ConfidenceBreakdown factor contributions discriminate "caught" ideal
// entries from "missed" ones.
//
// Pools (per direction):
//   CONFIRMED  — bt_status === 'confirmed'  (system fired on the ideal)
//   BLOCKED    — bt_status === 'blocked'    (gate rejected — typically conf<0.65)
//   FILTERED   — bt_status === 'filtered'   (filter chain killed it; bt_filter_rule set)
//
// For each numeric factor key in bt_breakdown, computes mean/std/n in each
// pool and Cohen's d for CONFIRMED vs each miss pool. Output is ranked by
// |d| so the top rows are the factors most systematically weak/strong on
// misses we should have caught.
//
// Also prints a top-N filter_rule breakdown for FILTERED grade-AB rows.
//
// Usage: npx tsx src/scripts/mine-missed-corpus.ts [--in PATH] [--ticker SYM] [--min-grade A|B|C] [--top N]

import { readFileSync } from 'fs';

interface CorpusRow {
  ticker: string;
  date: string;
  miss_time_et: string;
  direction: 'long' | 'short';
  ideal_grade: 'A' | 'B' | 'C';
  ideal_mfe_pct: number;
  ideal_mae_pct: number;
  ideal_r: number;
  ideal_ttp_min: number;
  bt_status: 'confirmed' | 'blocked' | 'filtered' | null;
  bt_direction: 'bullish' | 'bearish' | null;
  bt_confidence: number | null;
  bt_mode: string | null;
  bt_grade: string | null;
  bt_filter_rule: string | null;
  bt_breakdown: Record<string, number> | null;
  verdict: string;
}

const GRADE_RANK: Record<'A' | 'B' | 'C', number> = { A: 3, B: 2, C: 1 };

interface Args {
  inPath: string;
  ticker: string | null;
  minGrade: 'A' | 'B' | 'C';
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
  const minG = (flags.get('min-grade') ?? 'B').toUpperCase();
  if (minG !== 'A' && minG !== 'B' && minG !== 'C') { console.error('--min-grade must be A/B/C'); process.exit(1); }
  return {
    inPath: flags.get('in') ?? '/tmp/missed-corpus.jsonl',
    ticker: flags.get('ticker') ? flags.get('ticker')!.toUpperCase() : null,
    minGrade: minG as 'A' | 'B' | 'C',
    topN: Number(flags.get('top') ?? 12),
  };
}

function loadRows(path: string): CorpusRow[] {
  const txt = readFileSync(path, 'utf8');
  const rows: CorpusRow[] = [];
  for (const ln of txt.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e: any) { console.error(`bad line: ${e.message}`); }
  }
  return rows;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
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

interface FactorStats {
  field: string;
  nConfirmed: number;
  nMissed: number;
  meanConfirmed: number;
  meanMissed: number;
  delta: number;        // mean(MISSED) − mean(CONFIRMED) — negative = factor weaker on misses
  d: number;            // Cohen's d (MISSED vs CONFIRMED) — same sign as delta
}

function rankFactors(
  confirmed: CorpusRow[],
  missed: CorpusRow[],
  fields: string[],
): FactorStats[] {
  const out: FactorStats[] = [];
  for (const f of fields) {
    const cVals = confirmed.map(r => r.bt_breakdown![f]).filter((x): x is number => typeof x === 'number');
    const mVals = missed.map(r => r.bt_breakdown![f]).filter((x): x is number => typeof x === 'number');
    if (cVals.length < 5 || mVals.length < 5) continue;
    const mc = mean(cVals), mm = mean(mVals);
    out.push({
      field: f,
      nConfirmed: cVals.length,
      nMissed: mVals.length,
      meanConfirmed: mc,
      meanMissed: mm,
      delta: mm - mc,
      d: cohensD(mVals, cVals),
    });
  }
  out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return out;
}

function fmt(n: number, w = 7): string {
  const s = (n >= 0 ? ' ' : '') + n.toFixed(4);
  return s.padStart(w);
}

function printSection(title: string, stats: FactorStats[], topN: number): void {
  console.log(`\n=== ${title} ===`);
  console.log(`  rank  factor                       mean(conf)   mean(miss)    Δ        d      n_conf  n_miss`);
  for (let i = 0; i < Math.min(topN, stats.length); i++) {
    const s = stats[i]!;
    console.log(
      `  ${String(i + 1).padStart(2, ' ')}    ${s.field.padEnd(28)} ${fmt(s.meanConfirmed)}    ${fmt(s.meanMissed)}    ${fmt(s.delta)}  ${fmt(s.d)}     ${String(s.nConfirmed).padStart(4)}    ${String(s.nMissed).padStart(4)}`,
    );
  }
}

(async () => {
  const args = parseArgs();
  const rowsAll = loadRows(args.inPath);
  console.log(`[mine] loaded ${rowsAll.length} rows from ${args.inPath}`);

  // Filter to ticker + min-grade with breakdown present.
  const minRank = GRADE_RANK[args.minGrade];
  let rows = rowsAll.filter(r => GRADE_RANK[r.ideal_grade] >= minRank);
  if (args.ticker) rows = rows.filter(r => r.ticker === args.ticker);
  const withBd = rows.filter(r => r.bt_breakdown != null);
  const blind = rows.length - withBd.length;

  console.log(`[mine] after filter: ${rows.length} rows (ticker=${args.ticker ?? 'ALL'}, grade>=${args.minGrade})`);
  console.log(`[mine]   blind (no bt match): ${blind}`);

  // Status distribution
  const byStatus = new Map<string, number>();
  for (const r of withBd) byStatus.set(r.bt_status ?? 'null', (byStatus.get(r.bt_status ?? 'null') ?? 0) + 1);
  console.log(`[mine]   bt_status: ${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // Direction split for breakdown is meaningful; mine each direction separately.
  for (const dir of ['bullish', 'bearish'] as const) {
    const sub = withBd.filter(r => r.bt_direction === dir);
    const confirmed = sub.filter(r => r.bt_status === 'confirmed');
    const blocked = sub.filter(r => r.bt_status === 'blocked');
    const filtered = sub.filter(r => r.bt_status === 'filtered');
    console.log(`\n[${dir.toUpperCase()}] confirmed=${confirmed.length}  blocked=${blocked.length}  filtered=${filtered.length}`);

    // Discover factor field set from union of breakdown keys.
    const fieldSet = new Set<string>();
    for (const r of sub) for (const k of Object.keys(r.bt_breakdown!)) fieldSet.add(k);
    // Drop pure aggregates from the ranking (still informative — we keep `total` and `base` separately).
    const factorFields = [...fieldSet].filter(k => k !== 'total' && k !== 'base').sort();

    if (confirmed.length >= 5 && blocked.length >= 5) {
      const stats = rankFactors(confirmed, blocked, factorFields);
      printSection(`${dir.toUpperCase()}  CONFIRMED vs BLOCKED  (gate-rejected misses)`, stats, args.topN);
    } else {
      console.log(`  [${dir}] CONFIRMED-vs-BLOCKED: need >=5/each, have ${confirmed.length}/${blocked.length} — skip`);
    }
    if (confirmed.length >= 5 && filtered.length >= 5) {
      const stats = rankFactors(confirmed, filtered, factorFields);
      printSection(`${dir.toUpperCase()}  CONFIRMED vs FILTERED  (filter-chain misses)`, stats, args.topN);
    } else {
      console.log(`  [${dir}] CONFIRMED-vs-FILTERED: need >=5/each, have ${confirmed.length}/${filtered.length} — skip`);
    }

    // Total/base for context
    const tConf = confirmed.map(r => r.bt_breakdown!['total']!).filter(x => typeof x === 'number');
    const tBlk = blocked.map(r => r.bt_breakdown!['total']!).filter(x => typeof x === 'number');
    const tFlt = filtered.map(r => r.bt_breakdown!['total']!).filter(x => typeof x === 'number');
    if (tConf.length >= 5) {
      console.log(`  total: confirmed mean=${mean(tConf).toFixed(3)}  blocked mean=${tBlk.length ? mean(tBlk).toFixed(3) : 'na'}  filtered mean=${tFlt.length ? mean(tFlt).toFixed(3) : 'na'}`);
    }
  }

  // Filter-rule breakdown (FILTERED only)
  console.log(`\n=== FILTERED — top filter rules dropping grade>=${args.minGrade} ideals ===`);
  const filteredAll = withBd.filter(r => r.bt_status === 'filtered');
  const ruleCount = new Map<string, { n: number; bull: number; bear: number; aGrade: number; bGrade: number }>();
  for (const r of filteredAll) {
    const key = (r.bt_filter_rule ?? 'unknown').slice(0, 80);
    const cur = ruleCount.get(key) ?? { n: 0, bull: 0, bear: 0, aGrade: 0, bGrade: 0 };
    cur.n++;
    if (r.bt_direction === 'bullish') cur.bull++;
    if (r.bt_direction === 'bearish') cur.bear++;
    if (r.ideal_grade === 'A') cur.aGrade++;
    if (r.ideal_grade === 'B') cur.bGrade++;
    ruleCount.set(key, cur);
  }
  const sorted = [...ruleCount.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`  rank   n   bull/bear  A/B    rule`);
  for (let i = 0; i < Math.min(args.topN, sorted.length); i++) {
    const [k, v] = sorted[i]!;
    console.log(`  ${String(i + 1).padStart(2)}   ${String(v.n).padStart(3)}   ${String(v.bull).padStart(3)}/${String(v.bear).padEnd(3)}  ${String(v.aGrade)}/${String(v.bGrade).padEnd(3)}  ${k}`);
  }
})();
