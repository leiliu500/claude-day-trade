/**
 * Level Signal Agent — replaces the indicator-based signal agent with a
 * level-interaction architecture.
 *
 * Instead of computing DMI/OBV confidence scores, this agent:
 *   1. Computes all price levels (PDH/PDL/PDC, ORB, VWAP, VPOC, swings)
 *   2. Tracks price structure (swing HH/HL/LH/LL, failed breakouts)
 *   3. Determines market context (day type, gap, volatility regime)
 *   4. Detects level interaction (approaching, testing, rejecting, accepting)
 *   5. Generates a setup if conditions are met
 *
 * Output is a standard SignalPayload (for pipeline compatibility) enriched
 * with LevelSignalData.
 */

import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { AlpacaStreamManager } from '../lib/alpaca-stream.js';
import { normalizeAlpacaBars, PROFILE_TIMEFRAMES } from '../types/market.js';
import type { OHLCVBar, Timeframe, TradingProfile, AlpacaBarsResponse } from '../types/market.js';
import type { TimeframeIndicators } from '../types/indicators.js';
import type { SignalPayload, SignalDirection, AlignmentType } from '../types/signal.js';
import type { LevelSignalData } from '../types/levels.js';

// Indicators we still need (ATR for sizing, VWAP for levels, candle patterns)
import { computeATR } from '../indicators/atr.js';
import { computeVWAP } from '../indicators/vwap.js';
import { computePriorDayLevels, computeORB } from '../indicators/market-structure.js';
import { computeDMI } from '../indicators/dmi.js';
import { computeOBV } from '../indicators/obv.js';
import { computeTD } from '../indicators/td-sequential.js';
import { detectCandlePattern, detectAllPatterns } from '../indicators/candle-patterns.js';
import { computePriceStructure } from '../indicators/price-structure.js';
import { computePriceVelocity } from '../indicators/price-velocity.js';
import { computeVolumeSurge } from '../indicators/volume-surge.js';

// Level system
import { computeLevels, type LevelEngineOutput } from '../levels/level-engine.js';
import { computeVolumeProfile } from '../levels/volume-profile.js';
import { LevelCache } from '../levels/level-cache.js';
import { detectSwingPoints } from '../structure/swing-detector.js';
import { analyzeStructure } from '../structure/structure-tracker.js';
import { computeMarketContext } from '../context/market-context.js';
import { detectLevelInteraction, generateSetup } from '../levels/level-interaction.js';
import { computeGEXLevels, gexToPriceLevels } from '../levels/gex-levels.js';
import { computeBreadthProxy, fetchSectorBarsFromStream } from '../context/breadth-proxy.js';
import type { BreadthData, GEXData } from '../types/levels.js';

const BARS_LIMIT = 500;

