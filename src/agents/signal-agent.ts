import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { AlpacaStreamManager } from '../lib/alpaca-stream.js';
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
import { detectDirection, type PersistenceState } from '../lib/direction-detector.js';
import { PROFILE_TIMEFRAMES, normalizeAlpacaBars } from '../types/market.js';
import type { OHLCVBar, Timeframe, TradingProfile, AlpacaBarsResponse } from '../types/market.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalPayload, AlignmentType, SignalDirection } from '../types/signal.js';

const BARS_LIMIT = 500;

const ALPACA_TIMEFRAME: Record<Timeframe, string> = {
  '1m':  '1Min',
  '2m':  '2Min',
  '3m':  '3Min',
  '5m':  '5Min',
  '15m': '15Min',
  '1h':  '1Hour',
  '1d':  '1Day',
};

/** Fetch bars via Alpaca REST API. Always returns real-time data. */
export async function fetchBarsRest(
  ticker: string,
  timeframe: Timeframe,
  limit = BARS_LIMIT
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };

  const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
  url.searchParams.set('timeframe', ALPACA_TIMEFRAME[timeframe]);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('adjustment', 'raw');
  url.searchParams.set('feed', 'sip'); // SIP consolidated tape (Algo Trader Plus)
  // Alpaca requires explicit start for daily bars — without it, returns null
  if (timeframe === '1d') {
    const start = new Date();
    start.setDate(start.getDate() - (limit + 4) * 1.5); // extra padding for weekends/holidays
    url.searchParams.set('start', start.toISOString().slice(0, 10) + 'T00:00:00Z');
  }

  const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`Alpaca bars error ${res.status} for ${ticker} ${timeframe}`);
  }

  const data = (await res.json()) as AlpacaBarsResponse;
  return normalizeAlpacaBars(data);
}

/**
 * Primary bar fetcher — tries the streaming cache first (zero REST calls),
 * falls back to the REST API when the cache is absent, stale, or has
 * insufficient bars (e.g. before the stream has warmed up, or for 1h/1d).
 */
async function fetchBars(
  ticker: string,
  timeframe: Timeframe,
  limit = BARS_LIMIT
): Promise<OHLCVBar[]> {
  const cached = AlpacaStreamManager.getInstance().getBars(ticker, timeframe, Math.min(limit, 50));
  if (cached) {
    // Return up to `limit` bars from the cache (newest are at the end)
    const bars = cached.length > limit ? cached.slice(cached.length - limit) : cached;
    console.log(`[SignalAgent] Using stream cache: ${ticker} ${timeframe} (${bars.length} bars)`);
    return bars;
  }

  // Fallback: REST API (always real-time, no caching at REST layer)
  console.log(`[SignalAgent] REST fallback: ${ticker} ${timeframe}`);
  return fetchBarsRest(ticker, timeframe, limit);
}

