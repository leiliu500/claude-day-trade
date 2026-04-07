/**
 * analyze-components.ts — Measure each confidence component's predictive power.
 *
 * Runs a multi-day backtest and computes correlation between each of the 29
 * confidence components and entry outcome (GOOD vs BAD). Components with low
 * correlation should be merged or removed; high-correlation components should
 * get more weight.
 *
 * Usage:
 *   npx tsx src/scripts/analyze-components.ts [START_DATE] [END_DATE] [TICKER]
 *   Defaults: 2026-02-01 to 2026-04-01, SPY
 *
 * Output:
 *   - Per-component correlation with outcome
 *   - Component importance ranking
 *   - Redundancy analysis (correlated component pairs)
 *   - Suggested merges
 */

import 'dotenv/config';
import { config } from '../config.js';
import { computeDMI } from '../indicators/dmi.js';
import { computeATR } from '../indicators/atr.js';
import { computeOBV } from '../indicators/obv.js';
import { computeTD } from '../indicators/td-sequential.js';
import { detectCandlePattern, detectAllPatterns } from '../indicators/candle-patterns.js';
import { computePriceStructure } from '../indicators/price-structure.js';
import { computeVWAP } from '../indicators/vwap.js';
import { computePriorDayLevels, computeORB } from '../indicators/market-structure.js';
import { computePriceVelocity } from '../indicators/price-velocity.js';
import { computeVolumeSurge } from '../indicators/volume-surge.js';
import type { OHLCVBar, Timeframe, AlpacaBarsResponse } from '../types/market.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalPayload, AlignmentType, SignalDirection } from '../types/signal.js';
import type { ConfidenceBreakdown } from '../types/analysis.js';
import { normalizeAlpacaBars } from '../types/market.js';
import { v4 as uuidv4 } from 'uuid';
import { evaluateTrend, evaluateRange, evaluateBreakout, evaluateVwapReversion, resolveMode } from '../strategies/default.js';
import { computeTrendConfidenceFn, computeRangeConfidenceFn, computeBreakoutConfidenceFn } from '../agents/analysis-agent.js';
import { getTickerConfig } from '../ticker-configs.js';
import { detectDirection } from '../lib/direction-detector.js';

// ── Config ────────────────────────────────────────────────────────────────────
const args = process.argv.filter(a => !a.startsWith('--'));
const START_DATE = args[2] || '2026-02-01';
const END_DATE = args[3] || '2026-04-01';
const TICKER = args[4] || 'SPY';

const ALPACA_TF: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

// ── Alpaca REST helpers ──────────────────────────────────────────────────────
async function fetchBarsRange(
  ticker: string, timeframe: Timeframe, start: string, end: string, limit = 10000,
): Promise<OHLCVBar[]> {
  const headers = { 'APCA-API-KEY-ID': config.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY };
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
    if (data.next_page_token) { pageToken = data.next_page_token; } else { break; }
  }
  return allBars;
}

function aggregate1mBars(oneMins: OHLCVBar[], timeframe: Timeframe, upToTs: number): OHLCVBar[] {
  const n = { '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '1d': 1440 }[timeframe] ?? 1;
  if (n <= 1) return oneMins.filter(b => new Date(b.timestamp).getTime() <= upToTs);
  const bucketMs = n * 60_000;
  const currentBucket = Math.floor(upToTs / bucketMs) * bucketMs;
  const groups = new Map<number, OHLCVBar[]>();
  for (const bar of oneMins) {
    const ts = new Date(bar.timestamp).getTime();
    if (ts > upToTs) continue;
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (bucket >= currentBucket) continue;
    let g = groups.get(bucket);
    if (!g) { g = []; groups.set(bucket, g); }
    g.push(bar);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a - b)
    .map(([bucket, bars]) => ({
      timestamp: new Date(bucket).toISOString(),
      open: bars[0]!.open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1]!.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    }));
}