const ALPACA_TIMEFRAME: Record<Timeframe, string> = {
  '1m': '1Min', '2m': '2Min', '3m': '3Min', '5m': '5Min',
  '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

// Per-ticker level caches (persist across ticks within a session)
const _levelCaches = new Map<string, LevelCache>();

function getLevelCache(ticker: string): LevelCache {
  if (!_levelCaches.has(ticker)) _levelCaches.set(ticker, new LevelCache());
  return _levelCaches.get(ticker)!;
}

// Setup deduplication: no repeat setup at the same level within DEDUP_COOLDOWN_MS
const DEDUP_COOLDOWN_MS = 15 * 60_000; // 15 minutes
const _recentSetups = new Map<string, Map<string, number>>(); // ticker → (levelKey → timestamp)

function isDuplicateSetup(ticker: string, levelPrice: number, levelType: string, now: number): boolean {
  if (!_recentSetups.has(ticker)) _recentSetups.set(ticker, new Map());
  const tickerSetups = _recentSetups.get(ticker)!;
  const key = `${levelType}:${levelPrice.toFixed(2)}`;
  const lastTs = tickerSetups.get(key);
  if (lastTs && now - lastTs < DEDUP_COOLDOWN_MS) return true;
  tickerSetups.set(key, now);
  // Prune old entries
  for (const [k, ts] of tickerSetups) {
    if (now - ts > DEDUP_COOLDOWN_MS * 2) tickerSetups.delete(k);
  }
  return false;
}

// ── Bar Fetching (reused from signal-agent) ──────────────────────────────────

async function fetchBarsRest(
  ticker: string,
  timeframe: Timeframe,
  limit = BARS_LIMIT,
): Promise<OHLCVBar[]> {
  const headers = {
    'APCA-API-KEY-ID': config.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
  };
  const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
  url.searchParams.set('timeframe', ALPACA_TIMEFRAME[timeframe]);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('adjustment', 'raw');
  url.searchParams.set('feed', 'sip');
  if (timeframe === '1d') {
    const start = new Date();
    start.setDate(start.getDate() - (limit + 4) * 1.5);
    url.searchParams.set('start', start.toISOString().slice(0, 10) + 'T00:00:00Z');
  }
  const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Alpaca bars error ${res.status} for ${ticker} ${timeframe}`);
  const data = (await res.json()) as AlpacaBarsResponse;
  return normalizeAlpacaBars(data);
}

async function fetchBars(ticker: string, timeframe: Timeframe, limit = BARS_LIMIT): Promise<OHLCVBar[]> {
  const cached = AlpacaStreamManager.getInstance().getBars(ticker, timeframe, Math.min(limit, 50));
  if (cached) {
    const bars = cached.length > limit ? cached.slice(cached.length - limit) : cached;
    return bars;
  }
  return fetchBarsRest(ticker, timeframe, limit);
}

// ── Timeframe Indicators (still needed for pipeline compatibility) ────────────

function computeTimeframeIndicators(
  bars: OHLCVBar[],
  timeframe: Timeframe,
  direction: SignalDirection = 'neutral',
  isLTF = false,
): TimeframeIndicators {
  const skipGaps = timeframe !== '1d';
  const dmiPeriod = isLTF ? 8 : 14;
  return {
    timeframe, bars,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function filterRegularSession(bars: OHLCVBar[]): OHLCVBar[] {
  if (bars.length === 0) return [];
  const todayDate = bars[bars.length - 1]!.timestamp.slice(0, 10);
  return bars.filter(b => {
    if (!b.timestamp.startsWith(todayDate)) return false;
    const time = b.timestamp.slice(11, 16);
    return time >= '14:30' && time < '21:00';
  });
}

function computeAvgDailyATRPct(dailyBars: OHLCVBar[]): number {
  if (dailyBars.length < 2) return 1.0;
  let sum = 0;
  for (let i = 1; i < dailyBars.length; i++) {
    const bar = dailyBars[i]!;
    const range = bar.high - bar.low;
    if (bar.close > 0) sum += (range / bar.close) * 100;
  }
  return sum / (dailyBars.length - 1);
}

// ── Level Signal Agent ───────────────────────────────────────────────────────

export class LevelSignalAgent {
  async run(
    ticker: string,
    profile: TradingProfile,
    trigger: 'AUTO' | 'MANUAL',
    sessionId?: string,
    tickerCfg?: import('../ticker-configs.js').TickerConfig,
  ): Promise<SignalPayload & { levelData: LevelSignalData }> {
    const [ltf, mtf, htf] = PROFILE_TIMEFRAMES[profile];

    // Fetch bars in parallel
    const [ltfBars, mtfBars, htfBars, dailyBars] = await Promise.all([
      fetchBars(ticker, ltf),
      fetchBars(ticker, mtf),
      fetchBars(ticker, htf),
      fetchBarsRest(ticker, '1d', 30),  // more daily bars for weekly/monthly open
    ]);

    const currentPrice = ltfBars[ltfBars.length - 1]?.close ?? 0;
    const todayBars1m = filterRegularSession(ltfBars);

    // ── 1. Compute ATR (needed for all level calculations) ───────────────────
    const htfATR = computeATR(htfBars, 14, true);
    const atr = htfATR.atr || (currentPrice * 0.005);

    // ── 1b. GEX Levels (async — fetch from options chain) ──────────────────
    // Only fetch GEX once per session or every ~5 min (OI doesn't change fast).
    // For now, fetch every tick — can be cached later.
    let gexLevels: import('../types/levels.js').PriceLevel[] = [];
    let gexData: GEXData | undefined;
    try {
      const gexResult = await computeGEXLevels(ticker, currentPrice);
      if (gexResult) {
        gexLevels = gexToPriceLevels(gexResult);
        gexData = {
          callWallStrike: gexResult.callWallStrike,
          putWallStrike: gexResult.putWallStrike,
          gexZeroStrike: gexResult.gexZeroStrike,
          totalNetGEX: gexResult.totalNetGEX,
          regime: gexResult.totalNetGEX > 0 ? 'pinning' : gexResult.totalNetGEX < 0 ? 'accelerating' : 'neutral',
        };
      }
    } catch {
      // GEX is optional — continue without it
    }

    // ── 1c. Breadth Proxy (from sector ETF stream cache) ─────────────────
    let breadthData: BreadthData | undefined;
    try {
      const sectorBars = fetchSectorBarsFromStream(30);
      if (Object.keys(sectorBars).length > 0) {
        const spyBarsForBreadth = ticker === 'SPY' ? todayBars1m : [];
        // Only compute breadth if we have SPY bars (the reference)
        if (spyBarsForBreadth.length > 30) {
          const breadthResult = computeBreadthProxy(spyBarsForBreadth, sectorBars, 30);
          if (breadthResult.sectorsAvailable > 0) {
            breadthData = {
              sectorAlignment: breadthResult.sectorAlignment,
              divergingSectors: breadthResult.divergingSectors,
              confirmingSectors: breadthResult.confirmingSectors,
              cumulativeDeltaProxy: breadthResult.cumulativeDeltaProxy,
              deltaTrend: breadthResult.deltaTrend,
            };
          }
        }
      }
    } catch {
      // Breadth is optional — continue without it
    }

    // ── 2. Level Engine ──────────────────────────────────────────────────────
    const priorDayLevels = computePriorDayLevels(dailyBars, currentPrice);
    const orbResult = computeORB(ltfBars, currentPrice);
    const vwapResult = computeVWAP(todayBars1m);
    const volumeProfile = computeVolumeProfile(todayBars1m);

    // Swing points from 1-min bars for intraday levels
    const swingPoints = detectSwingPoints(todayBars1m, 3, 2, 20);
    const swingHighs = swingPoints.filter(s => s.type === 'high').map(s => s.price);
    const swingLows = swingPoints.filter(s => s.type === 'low').map(s => s.price);

    const levelOutput: LevelEngineOutput = computeLevels({
      dailyBars,
      todayBars1m,
      currentPrice,
      vwapResult,
      orbResult,
      volumeProfile,
      swingHighs,
      swingLows,
      gexLevels,
    });

    // Update level cache (tracks freshness, touch count across ticks)
    const cache = getLevelCache(ticker);
    const trackedLevels = cache.updateLevels(levelOutput.allLevels, currentPrice, atr);

    // ── 3. Structure Analysis ────────────────────────────────────────────────
    const structure = analyzeStructure(todayBars1m, trackedLevels, atr);

    // ── 4. Market Context ────────────────────────────────────────────────────
    const avgDailyATRPct = computeAvgDailyATRPct(dailyBars);
    const context = computeMarketContext(
      todayBars1m,
      priorDayLevels.pdc,
      avgDailyATRPct,
      orbResult,
      '14:30',
      breadthData,
      gexData,
    );

    // ── 5. Level Interaction Detection ───────────────────────────────────────
    const recentBars = todayBars1m.slice(-20);
    const interaction = detectLevelInteraction(recentBars, trackedLevels, atr);

    // ── 6. Setup Generation ──────────────────────────────────────────────────
    let setup = null;
    if (interaction) {
      const candidate = generateSetup(
        interaction,
        structure,
        context,
        levelOutput.nearestAbove,
        levelOutput.nearestBelow,
        atr,
        currentPrice,
      );
      // Dedup: skip if we already fired a setup at this level recently
      if (candidate && !isDuplicateSetup(ticker, candidate.level.price, candidate.level.type, Date.now())) {
        setup = candidate;
      }
    }

    // ── 7. Map to SignalPayload (pipeline compatibility) ─────────────────────
    // Direction comes from setup or structure, not DMI
    let direction: SignalDirection = 'neutral';
    if (setup) {
      direction = setup.direction;
    } else if (structure.state === 'uptrend') {
      direction = 'bullish';
    } else if (structure.state === 'downtrend') {
      direction = 'bearish';
    }

    // Map setup type to signal mode
    let signalMode: SignalPayload['signalMode'] = 'none';
    if (setup) {
      switch (setup.type) {
        case 'level_rejection': signalMode = 'range'; break;
        case 'failed_breakout': signalMode = 'range'; break;
        case 'breakout_acceptance': signalMode = 'breakout'; break;
        case 'vwap_mean_reversion': signalMode = 'vwap_reversion'; break;
      }
    } else if (structure.state === 'uptrend' || structure.state === 'downtrend') {
      signalMode = 'trend';
    }

    // Still compute TF indicators for downstream compatibility (decision orchestrator, order agent)
    const tfIndicators: TimeframeIndicators[] = [
      computeTimeframeIndicators(ltfBars, ltf, direction, true),
      computeTimeframeIndicators(mtfBars, mtf, direction, false),
      computeTimeframeIndicators(htfBars, htf, direction, false),
    ];

    // Alignment: based on structure, not DMI
    let alignment: AlignmentType = 'mixed';
    if (setup) alignment = 'all_aligned'; // setup implies alignment
    else if (structure.state === 'uptrend' && direction === 'bullish') alignment = 'htf_mtf_aligned';
    else if (structure.state === 'downtrend' && direction === 'bearish') alignment = 'htf_mtf_aligned';

    // Strength from level + structure (0-100)
    let strengthScore = 0;
    if (setup) {
      strengthScore = Math.min(100, Math.round(
        (setup.level.strength * 15) +
        (setup.riskReward > 2 ? 25 : setup.riskReward * 12) +
        (structure.state !== 'undetermined' ? 20 : 0) +
        (context.dayType !== 'undetermined' ? 15 : 0)
      ));
    }

    const atm = Math.round(currentPrice);

    const levelData: LevelSignalData = {
      allLevels: trackedLevels,
      nearestAbove: levelOutput.nearestAbove,
      nearestBelow: levelOutput.nearestBelow,
      activeInteraction: interaction,
      structure,
      context,
      volumeProfile,
      setup,
    };

    const signal: SignalPayload & { levelData: LevelSignalData } = {
      id: uuidv4(),
      ticker,
      profile,
      timeframes: tfIndicators,
      ltf, mtf, htf,
      direction,
      alignment,
      currentPrice,
      atr,
      atm,
      strengthScore,
      priorDayLevels,
      orb: orbResult,
      signalMode,
      rangeSupport: setup?.type === 'level_rejection'
        ? levelOutput.nearestBelow[0]?.price
        : undefined,
      rangeResistance: setup?.type === 'level_rejection'
        ? levelOutput.nearestAbove[0]?.price
        : undefined,
      breakoutLevel: setup?.type === 'breakout_acceptance'
        ? setup.level.price
        : undefined,
      vwapReversionTarget: setup?.type === 'vwap_mean_reversion'
        ? vwapResult.vwap
        : undefined,
      vwapDistance: vwapResult.priceVsVwap !== 0
        ? Math.abs(vwapResult.priceVsVwap)
        : undefined,
      triggeredBy: trigger,
      sessionId,
      createdAt: new Date().toISOString(),
      levelData,
    };

    console.log(
      `[LevelSignalAgent] ${ticker} | price=$${currentPrice.toFixed(2)} | ` +
      `levels=${trackedLevels.length} | structure=${structure.state} | ` +
      `dayType=${context.dayType} | ` +
      `interaction=${interaction?.interaction ?? 'none'} at ${interaction?.level.label ?? '-'} | ` +
      `setup=${setup?.type ?? 'none'} ${setup?.direction ?? ''} | ` +
      `R:R=${setup?.riskReward.toFixed(1) ?? '-'}` +
      (gexData ? ` | GEX=${gexData.regime} cw=$${gexData.callWallStrike} pw=$${gexData.putWallStrike}` : '') +
      (breadthData ? ` | breadth=${breadthData.sectorAlignment.toFixed(2)} delta=${breadthData.deltaTrend}` : '')
    );

    return signal;
  }
}