export function computeTimeframeIndicators(
  bars: OHLCVBar[],
  timeframe: Timeframe,
  direction: 'bullish' | 'bearish' | 'neutral' = 'neutral',
  isLTF = false
): TimeframeIndicators {
  const skipGaps = timeframe !== '1d';
  // Use shorter DMI period (8) on LTF for faster direction detection.
  // LTF bars (1m, 2m) with 14-period Wilder's smoothing create ~30-bar lag
  // which misses the first 30+ minutes of a move. Period 8 halves this lag
  // while still filtering noise. HTF/MTF keep 14 for stability.
  const dmiPeriod = isLTF ? 8 : 14;
  return {
    timeframe,
    bars,
    dmi: computeDMI(bars, dmiPeriod, skipGaps),
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


export function classifyAlignment(tfs: TimeframeIndicators[], direction: SignalDirection): AlignmentType {
  // tfs order: [LTF, MTF, HTF]
  const [ltf, mtf, htf] = tfs;
  if (!ltf || !mtf || !htf) return 'mixed';

  const d = direction === 'neutral' ? 'neutral' : direction;
  const ltfMatch = ltf.dmi.trend === d;
  const mtfMatch = mtf.dmi.trend === d;
  const htfMatch = htf.dmi.trend === d;

  if (ltfMatch && mtfMatch && htfMatch) return 'all_aligned';
  if (htfMatch && mtfMatch) return 'htf_mtf_aligned';
  if (mtfMatch && ltfMatch) return 'mtf_ltf_aligned';
  return 'mixed';
}

// ── Leading override momentum persistence (per-ticker) ──────────────────────
const _persistence = new Map<string, PersistenceState>();

export class SignalAgent {
  async run(
    ticker: string,
    profile: TradingProfile,
    trigger: 'AUTO' | 'MANUAL',
    sessionId?: string,
    tickerCfg?: import('../ticker-configs.js').TickerConfig,
  ): Promise<SignalPayload> {
    const [ltf, mtf, htf] = PROFILE_TIMEFRAMES[profile];

    // Fetch all 3 timeframes + daily bars (for PDH/PDL) in parallel.
    // Daily bars are always fetched separately — even when HTF is '1d' — to
    // guarantee at least 3 complete daily sessions regardless of profile.
    const [ltfBars, mtfBars, htfBars, dailyBars] = await Promise.all([
      fetchBars(ticker, ltf),
      fetchBars(ticker, mtf),
      fetchBars(ticker, htf),
      fetchBarsRest(ticker, '1d', 3),
    ]);

    // ── Direction detection (shared with backtest) ─────────────────────────────
    if (!_persistence.has(ticker)) _persistence.set(ticker, { dir: null, ts: 0 });
    const persistence = _persistence.get(ticker)!;
    const { direction: detectedDir, reversalOverride, leadingSignalOverride } =
      detectDirection(ltfBars, mtfBars, htfBars, ltf !== '1d', persistence, Date.now());
    let direction = detectedDir;

    // Second pass: build full TF indicators with direction for accurate price levels
    const tfIndicators: TimeframeIndicators[] = [
      computeTimeframeIndicators(ltfBars, ltf, direction, true),   // LTF: shorter DMI period (8) for faster detection
      computeTimeframeIndicators(mtfBars, mtf, direction, false),
      computeTimeframeIndicators(htfBars, htf, direction, false),
    ];
    const alignment = classifyAlignment(tfIndicators, direction);
    const currentPrice = tfIndicators[0]?.currentPrice ?? 0;
    const atr = tfIndicators[2]?.atr.atr ?? tfIndicators[0]?.atr.atr ?? 0; // use HTF ATR
    const atm = Math.round(currentPrice);  // nearest whole-dollar ATM strike

    // ── Mode detection (per-symbol strategy or inline default) ────────────────
    let signalMode: 'trend' | 'range' | 'breakout' | 'vwap_reversion' | 'none' = 'none';
    let rangeSupport: number | undefined;
    let rangeResistance: number | undefined;
    let breakoutLevel: number | undefined;
    let breakoutBeyond: number | undefined;
    let vwapReversionTarget: number | undefined;
    let vwapDistance: number | undefined;

    const strategy = tickerCfg?.strategy;
    if (strategy) {
      // Use per-symbol strategy for mode detection
      const modeResult = strategy.detectMode(tfIndicators, direction, currentPrice);
      signalMode = modeResult.signalMode;
      // Only apply mode evaluator's direction when leading override hasn't already set a faster direction.
      // Leading indicators (velocity + LTF DMI) detect direction changes 5-15 bars before HTF DI catches up.
      if (modeResult.direction && !leadingSignalOverride) direction = modeResult.direction;
      rangeSupport = modeResult.rangeSupport;
      rangeResistance = modeResult.rangeResistance;
      breakoutLevel = modeResult.breakoutLevel;
      breakoutBeyond = modeResult.breakoutBeyond;
      vwapReversionTarget = modeResult.vwapReversionTarget;
      vwapDistance = modeResult.vwapDistance;
    } else {
      // Inline fallback — uses shared parallel evaluation from default strategy
      const { evaluateTrend, evaluateRange, evaluateBreakout, evaluateVwapReversion, resolveMode } = await import('../strategies/default.js');
      const htfTf = tfIndicators[2]!;
      const ltfTf = tfIndicators[0]!;
      const modeResult = resolveMode(
        evaluateTrend(htfTf),
        evaluateRange(htfTf, currentPrice),
        evaluateBreakout(htfTf, tfIndicators, currentPrice),
        evaluateVwapReversion(ltfTf, htfTf, currentPrice),
      );
      signalMode = modeResult.signalMode;
      if (modeResult.direction && !leadingSignalOverride) direction = modeResult.direction;
      rangeSupport = modeResult.rangeSupport;
      rangeResistance = modeResult.rangeResistance;
      breakoutLevel = modeResult.breakoutLevel;
      breakoutBeyond = modeResult.breakoutBeyond;
      vwapReversionTarget = modeResult.vwapReversionTarget;
      vwapDistance = modeResult.vwapDistance;
    }

    // Leading signal mode rescue: when mode detection returns 'none' because HTF ADX
    // is still low (< 18) but leading indicators have confirmed a directional move,
    // force trend mode. Without this, the entire pipeline stops — no confidence is
    // computed, no entry is possible, and the leading indicator override is wasted.
    // This is the critical bridge: leading indicators detect the move → force trend mode
    // → trend confidence model runs with lowered threshold → entry happens before ADX rises.
    if (signalMode === 'none' && leadingSignalOverride && direction !== 'neutral') {
      signalMode = 'trend';
      console.log(`[SignalAgent] Leading signal mode rescue: forced trend mode (ADX=${tfIndicators[2]?.dmi.adx.toFixed(1) ?? '?'}, dir=${direction})`);
    }

    // Numeric strength score — per-symbol strategy or default
    const strengthScore = strategy
      ? strategy.computeStrength(tfIndicators)
      : Math.min(100, Math.round((tfIndicators[2]?.dmi.adx ?? tfIndicators[1]?.dmi.adx ?? 0) * 2));

    // Market structure: PDH/PDL from daily bars; ORB from LTF (most granular intraday bars)
    const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
    const orb = computeORB(ltfBars, currentPrice);

    // Order flow microstructure from SIP trade + quote streams
    const orderFlow = AlpacaStreamManager.getInstance().getOrderFlow(ticker) ?? undefined;
    if (orderFlow) {
      console.log(`[SignalAgent] Order flow: ${ticker} imb1m=${orderFlow.imbalance1m.toFixed(3)} flow=${orderFlow.flowDirection} tps=${orderFlow.tradesPerSecond.toFixed(1)}`);
    }

    return {
      id: uuidv4(),
      ticker,
      profile,
      timeframes: tfIndicators,
      ltf,
      mtf,
      htf,
      direction,
      alignment,
      currentPrice,
      atr,
      atm,
      strengthScore,
      priorDayLevels,
      orb,
      reversalOverride: reversalOverride || undefined,
      leadingSignalOverride: leadingSignalOverride || undefined,
      signalMode,
      rangeSupport,
      rangeResistance,
      breakoutLevel,
      breakoutBeyond,
      vwapReversionTarget,
      vwapDistance,
      orderFlow,
      triggeredBy: trigger,
      sessionId,
      createdAt: new Date().toISOString(),
    };
  }
}