function computeTimeframeIndicators(bars: OHLCVBar[], timeframe: Timeframe, direction: SignalDirection = 'neutral', isLTF = false): TimeframeIndicators {
  const skipGaps = timeframe !== '1d';
  return {
    timeframe, bars,
    dmi: computeDMI(bars, isLTF ? 8 : 14, skipGaps),
    fastDmi: computeDMI(bars, isLTF ? 8 : 7, skipGaps),
    atr: computeATR(bars, 14, skipGaps),
    obv: computeOBV(bars, 14),
    td: computeTD(bars),
    vwap: computeVWAP(bars),
    candlePattern: detectCandlePattern(bars),
    allCandlePatterns: detectAllPatterns(bars),
    priceStructure: computePriceStructure(bars, 20, direction),
    priceVelocity: computePriceVelocity(bars),
    volumeSurge: computeVolumeSurge(bars),
    currentPrice: bars[bars.length - 1]?.close ?? 0,
  };
}

// ── Entry sample ─────────────────────────────────────────────────────────────
interface EntrySample {
  date: string;
  time: string;
  direction: SignalDirection;
  mode: string;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  mfePct: number;
  maePct: number;
  outcome: 'GOOD' | 'BAD' | 'MARGINAL';
}

// ── Component names ─────────────────────────────────────────────────────────
const COMPONENT_KEYS: (keyof ConfidenceBreakdown)[] = [
  'diSpreadBonus', 'adxBonus', 'diCrossBonus', 'alignmentBonus', 'tdAdjustment',
  'obvBonus', 'vwapBonus', 'oiVolumeBonus', 'pricePositionAdjustment',
  'adxMaturityPenalty', 'trendPhaseBonus', 'momentumAccelBonus', 'structureBonus',
  'orbBonus', 'recentPriceActionBonus', 'trContractionPenalty', 'lowVolPenalty',
  'moveExhaustionPenalty', 'consolidationPenalty', 'nearLevelPenalty',
  'thetaDecayPenalty', 'narrowRangePenalty', 'candlePatternBonus',
  'priceVelocityBonus', 'volumeSurgeBonus', 'trendPersistenceBonus',
];

