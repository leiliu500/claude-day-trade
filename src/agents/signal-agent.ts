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
async function fetchBarsRest(
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

function computeTimeframeIndicators(
  bars: OHLCVBar[],
  timeframe: Timeframe,
  direction: 'bullish' | 'bearish' | 'neutral' = 'neutral'
): TimeframeIndicators {
  const skipGaps = timeframe !== '1d';
  return {
    timeframe,
    bars,
    dmi: computeDMI(bars, 14, skipGaps),
    atr: computeATR(bars, 14, skipGaps),
    obv: computeOBV(bars, 14),
    td: computeTD(bars),
    vwap: computeVWAP(bars),
    candlePattern: detectCandlePattern(bars),
    allCandlePatterns: detectAllPatterns(bars),
    priceStructure: computePriceStructure(bars, 20, direction),
    currentPrice: bars[bars.length - 1]?.close ?? 0,
  };
}


function classifyAlignment(tfs: TimeframeIndicators[], direction: SignalDirection): AlignmentType {
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

    // First pass: compute DMI-based indicators to determine direction
    const dmiOnly = [
      computeDMI(ltfBars, 14, ltf !== '1d'),
      computeDMI(mtfBars, 14, mtf !== '1d'),
      computeDMI(htfBars, 14, htf !== '1d'),
    ];
    const directionVotes = dmiOnly.map(d => d.trend);
    const bullishVotes = directionVotes.filter(v => v === 'bullish').length;
    const bearishVotes = directionVotes.filter(v => v === 'bearish').length;
    let direction: SignalDirection =
      bullishVotes > bearishVotes ? 'bullish' :
      bearishVotes > bullishVotes ? 'bearish' : 'neutral';

    // Early reversal override: when LTF just crossed opposite to majority direction,
    // HTF momentum is fading fast, AND price is at range extreme, the LTF is leading
    // a direction change that MTF/HTF haven't caught up to yet (DMI lag on higher TFs).
    // Override direction to match LTF so we don't miss the first 10-15 min of a reversal.
    // Mar 20 SPY: price peaked at $653.80 (rangePos 0.88), LTF crossed bearish at 12:26 ET,
    // but MTF+HTF stayed bullish for 9 more min → missed $1.50 drop.
    let reversalOverride = false;
    const [ltfDmi, , htfDmi] = dmiOnly;
    if (direction !== 'neutral' && ltfDmi && htfDmi) {
      // Use LTF trend (not just fresh cross) — trend persists longer than the 2-bar cross window.
      const ltfOpposesDir = direction === 'bullish' ? ltfDmi.trend === 'bearish'
                                                     : ltfDmi.trend === 'bullish';
      // HTF DI spread fading: diSpreadSlope uses |DI+ - DI-|, so negative = spread
      // narrowing regardless of direction (momentum fading in either trend).
      const htfFading = htfDmi.diSpreadSlope < -2;
      // Price at range extreme in current direction (using raw price structure from HTF bars)
      const htfBarsForRange = htfBars.slice(-20);
      let rangeHigh = -Infinity, rangeLow = Infinity;
      for (const b of htfBarsForRange) {
        if (b.high > rangeHigh) rangeHigh = b.high;
        if (b.low < rangeLow) rangeLow = b.low;
      }
      const rangeSize = rangeHigh - rangeLow;
      const lastPrice = htfBarsForRange[htfBarsForRange.length - 1]?.close ?? 0;
      const rangePos = rangeSize > 0 ? (lastPrice - rangeLow) / rangeSize : 0.5;
      const atExtreme = direction === 'bullish' ? rangePos >= 0.75 : rangePos <= 0.25;

      if (ltfOpposesDir && htfFading && atExtreme) {
        direction = direction === 'bullish' ? 'bearish' : 'bullish';
        reversalOverride = true;
      }
    }

    // Second pass: build full TF indicators with direction for accurate price levels
    const tfIndicators: TimeframeIndicators[] = [
      computeTimeframeIndicators(ltfBars, ltf, direction),
      computeTimeframeIndicators(mtfBars, mtf, direction),
      computeTimeframeIndicators(htfBars, htf, direction),
    ];
    const alignment = classifyAlignment(tfIndicators, direction);
    const currentPrice = tfIndicators[0]?.currentPrice ?? 0;
    const atr = tfIndicators[2]?.atr.atr ?? tfIndicators[0]?.atr.atr ?? 0; // use HTF ATR
    const atm = Math.round(currentPrice);  // nearest whole-dollar ATM strike

    // ── Mode detection (per-symbol strategy or inline default) ────────────────
    let signalMode: 'trend' | 'range' | 'breakout' = 'trend';
    let rangeSupport: number | undefined;
    let rangeResistance: number | undefined;
    let breakoutLevel: number | undefined;
    let breakoutBeyond: number | undefined;

    const strategy = tickerCfg?.strategy;
    if (strategy) {
      // Use per-symbol strategy for mode detection
      const modeResult = strategy.detectMode(tfIndicators, direction, currentPrice);
      signalMode = modeResult.signalMode;
      if (modeResult.direction) direction = modeResult.direction;
      rangeSupport = modeResult.rangeSupport;
      rangeResistance = modeResult.rangeResistance;
      breakoutLevel = modeResult.breakoutLevel;
      breakoutBeyond = modeResult.breakoutBeyond;
    } else {
      // Inline fallback — uses shared parallel evaluation from default strategy
      const { evaluateRange, evaluateBreakout, resolveMode } = await import('../strategies/default.js');
      const htfTf = tfIndicators[2]!;
      const modeResult = resolveMode(
        evaluateRange(htfTf, currentPrice),
        evaluateBreakout(htfTf, tfIndicators, currentPrice),
      );
      signalMode = modeResult.signalMode;
      if (modeResult.direction) direction = modeResult.direction;
      rangeSupport = modeResult.rangeSupport;
      rangeResistance = modeResult.rangeResistance;
      breakoutLevel = modeResult.breakoutLevel;
      breakoutBeyond = modeResult.breakoutBeyond;
    }

    // Numeric strength score — per-symbol strategy or default
    const strengthScore = strategy
      ? strategy.computeStrength(tfIndicators)
      : Math.min(100, Math.round((tfIndicators[2]?.dmi.adx ?? tfIndicators[1]?.dmi.adx ?? 0) * 2));

    // Market structure: PDH/PDL from daily bars; ORB from LTF (most granular intraday bars)
    const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
    const orb = computeORB(ltfBars, currentPrice);

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
      signalMode,
      rangeSupport,
      rangeResistance,
      breakoutLevel,
      breakoutBeyond,
      triggeredBy: trigger,
      sessionId,
      createdAt: new Date().toISOString(),
    };
  }
}
