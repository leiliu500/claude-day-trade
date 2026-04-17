/**
 * Debug script: trace direction-detector reversal logic on a specific day.
 * Dumps all reversal-relevant state for each minute in a given ET time window.
 *
 * Usage: npx tsx src/scripts/debug-reversal.ts 2026-04-16 SPY 11:30 13:30
 */

import { config } from '../config.js';
import { detectDirection, type PersistenceState } from '../lib/direction-detector.js';
import { computeDMI } from '../indicators/dmi.js';
import { computePriceVelocity } from '../indicators/price-velocity.js';
import type { OHLCVBar } from '../types/market.js';

const [, , dateArg = '2026-04-16', tickerArg = 'SPY', startET = '11:30', endET = '13:30'] = process.argv;

// ── Alpaca fetch ──
interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number }
interface AlpacaBarsResponse { bars: AlpacaBar[] | null; next_page_token?: string }

async function fetchBars(ticker: string, start: string, end: string): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const allBars: OHLCVBar[] = [];
  let pageToken: string | undefined;
  while (true) {
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', '1Min');
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('adjustment', 'raw');
    url.searchParams.set('feed', 'sip');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as AlpacaBarsResponse;
    if (data.bars) {
      for (const b of data.bars) {
        allBars.push({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      }
    }
    if (data.next_page_token) pageToken = data.next_page_token; else break;
  }
  return allBars;
}

// ── Bar aggregation ──
function aggregate(bars: OHLCVBar[], mins: number, nowMs: number): OHLCVBar[] {
  const result: OHLCVBar[] = [];
  let bucket: OHLCVBar | null = null;
  let bucketKey = 0;
  for (const b of bars) {
    const bMs = new Date(b.timestamp).getTime();
    if (bMs >= nowMs) break;
    const key = Math.floor(bMs / (mins * 60_000));
    if (key !== bucketKey || !bucket) {
      if (bucket) result.push(bucket);
      bucket = { ...b };
      bucketKey = key;
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume += b.volume;
    }
  }
  if (bucket) result.push(bucket);
  return result;
}

async function main() {
  const date = dateArg;
  const ticker = tickerArg;
  const [startH, startM] = startET.split(':').map(Number);
  const [endH, endM] = endET.split(':').map(Number);

  // Fetch with warmup
  const fetchStart = new Date(`${date}T00:00:00Z`);
  fetchStart.setDate(fetchStart.getDate() - 4);
  console.log(`Fetching 1m bars for ${ticker}...`);
  const allBars = await fetchBars(ticker, fetchStart.toISOString(), `${date}T23:59:59Z`);

  // Regular session only
  const regularBars = allBars.filter(b => {
    const h = parseInt(b.timestamp.slice(11, 13), 10);
    const m = parseInt(b.timestamp.slice(14, 16), 10);
    const totalMin = h * 60 + m;
    return totalMin >= 810 && totalMin < 1200; // 13:30–20:00 UTC
  });
  console.log(`  → ${regularBars.length} regular-session bars\n`);

  // EDT: UTC-4
  const windowStartMs = new Date(`${date}T${String(startH! + 4).padStart(2, '0')}:${String(startM!).padStart(2, '0')}:00Z`).getTime();
  const windowEndMs = new Date(`${date}T${String(endH! + 4).padStart(2, '0')}:${String(endM!).padStart(2, '0')}:00Z`).getTime();
  const marketOpenMs = new Date(`${date}T13:30:00Z`).getTime();

  const persistence: PersistenceState = { dir: null, ts: 0 };

  console.log('Time   Price    Dir       DMI[L/M/H]   HTF-diSS  RevOvr Lead  LTF       htfFade rPos  atExtr  dVel      extROC    accel     persist');
  console.log('─'.repeat(150));

  for (let i = 0; i < regularBars.length; i++) {
    const bar = regularBars[i]!;
    const barMs = new Date(bar.timestamp).getTime();
    if (barMs < marketOpenMs) continue;

    const cache = regularBars.slice(0, i + 1).slice(-800);
    if (cache.length < 20) continue;

    const ltfBars = cache.slice(-500);
    const mtfBars = aggregate(cache, 3, barMs + 60_000).slice(-500);
    const htfBars = aggregate(cache, 5, barMs + 60_000).slice(-500);
    if (ltfBars.length < 14 || mtfBars.length < 14 || htfBars.length < 14) continue;

    const result = detectDirection(ltfBars, mtfBars, htfBars, true, persistence, barMs);

    if (barMs < windowStartMs || barMs > windowEndMs) continue;

    const [ltfDmi, mtfDmi, htfDmi] = result.dmiOnly;

    // Range position from HTF
    const htfSlice = htfBars.slice(-20);
    let rH = -Infinity, rL = Infinity;
    for (const b of htfSlice) { if (b.high > rH) rH = b.high; if (b.low < rL) rL = b.low; }
    const rSize = rH - rL;
    const lastP = htfSlice[htfSlice.length - 1]?.close ?? 0;
    const rPos = rSize > 0 ? (lastP - rL) / rSize : 0.5;

    // DMI majority for atExtreme check
    const votes = result.dmiOnly.map(d => d.trend);
    const bull = votes.filter(v => v === 'bullish').length;
    const bear = votes.filter(v => v === 'bearish').length;
    const majorityDir = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
    const atExtreme = majorityDir === 'bullish' ? rPos >= 0.75 : rPos <= 0.25;

    // Velocity & ROC
    const vel = computePriceVelocity(ltfBars);
    const todayBarsForRoc = ltfBars.filter(b => b.timestamp.startsWith(date));
    const rocLen = todayBarsForRoc.length;
    const extRoc = rocLen > 20
      ? ((todayBarsForRoc[rocLen - 1]!.close - todayBarsForRoc[rocLen - 1 - 20]!.close)
         / todayBarsForRoc[rocLen - 1 - 20]!.close) * 100 : 0;

    // Format ET time
    const utcH = parseInt(bar.timestamp.slice(11, 13), 10);
    const utcM = parseInt(bar.timestamp.slice(14, 16), 10);
    const etTime = `${String(utcH - 4).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;

    const htfFading = htfDmi.diSpreadSlope < -2;
    const ltfOpposesDir = majorityDir === 'bullish' ? ltfDmi.trend === 'bearish' : ltfDmi.trend === 'bullish';

    console.log(
      `${etTime}  $${bar.close.toFixed(2)}  ${result.direction.padEnd(8)}  ` +
      `${ltfDmi.trend[0]}/${mtfDmi.trend[0]}/${htfDmi.trend[0]}          ` +
      `${htfDmi.diSpreadSlope.toFixed(1).padStart(5)}     ` +
      `${result.reversalOverride ? 'REV' : '   '}   ` +
      `${result.leadingSignalOverride ? 'LEAD' : '    '}  ` +
      `${ltfDmi.trend.padEnd(8)}  ` +
      `${htfFading ? 'FADE' : htfDmi.diSpreadSlope < 0 ? 'slow' : 'GROW'}    ` +
      `${rPos.toFixed(2)}  ` +
      `${atExtreme ? 'YES' : 'no '}     ` +
      `${vel.directionalVelocity.toFixed(4).padStart(8)}  ` +
      `${extRoc.toFixed(4).padStart(8)}  ` +
      `${vel.acceleration.toFixed(4).padStart(8)}  ` +
      `${persistence.dir ?? 'none'}`
    );
  }
}

main().catch(console.error);