// ── Correlation helper ───────────────────────────────────────────────────────
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  COMPONENT CORRELATION ANALYSIS: ${TICKER}`);
  console.log(`  Date range: ${START_DATE} → ${END_DATE}`);
  console.log(`${'='.repeat(80)}\n`);

  // Get trading dates in range
  const start = new Date(START_DATE);
  const end = new Date(END_DATE);
  const dates: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow > 0 && dow < 6) dates.push(d.toISOString().slice(0, 10));
  }

  console.log(`Fetching ${TICKER} 1m bars for ${dates.length} trading days...`);
  const warmupStart = new Date(START_DATE);
  warmupStart.setDate(warmupStart.getDate() - 5);
  const allOneMinRaw = await fetchBarsRange(TICKER, '1m', warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z', END_DATE + 'T23:59:59Z');
  const allOneMin = allOneMinRaw.filter(b => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(b.timestamp));
    const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
  console.log(`  → ${allOneMin.length} regular-session 1m bars\n`);

  const dailyBars = await fetchBarsRange(TICKER, '1d', warmupStart.toISOString().slice(0, 10) + 'T00:00:00Z', END_DATE + 'T23:59:59Z');

  const samples: EntrySample[] = [];
  const LIVE_CFG = getTickerConfig(TICKER);
  const MIN_CONFIDENCE = LIVE_CFG.minConfidence;

  // Walk each day
  for (const date of dates) {
    const dayBars = allOneMin.filter(b => b.timestamp.startsWith(date));
    if (dayBars.length < 30) continue;

    const priorBars = allOneMin.filter(b => {
      const ts = new Date(b.timestamp).getTime();
      const dayTs = new Date(date + 'T13:30:00Z').getTime();
      return ts < dayTs;
    }).slice(-800);

    const streamCache = [...priorBars];
    const btPersistence = { dir: null as 'bullish' | 'bearish' | null, ts: 0 };
    let barIdx = 0;

    // Sample every 3 minutes (matching scheduler interval)
    for (let i = 0; i < dayBars.length; i += 3) {
      const bar = dayBars[i]!;
      const currentTs = new Date(bar.timestamp).getTime();

      // Add bars to cache
      while (barIdx < dayBars.length) {
        const bt = new Date(dayBars[barIdx]!.timestamp).getTime();
        if (bt < currentTs) { streamCache.push(dayBars[barIdx]!); barIdx++; } else break;
      }
      if (streamCache.length > 800) streamCache.splice(0, streamCache.length - 800);
      if (streamCache.length < 50) continue;

      const ltfBars = streamCache.slice(-500);
      const mtfBars = aggregate1mBars(streamCache, '3m', currentTs).slice(-500);
      const htfBars = aggregate1mBars(streamCache, '5m', currentTs).slice(-500);
      if (ltfBars.length < 14 || mtfBars.length < 14 || htfBars.length < 14) continue;

      const { direction, reversalOverride, leadingSignalOverride } =
        detectDirection(ltfBars, mtfBars, htfBars, true, btPersistence, currentTs);
      if (direction === 'neutral') continue;

      const tfIndicators: TimeframeIndicators[] = [
        computeTimeframeIndicators(ltfBars, '1m', direction, true),
        computeTimeframeIndicators(mtfBars, '3m', direction, false),
        computeTimeframeIndicators(htfBars, '5m', direction, false),
      ];

      const currentPrice = ltfBars[ltfBars.length - 1]!.close;
      const htfTf = tfIndicators[2]!;
      const ltfTf = tfIndicators[0]!;
      const modeResult = resolveMode(
        evaluateTrend(htfTf),
        evaluateRange(htfTf, currentPrice),
        evaluateBreakout(htfTf, tfIndicators, currentPrice),
        evaluateVwapReversion(ltfTf, htfTf, currentPrice),
      );

      let signalMode = modeResult.signalMode;
      if (signalMode === 'none' && leadingSignalOverride) signalMode = 'trend';
      if (signalMode === 'none') signalMode = 'trend'; // fallback for analysis

      const alignment = (() => {
        const [l, m, h] = tfIndicators;
        if (!l || !m || !h) return 'mixed' as AlignmentType;
        const lm = l.dmi.trend === direction;
        const mm = m.dmi.trend === direction;
        const hm = h.dmi.trend === direction;
        if (lm && mm && hm) return 'all_aligned' as AlignmentType;
        if (hm && mm) return 'htf_mtf_aligned' as AlignmentType;
        if (mm && lm) return 'mtf_ltf_aligned' as AlignmentType;
        return 'mixed' as AlignmentType;
      })();

      const atr = tfIndicators[2]?.atr.atr ?? tfIndicators[0]?.atr.atr ?? 0;
      const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
      const orb = computeORB(ltfBars, currentPrice);

      const signal: SignalPayload = {
        id: uuidv4(), ticker: TICKER, profile: 'S',
        timeframes: tfIndicators, ltf: '1m', mtf: '3m', htf: '5m',
        direction, alignment, currentPrice, atr,
        atm: Math.round(currentPrice),
        strengthScore: Math.min(100, Math.round(htfTf.dmi.adx * 2)),
        priorDayLevels, orb,
        reversalOverride: reversalOverride || undefined,
        leadingSignalOverride: leadingSignalOverride || undefined,
        signalMode,
        rangeSupport: modeResult.rangeSupport,
        rangeResistance: modeResult.rangeResistance,
        breakoutLevel: modeResult.breakoutLevel,
        breakoutBeyond: modeResult.breakoutBeyond,
        triggeredBy: 'AUTO', createdAt: bar.timestamp,
      };

      // Compute confidence
      const mockOption = { signalId: signal.id, ticker: TICKER, evaluatedAt: signal.createdAt, desiredSide: direction === 'bearish' ? 'put' as const : 'call' as const, callCandidate: null, putCandidate: null, winner: direction === 'bearish' ? 'put' as const : 'call' as const, winnerCandidate: null, selectionReason: 'mock', liquidityOk: true, candidatePass: true };
      const cb = signalMode === 'range' ? computeRangeConfidenceFn(signal)
        : signalMode === 'breakout' ? computeBreakoutConfidenceFn(signal)
        : computeTrendConfidenceFn(signal, mockOption);

      if (cb.total < 0.45) continue; // skip very low confidence to reduce noise

      // Forward moves (30 min window)
      const futureBars = dayBars.filter(b => {
        const bt = new Date(b.timestamp).getTime();
        return bt > currentTs && bt <= currentTs + 30 * 60_000;
      });
      if (futureBars.length < 5) continue;

      let mfePct = 0, maePct = 0;
      for (const fb of futureBars) {
        const move = direction === 'bullish' ? fb.high - currentPrice : currentPrice - fb.low;
        const adverse = direction === 'bullish' ? currentPrice - fb.low : fb.high - currentPrice;
        mfePct = Math.max(mfePct, (move / currentPrice) * 100);
        maePct = Math.max(maePct, (adverse / currentPrice) * 100);
      }

      const atrPct = (atr / currentPrice) * 100;
      const stopThreshold = atrPct * 0.7;
      const outcome: 'GOOD' | 'BAD' | 'MARGINAL' =
        mfePct > stopThreshold * 1.5 ? 'GOOD' :
        maePct > stopThreshold ? 'BAD' : 'MARGINAL';

      samples.push({
        date, time: bar.timestamp, direction, mode: signalMode,
        confidence: cb.total, breakdown: cb,
        mfePct, maePct, outcome,
      });
    }
    process.stdout.write(`  ${date}: ${samples.filter(s => s.date === date).length} samples\n`);
  }

  console.log(`\nTotal samples: ${samples.length}`);
  console.log(`  GOOD: ${samples.filter(s => s.outcome === 'GOOD').length}`);
  console.log(`  BAD: ${samples.filter(s => s.outcome === 'BAD').length}`);
  console.log(`  MARGINAL: ${samples.filter(s => s.outcome === 'MARGINAL').length}\n`);

  if (samples.length < 20) {
    console.log('Not enough samples for meaningful analysis.');
    process.exit(0);
  }

  // ── Compute outcome score: GOOD=1, MARGINAL=0.5, BAD=0 ──
  const outcomeScores = samples.map(s => s.outcome === 'GOOD' ? 1 : s.outcome === 'BAD' ? 0 : 0.5);

  // ── Per-component correlation with outcome ──
  console.log(`${'='.repeat(80)}`);
  console.log('  COMPONENT CORRELATION WITH OUTCOME (sorted by |correlation|)');
  console.log(`${'='.repeat(80)}`);
  console.log(`${'Component'.padEnd(30)} ${'Corr'.padStart(8)} ${'AvgGood'.padStart(10)} ${'AvgBad'.padStart(10)} ${'Range'.padStart(10)}`);
  console.log('-'.repeat(70));

  const correlations: { key: string; corr: number; avgGood: number; avgBad: number; range: number }[] = [];
  for (const key of COMPONENT_KEYS) {
    const values = samples.map(s => s.breakdown[key] as number);
    const corr = pearsonCorrelation(values, outcomeScores);
    const goodVals = samples.filter(s => s.outcome === 'GOOD').map(s => s.breakdown[key] as number);
    const badVals = samples.filter(s => s.outcome === 'BAD').map(s => s.breakdown[key] as number);
    const avgGood = goodVals.length > 0 ? goodVals.reduce((a, b) => a + b, 0) / goodVals.length : 0;
    const avgBad = badVals.length > 0 ? badVals.reduce((a, b) => a + b, 0) / badVals.length : 0;
    const allVals = values;
    const range = Math.max(...allVals) - Math.min(...allVals);
    correlations.push({ key, corr, avgGood, avgBad, range });
  }

  correlations.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
  for (const c of correlations) {
    const corrStr = (c.corr >= 0 ? '+' : '') + c.corr.toFixed(3);
    console.log(`${c.key.padEnd(30)} ${corrStr.padStart(8)} ${c.avgGood.toFixed(4).padStart(10)} ${c.avgBad.toFixed(4).padStart(10)} ${c.range.toFixed(4).padStart(10)}`);
  }

  // ── Component redundancy (pairwise correlation) ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('  REDUNDANT COMPONENT PAIRS (|correlation| > 0.5)');
  console.log(`${'='.repeat(80)}`);
  const redundant: { a: string; b: string; corr: number }[] = [];
  for (let i = 0; i < COMPONENT_KEYS.length; i++) {
    for (let j = i + 1; j < COMPONENT_KEYS.length; j++) {
      const valsA = samples.map(s => s.breakdown[COMPONENT_KEYS[i]!] as number);
      const valsB = samples.map(s => s.breakdown[COMPONENT_KEYS[j]!] as number);
      const corr = pearsonCorrelation(valsA, valsB);
      if (Math.abs(corr) > 0.5) {
        redundant.push({ a: COMPONENT_KEYS[i]!, b: COMPONENT_KEYS[j]!, corr });
      }
    }
  }
  redundant.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
  for (const r of redundant) {
    console.log(`  ${r.a.padEnd(28)} ↔ ${r.b.padEnd(28)} corr=${r.corr >= 0 ? '+' : ''}${r.corr.toFixed(3)}`);
  }

  // ── Confidence bracket analysis ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('  CONFIDENCE BRACKET ANALYSIS');
  console.log(`${'='.repeat(80)}`);
  const brackets = [
    { label: '0.50-0.55', min: 0.50, max: 0.55 },
    { label: '0.55-0.60', min: 0.55, max: 0.60 },
    { label: '0.60-0.65', min: 0.60, max: 0.65 },
    { label: '0.65-0.70', min: 0.65, max: 0.70 },
    { label: '0.70-0.75', min: 0.70, max: 0.75 },
    { label: '0.75-0.80', min: 0.75, max: 0.80 },
    { label: '0.80+',     min: 0.80, max: 1.01 },
  ];
  console.log(`${'Bracket'.padEnd(12)} ${'Count'.padStart(7)} ${'Good%'.padStart(8)} ${'Bad%'.padStart(8)} ${'AvgMFE'.padStart(10)} ${'AvgMAE'.padStart(10)}`);
  for (const br of brackets) {
    const brSamples = samples.filter(s => s.confidence >= br.min && s.confidence < br.max);
    if (brSamples.length === 0) continue;
    const goodPct = (brSamples.filter(s => s.outcome === 'GOOD').length / brSamples.length * 100);
    const badPct = (brSamples.filter(s => s.outcome === 'BAD').length / brSamples.length * 100);
    const avgMfe = brSamples.reduce((s, e) => s + e.mfePct, 0) / brSamples.length;
    const avgMae = brSamples.reduce((s, e) => s + e.maePct, 0) / brSamples.length;
    console.log(`${br.label.padEnd(12)} ${String(brSamples.length).padStart(7)} ${goodPct.toFixed(1).padStart(7)}% ${badPct.toFixed(1).padStart(7)}% ${avgMfe.toFixed(3).padStart(10)} ${avgMae.toFixed(3).padStart(10)}`);
  }

  // ── Summary: top predictors ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('  TOP 10 PREDICTIVE COMPONENTS (highest |correlation| with outcome)');
  console.log(`${'='.repeat(80)}`);
  for (let i = 0; i < Math.min(10, correlations.length); i++) {
    const c = correlations[i]!;
    const impact = c.corr > 0 ? 'POSITIVE predictor' : 'NEGATIVE predictor';
    console.log(`  ${i + 1}. ${c.key} (corr=${c.corr >= 0 ? '+' : ''}${c.corr.toFixed(3)}) — ${impact}`);
  }

  console.log(`\n  BOTTOM 5 (lowest correlation — candidates for removal/merge):`);
  for (let i = Math.max(0, correlations.length - 5); i < correlations.length; i++) {
    const c = correlations[i]!;
    console.log(`  ${i + 1}. ${c.key} (corr=${c.corr >= 0 ? '+' : ''}${c.corr.toFixed(3)}) — low predictive value`);
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
