/**
 * AlpacaStreamManager — Singleton managing two persistent WebSocket connections
 * plus one REST-polling loop for option quotes:
 *
 *  1. Data stream  (wss://stream.data.alpaca.markets/v2/sip)
 *     Subscribes to 1-minute bars, trades, and quotes for all watched tickers.
 *     Maintains an in-memory ring buffer of 1-min OHLCVBar per ticker.
 *     getBars() derives any N-minute aggregation on demand.
 *     Trades + quotes feed the order flow engine:
 *       - Latest NBBO per ticker for trade classification (quote rule)
 *       - Classified trade ring buffer (5-min TTL) for imbalance computation
 *       - Session volume profile for support/resistance identification
 *     getOrderFlow() computes imbalance, intensity, and volume profile on demand.
 *
 *  2. Option quote poll (REST OPRA snapshot, every OPTION_POLL_MS)
 *     Alpaca's option WebSocket stream requires a separate subscription (402).
 *     Polls the REST snapshot API every 1s for all currently-watched option symbols.
 *     Caches the latest mid-price per symbol; fires watchOptionQuote callbacks.
 *     getOptionMid() returns the latest cached mid instantly.
 *     Poll starts on first watchOptionQuote call; stops when all are unwatched.
 *
 *  3. Trading stream (wss based on ALPACA_BASE_URL)
 *     Subscribes to trade_updates — emits fill events immediately
 *     so OrderAgents detect fills without polling.
 *
 * Both WebSocket streams auto-reconnect with exponential backoff.
 * getBars() / getOptionMid() / getOrderFlow() return null when cache is absent
 * so callers fall back to the Alpaca REST API transparently.
 */

import { EventEmitter } from 'events';
import { config } from '../config.js';
import type { OHLCVBar, Timeframe } from '../types/market.js';
import type { OrderFlowResult } from '../types/indicators.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** 1-min bars to keep per ticker — 800 covers ~2 full regular-session trading days (390 bars each) */
const BAR_CACHE_SIZE = 800;

/** Cache is stale when newest bar is older than this many seconds.
 *  90 s allows one missed bar before falling back to REST. */
const STALENESS_THRESHOLD_S = 90;

const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5_000;

/** Ping interval to detect dead connections (ms) */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** How long to wait for a pong before declaring connection dead (ms) */
const PONG_TIMEOUT_MS = 5_000;

/** How often to poll option snapshots for all watched symbols (ms) */
const OPTION_POLL_MS = 1_000;

/** Max age (ms) for trades in the order flow ring buffer */
const TRADE_BUFFER_TTL_MS = 5 * 60_000; // 5 minutes

/** Volume profile bucket size in dollars */
const VP_BUCKET_SIZE = 0.01;

/** Minimum absolute imbalance to classify as buying/selling (vs neutral) */
const FLOW_DIRECTION_THRESHOLD = 0.15;

// ── Internal types ────────────────────────────────────────────────────────────

interface AlpacaStreamBar {
  T: 'b';
  S: string;
  o: number; h: number; l: number; c: number;
  v: number;
  vw?: number;
  t: string;
}

interface AlpacaStreamTrade {
  T: 't';
  S: string;   // symbol
  p: number;   // price
  s: number;   // size
  t: string;   // timestamp (RFC 3339)
  x: string;   // exchange
  c?: string[]; // conditions
}

interface AlpacaStreamQuote {
  T: 'q';
  S: string;   // symbol
  bp: number;  // bid price
  bs: number;  // bid size
  ap: number;  // ask price
  as: number;  // ask size
  t: string;   // timestamp
}

/** Classified trade stored in the ring buffer */
interface ClassifiedTrade {
  ts: number;    // epoch ms
  price: number;
  size: number;
  side: 'buy' | 'sell';
}

/** Latest NBBO state per ticker */
interface NBBOState {
  bid: number;
  ask: number;
  midpoint: number;
}

/** Session volume profile bucket */
interface VolumeProfileBucket {
  price: number;   // bucketed price
  volume: number;  // total volume at this price
}


export interface TradeUpdateEvent {
  event: string;
  order: {
    id: string;
    status: string;
    filled_qty: string;
    filled_avg_price: string | null;
    filled_at: string | null;
  };
}

type FillCallback  = (event: TradeUpdateEvent) => void;
type PriceCallback = (midPrice: number) => void;

// ── AlpacaStreamManager ───────────────────────────────────────────────────────

export class AlpacaStreamManager extends EventEmitter {
  private static instance: AlpacaStreamManager | null = null;

  // 1-min bar ring buffer per ticker
  private readonly barCache = new Map<string, OHLCVBar[]>();

  // Order flow: classified trades ring buffer per ticker (5-min TTL)
  private readonly tradeBuffer = new Map<string, ClassifiedTrade[]>();

  // Order flow: latest NBBO per ticker (for trade classification)
  private readonly nbboCache = new Map<string, NBBOState>();

  // Order flow: session volume profile per ticker (reset on connect)
  private readonly volumeProfile = new Map<string, Map<number, number>>();

  // Tickers subscribed on the data stream
  private readonly subscribedTickers = new Set<string>();

  // Order ID → fill callback for trading stream
  private readonly orderCallbacks = new Map<string, FillCallback>();

  // Option symbol → mid-price callback for real-time stop/TP monitoring
  private readonly optionQuoteCallbacks   = new Map<string, PriceCallback>();
  private readonly subscribedOptionSymbols = new Set<string>();

  // Latest (bid+ask)/2 cache per option symbol — updated on every quote message
  private readonly optionMidCache = new Map<string, number>();

  // WebSocket handles
  private dataWs:    WebSocket | null = null;
  private tradingWs: WebSocket | null = null;

  // Reconnect state
  private dataReconnectMs    = MIN_RECONNECT_MS;
  private tradingReconnectMs = MIN_RECONNECT_MS;
  private dataReconnectTimer:    ReturnType<typeof setTimeout> | null = null;
  private tradingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dataReconnectAttempt    = 0; // 0 = immediate retry
  private tradingReconnectAttempt = 0;

  // Heartbeat: activity-based dead connection detection
  private dataHeartbeatTimer:    ReturnType<typeof setInterval> | null = null;
  private tradingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private dataLastMessageAt    = 0;
  private tradingLastMessageAt = 0;

  private started = false;

  private constructor() { super(); }

  static getInstance(): AlpacaStreamManager {
    AlpacaStreamManager.instance ??= new AlpacaStreamManager();
    return AlpacaStreamManager.instance;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Open both WebSocket connections. Safe to call multiple times. */
  connect(tickers: string[]): void {
    if (this.started) {
      this._subscribeDataTickers(tickers);
      return;
    }
    this.started = true;
    for (const t of tickers) this.subscribedTickers.add(t);
    this._connectData();
    this._connectTrading();
    console.log(`[AlpacaStream] Connecting — tickers: ${tickers.join(',')}`);
  }

  /**
   * Return aggregated N-minute bars from the 1-min cache, or null when:
   *  - cache is empty / not yet populated
   *  - cache has fewer than minBars after aggregation
   *  - timeframe is 1h or 1d (derived from too few bars — use REST)
   *
   * The cache is used even when the newest bar is stale (stream hiccup).
   * A brief SIP disconnection does not invalidate the accumulated bar
   * history — falling back to REST would swap the entire bar window and
   * cause indicator discontinuities (ADX jumps, confidence spikes).
   * Staleness is logged as a warning so we know the stream dropped.
   */
  getBars(ticker: string, timeframe: Timeframe, minBars: number): OHLCVBar[] | null {
    // 1h and 1d require too much history to derive from 1-min cache
    if (timeframe === '1h' || timeframe === '1d') return null;

    const ones = this.barCache.get(ticker);
    if (!ones || ones.length === 0) return null;

    // Log staleness as a warning — but still use the cache
    const latest = ones[ones.length - 1]!;
    const ageS = (Date.now() - new Date(latest.timestamp).getTime()) / 1_000;
    if (ageS > STALENESS_THRESHOLD_S) {
      console.warn(`[AlpacaStream] ${ticker} cache stale (${Math.round(ageS)}s) — using cached bars (${ones.length} bars)`);
    }

    const aggregated = this._aggregate(ones, timeframe);
    if (aggregated.length < minBars) return null;

    return aggregated;
  }

  /**
   * Purge all cached 1-min bars for all tickers.
   * Returns summary of what was cleared. The cache repopulates automatically
   * as new bars arrive from the stream.
   */
  purgeCache(): { tickers: string[]; barsRemoved: number } {
    const tickers = [...this.barCache.keys()];
    const barsRemoved = tickers.reduce((sum, t) => sum + (this.barCache.get(t)?.length ?? 0), 0);
    this.barCache.clear();
    console.log(`[AlpacaStream] Cache purged — ${barsRemoved} bars removed across ${tickers.length} ticker(s): ${tickers.join(',')}`);
    return { tickers, barsRemoved };
  }

  /** True when the data stream is authenticated and delivering bars. */
  isDataStreamLive(): boolean {
    return this.dataWs !== null && this.dataWs.readyState === WebSocket.OPEN;
  }

  /**
   * Register a fill callback for an Alpaca order ID.
   * Automatically removed after fill / cancel / reject.
   */
  watchOrder(orderId: string, callback: FillCallback): void {
    this.orderCallbacks.set(orderId, callback);
  }

  unwatchOrder(orderId: string): void {
    this.orderCallbacks.delete(orderId);
  }

  /**
   * Subscribe to mid-price updates for an option symbol via the poll loop.
   * The callback fires every OPTION_POLL_MS with the latest (bid+ask)/2.
   * Used by OrderAgents after fill to detect stop/TP breaches.
   */
  watchOptionQuote(symbol: string, callback: PriceCallback): void {
    this.optionQuoteCallbacks.set(symbol, callback);
    this.subscribedOptionSymbols.add(symbol);
    this._startOptionPoll();
  }

  unwatchOptionQuote(symbol: string): void {
    this.optionQuoteCallbacks.delete(symbol);
    this.subscribedOptionSymbols.delete(symbol);
    this.optionMidCache.delete(symbol);
    if (this.subscribedOptionSymbols.size === 0) this._stopOptionPoll();
  }

  /**
   * Return the latest cached mid-price (bid+ask)/2 for an option symbol,
   * or null when no quote has been received yet from the options stream.
   * Callers should fall back to REST when null is returned.
   */
  getOptionMid(symbol: string): number | null {
    return this.optionMidCache.get(symbol) ?? null;
  }

  /** Graceful shutdown */
  disconnect(): void {
    if (this.dataReconnectTimer)    { clearTimeout(this.dataReconnectTimer);    this.dataReconnectTimer    = null; }
    if (this.tradingReconnectTimer) { clearTimeout(this.tradingReconnectTimer); this.tradingReconnectTimer = null; }
    this._stopDataHeartbeat();
    this._stopTradingHeartbeat();
    this._stopOptionPoll();
    this.dataWs?.close();
    this.tradingWs?.close();
    this.dataWs    = null;
    this.tradingWs = null;
    this.started   = false;
    this.optionQuoteCallbacks.clear();
    this.subscribedOptionSymbols.clear();
    this.optionMidCache.clear();
    this.tradeBuffer.clear();
    this.nbboCache.clear();
    this.volumeProfile.clear();
    console.log('[AlpacaStream] Disconnected');
  }

  // ── Data stream ─────────────────────────────────────────────────────────────

  private _connectData(): void {
    const url = 'wss://stream.data.alpaca.markets/v2/sip'; // SIP consolidated tape (Algo Trader Plus)
    try {
      this.dataWs = new WebSocket(url);
    } catch (err) {
      console.error('[AlpacaStream/data] WebSocket error:', (err as Error).message);
      this._scheduleDataReconnect();
      return;
    }

    this.dataWs.onopen = () => {
      this.dataReconnectMs = MIN_RECONNECT_MS;
      this.dataReconnectAttempt = 0;
      console.log('[AlpacaStream/data] Connected — authenticating');
      this.dataWs!.send(JSON.stringify({
        action: 'auth',
        key:    config.ALPACA_API_KEY,
        secret: config.ALPACA_SECRET_KEY,
      }));
      this._startDataHeartbeat();
    };

    this.dataWs.onmessage = (ev) => this._handleDataMessage(String(ev.data));

    this.dataWs.onerror = () => {
      console.error('[AlpacaStream/data] WebSocket error');
    };

    this.dataWs.onclose = () => {
      this._stopDataHeartbeat();
      console.warn('[AlpacaStream/data] Connection closed — will reconnect');
      this.dataWs = null;
      this.emit('stream_down', 'data');
      this._scheduleDataReconnect();
    };
  }

  private _handleDataMessage(raw: string): void {
    this.dataLastMessageAt = Date.now();
    let msgs: unknown[];
    try { msgs = JSON.parse(raw) as unknown[]; }
    catch { return; }

    for (const m of msgs) {
      const obj = m as Record<string, unknown>;
      const T = obj['T'] as string | undefined;

      if (T === 'success' && obj['msg'] === 'authenticated') {
        console.log('[AlpacaStream/data] Authenticated — subscribing bars');
        this._subscribeDataTickers([...this.subscribedTickers]);
        this.emit('stream_up', 'data');
        // Re-seed historical bars to fill any gap from the disconnect
        void this.seedHistoricalBars([...this.subscribedTickers]);
        continue;
      }

      if (T === 'subscription') {
        console.log('[AlpacaStream/data] Subscription confirmed:', JSON.stringify(obj['bars']));
        continue;
      }

      if (T === 'b') {
        this._ingestBar(m as unknown as AlpacaStreamBar);
      }

      if (T === 't') {
        this._ingestTrade(m as unknown as AlpacaStreamTrade);
      }

      if (T === 'q') {
        this._ingestQuote(m as unknown as AlpacaStreamQuote);
      }

      if (T === 'error') {
        console.error('[AlpacaStream/data] Stream error:', obj['msg']);
      }
    }
  }

  private _subscribeDataTickers(tickers: string[]): void {
    const toSubscribe = tickers.filter(t => this.subscribedTickers.has(t) ? true : (this.subscribedTickers.add(t), true));
    if (toSubscribe.length === 0) return;
    if (this.dataWs?.readyState === WebSocket.OPEN) {
      this.dataWs.send(JSON.stringify({
        action: 'subscribe',
        bars: toSubscribe,
        trades: toSubscribe,
        quotes: toSubscribe,
      }));
      console.log(`[AlpacaStream/data] Subscribed bars+trades+quotes: ${toSubscribe.join(',')}`);
    }
  }

  // ── Option quote polling ─────────────────────────────────────────────────────
  // Alpaca has no WebSocket endpoint for option quotes — we poll the snapshot API.

  private optionPollTimer: ReturnType<typeof setInterval> | null = null;
  private optionPollInFlight = false;

  private _startOptionPoll(): void {
    if (this.optionPollTimer) return;
    void this._pollOptionQuotes(); // immediate first fire
    this.optionPollTimer = setInterval(() => void this._pollOptionQuotes(), OPTION_POLL_MS);
    console.log('[AlpacaStream/options] Quote polling started');
  }

  private _stopOptionPoll(): void {
    if (!this.optionPollTimer) return;
    clearInterval(this.optionPollTimer);
    this.optionPollTimer = null;
    console.log('[AlpacaStream/options] Quote polling stopped');
  }

  private async _pollOptionQuotes(): Promise<void> {
    if (this.optionPollInFlight || this.subscribedOptionSymbols.size === 0) return;
    this.optionPollInFlight = true;
    try {
      const symbols = [...this.subscribedOptionSymbols];
      const snapshots = await this._fetchOptionSnapshots(symbols);
      for (const [sym, snap] of Object.entries(snapshots)) {
        // Skip symbols that were unwatched while the REST fetch was in-flight
        // to avoid poisoning the cache with stale values after unwatchOptionQuote()
        if (!this.subscribedOptionSymbols.has(sym)) continue;
        const bid = snap?.latestQuote?.bp ?? 0;
        const ask = snap?.latestQuote?.ap ?? 0;
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
        if (mid > 0) {
          this.optionMidCache.set(sym, mid);
          this.optionQuoteCallbacks.get(sym)?.(mid);
        }
      }
    } catch {
      // swallow — next interval will retry
    } finally {
      this.optionPollInFlight = false;
    }
  }

  private async _fetchOptionSnapshots(
    symbols: string[],
  ): Promise<Record<string, { latestQuote?: { bp?: number; ap?: number } }>> {
    const url = new URL(`${config.ALPACA_DATA_URL}/v1beta1/options/snapshots`);
    url.searchParams.set('symbols', symbols.join(','));
    url.searchParams.set('feed', 'opra');
    const res = await fetch(url.toString(), {
      headers: {
        'APCA-API-KEY-ID':     config.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return {};
    const data = await res.json() as {
      snapshots?: Record<string, { latestQuote?: { bp?: number; ap?: number } }>;
    };
    return data.snapshots ?? {};
  }

  private _ingestBar(bar: AlpacaStreamBar): void {
    const ohlcv: OHLCVBar = {
      timestamp: bar.t,
      open:      bar.o,
      high:      bar.h,
      low:       bar.l,
      close:     bar.c,
      volume:    bar.v,
      vwap:      bar.vw,
    };

    // Drop pre-market / after-hours bars — regular session only (9:30–16:00 ET)
    if (!this._isRegularSession(ohlcv.timestamp)) return;

    let cache = this.barCache.get(bar.S);
    if (!cache) { cache = []; this.barCache.set(bar.S, cache); }

    // Deduplicate by timestamp
    if (cache.length > 0 && cache[cache.length - 1]!.timestamp === ohlcv.timestamp) return;

    cache.push(ohlcv);
    if (cache.length > BAR_CACHE_SIZE) cache.splice(0, cache.length - BAR_CACHE_SIZE);

    this.emit('bar', bar.S, ohlcv);
    console.log(`[AlpacaStream] 1m bar: ${bar.S} c=$${bar.c} t=${bar.t}`);
  }

  // ── Trade / Quote ingestion (order flow) ────────────────────────────────────

  private _ingestQuote(quote: AlpacaStreamQuote): void {
    if (quote.bp <= 0 || quote.ap <= 0) return;
    this.nbboCache.set(quote.S, {
      bid: quote.bp,
      ask: quote.ap,
      midpoint: (quote.bp + quote.ap) / 2,
    });
  }

  private _ingestTrade(trade: AlpacaStreamTrade): void {
    const nbbo = this.nbboCache.get(trade.S);
    if (!nbbo) return; // can't classify without NBBO

    // Classify using quote rule: trade at or above midpoint = buy-initiated
    const side: 'buy' | 'sell' = trade.p >= nbbo.midpoint ? 'buy' : 'sell';
    const ts = new Date(trade.t).getTime();

    const classified: ClassifiedTrade = {
      ts,
      price: trade.p,
      size: trade.s,
      side,
    };

    // Append to ring buffer
    let buffer = this.tradeBuffer.get(trade.S);
    if (!buffer) { buffer = []; this.tradeBuffer.set(trade.S, buffer); }
    buffer.push(classified);

    // Update session volume profile
    let vp = this.volumeProfile.get(trade.S);
    if (!vp) { vp = new Map(); this.volumeProfile.set(trade.S, vp); }
    const bucket = Math.round(trade.p / VP_BUCKET_SIZE) * VP_BUCKET_SIZE;
    vp.set(bucket, (vp.get(bucket) ?? 0) + trade.s);

    // Prune expired trades (only every ~1000 trades to avoid overhead)
    if (buffer.length % 1000 === 0) {
      this._pruneTradeBuffer(trade.S, ts);
    }
  }

  private _pruneTradeBuffer(ticker: string, now: number): void {
    const buffer = this.tradeBuffer.get(ticker);
    if (!buffer) return;
    const cutoff = now - TRADE_BUFFER_TTL_MS;
    const firstValid = buffer.findIndex(t => t.ts >= cutoff);
    if (firstValid > 0) buffer.splice(0, firstValid);
  }

  /**
   * Compute order flow metrics on demand from the trade ring buffer.
   * Returns null when there's insufficient data (no trades or no NBBO yet).
   */
  getOrderFlow(ticker: string): OrderFlowResult | null {
    const buffer = this.tradeBuffer.get(ticker);
    if (!buffer || buffer.length === 0) return null;
    if (!this.nbboCache.has(ticker)) return null;

    const now = Date.now();
    const cutoff5m = now - 5 * 60_000;
    const cutoff1m = now - 60_000;
    const cutoff30s = now - 30_000;

    // Filter to trades within 5-min window (prune stale while we're at it)
    const firstValid = buffer.findIndex(t => t.ts >= cutoff5m);
    if (firstValid > 0) buffer.splice(0, firstValid);
    if (buffer.length === 0) return null;

    // Compute imbalances for each window
    let buy5m = 0, sell5m = 0;
    let buy1m = 0, sell1m = 0;
    let buy30s = 0, sell30s = 0;
    let trades30s = 0, vol30s = 0;

    for (const t of buffer) {
      if (t.side === 'buy') buy5m += t.size; else sell5m += t.size;
      if (t.ts >= cutoff1m) {
        if (t.side === 'buy') buy1m += t.size; else sell1m += t.size;
      }
      if (t.ts >= cutoff30s) {
        if (t.side === 'buy') buy30s += t.size; else sell30s += t.size;
        trades30s++;
        vol30s += t.size;
      }
    }

    const total5m = buy5m + sell5m;
    const total1m = buy1m + sell1m;
    const total30s = buy30s + sell30s;

    const imbalance5m = total5m > 0 ? (buy5m - sell5m) / total5m : 0;
    const imbalance1m = total1m > 0 ? (buy1m - sell1m) / total1m : 0;
    const imbalance30s = total30s > 0 ? (buy30s - sell30s) / total30s : 0;

    // Trade intensity (30s window)
    const elapsed30s = Math.max(1, (now - cutoff30s) / 1000);
    const tradesPerSecond = trades30s / elapsed30s;
    const volumePerSecond = vol30s / elapsed30s;

    // Volume profile — top buckets from session profile
    const vp = this.volumeProfile.get(ticker);
    let volumeProfileArr: { price: number; volume: number }[] = [];
    let highVolumeNode = 0;
    let lowVolumeGap: number | null = null;

    if (vp && vp.size > 0) {
      volumeProfileArr = [...vp.entries()]
        .map(([price, volume]) => ({ price, volume }))
        .sort((a, b) => a.price - b.price);

      // High-volume node: price with max volume
      let maxVol = 0;
      for (const entry of volumeProfileArr) {
        if (entry.volume > maxVol) {
          maxVol = entry.volume;
          highVolumeNode = entry.price;
        }
      }

      // Low-volume gap: largest price gap between significant volume nodes
      // Only consider nodes with volume > 10% of max
      const threshold = maxVol * 0.10;
      const significantNodes = volumeProfileArr.filter(e => e.volume >= threshold);
      if (significantNodes.length >= 2) {
        let maxGap = 0;
        let gapMid: number | null = null;
        for (let i = 1; i < significantNodes.length; i++) {
          const gap = significantNodes[i]!.price - significantNodes[i - 1]!.price;
          if (gap > maxGap) {
            maxGap = gap;
            gapMid = (significantNodes[i]!.price + significantNodes[i - 1]!.price) / 2;
          }
        }
        // Only report gaps wider than $0.10
        if (maxGap > 0.10) lowVolumeGap = gapMid;
      }

      // Trim profile to top 50 buckets by volume for payload size
      if (volumeProfileArr.length > 50) {
        volumeProfileArr.sort((a, b) => b.volume - a.volume);
        volumeProfileArr = volumeProfileArr.slice(0, 50);
        volumeProfileArr.sort((a, b) => a.price - b.price);
      }
    }

    // Flow direction from 1m imbalance
    const flowDirection: 'buying' | 'selling' | 'neutral' =
      imbalance1m > FLOW_DIRECTION_THRESHOLD ? 'buying' :
      imbalance1m < -FLOW_DIRECTION_THRESHOLD ? 'selling' : 'neutral';

    return {
      imbalance30s,
      imbalance1m,
      imbalance5m,
      buyVolume1m: buy1m,
      sellVolume1m: sell1m,
      totalVolume1m: total1m,
      tradesPerSecond,
      volumePerSecond,
      volumeProfile: volumeProfileArr,
      highVolumeNode,
      lowVolumeGap,
      flowDirection,
    };
  }

  /**
   * Fetch 2 trading days of 1-min historical bars from Alpaca REST and
   * prepend them to the cache for each ticker.  Call once at startup after
   * connect() so indicators have enough warmup data immediately.
   */
  async seedHistoricalBars(tickers: string[]): Promise<void> {
    // 4 calendar days back safely covers 2 trading days (handles weekends)
    const start = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await Promise.all(tickers.map(async (ticker) => {
      try {
        const bars = await this._fetchHistoricalOneMins(ticker, start);
        this._seedCache(ticker, bars);
        console.log(`[AlpacaStream] Seeded ${bars.length} historical 1m bars for ${ticker}`);
      } catch (err) {
        console.error(`[AlpacaStream] Failed to seed historical bars for ${ticker}:`, (err as Error).message);
      }
    }));
  }

  private async _fetchHistoricalOneMins(ticker: string, start: string): Promise<OHLCVBar[]> {
    const headers = {
      'APCA-API-KEY-ID':     config.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': config.ALPACA_SECRET_KEY,
    };
    const url = new URL(`${config.ALPACA_DATA_URL}/v2/stocks/${ticker}/bars`);
    url.searchParams.set('timeframe', '1Min');
    url.searchParams.set('start',     start);
    url.searchParams.set('limit',     '1000');
    url.searchParams.set('adjustment','raw');
    url.searchParams.set('feed',      'sip');

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Alpaca bars error ${res.status} for ${ticker}`);

    const data = await res.json() as {
      bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number; vw?: number }>;
    };
    return (data.bars ?? []).map(b => ({
      timestamp: b.t,
      open:      b.o,
      high:      b.h,
      low:       b.l,
      close:     b.c,
      volume:    b.v,
      vwap:      b.vw,
    }));
  }

  /**
   * Merge historical bars (already filtered to regular session) into the
   * cache.  Historical bars go first; any live bars already in cache are
   * kept at the end.  Trims to BAR_CACHE_SIZE (newest bars kept).
   */
  private _seedCache(ticker: string, historicalBars: OHLCVBar[]): void {
    const filtered = historicalBars.filter(b => this._isRegularSession(b.timestamp));
    if (filtered.length === 0) return;

    const existing  = this.barCache.get(ticker) ?? [];
    const existingTs = new Set(existing.map(b => b.timestamp));
    const newBars   = filtered.filter(b => !existingTs.has(b.timestamp));
    const merged    = [...newBars, ...existing];
    const trimmed   = merged.length > BAR_CACHE_SIZE
      ? merged.slice(merged.length - BAR_CACHE_SIZE)
      : merged;
    this.barCache.set(ticker, trimmed);
  }

  /**
   * Returns true when `timestamp` falls within the regular trading session
   * (9:30 AM – 3:59 PM US/Eastern, DST-aware).
   */
  private _isRegularSession(timestamp: string): boolean {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    }).formatToParts(new Date(timestamp));
    const hour   = parseInt(parts.find(p => p.type === 'hour')!.value,   10);
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    const mins   = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  }

  private _scheduleDataReconnect(): void {
    if (!this.started) return;
    this.dataReconnectAttempt++;

    // First attempt is immediate (no delay)
    if (this.dataReconnectAttempt === 1) {
      console.log('[AlpacaStream/data] Reconnecting immediately (attempt 1)');
      this._connectData();
      return;
    }

    // Subsequent attempts: exponential backoff with jitter, capped at MAX_RECONNECT_MS
    const jitter = Math.random() * 0.3 + 0.85; // 0.85–1.15x
    const delay = Math.min(Math.round(this.dataReconnectMs * jitter), MAX_RECONNECT_MS);
    console.log(`[AlpacaStream/data] Reconnecting in ${delay}ms (attempt ${this.dataReconnectAttempt})`);
    this.dataReconnectTimer = setTimeout(() => {
      this.dataReconnectTimer = null;
      this._connectData();
    }, delay);
    this.dataReconnectMs = Math.min(this.dataReconnectMs * 2, MAX_RECONNECT_MS);
  }

  // ── Trading stream ──────────────────────────────────────────────────────────

  private _connectTrading(): void {
    // Derive WSS URL from ALPACA_BASE_URL
    const wsUrl = config.ALPACA_BASE_URL
      .replace(/^https?:\/\//, (m) => (m.startsWith('https') ? 'wss://' : 'ws://'))
      + '/stream';

    try {
      this.tradingWs = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[AlpacaStream/trading] WebSocket error:', (err as Error).message);
      this._scheduleTradingReconnect();
      return;
    }

    // Alpaca trading stream sends binary WebSocket frames — use arraybuffer for sync decoding
    this.tradingWs.binaryType = 'arraybuffer';

    this.tradingWs.onopen = () => {
      this.tradingReconnectMs = MIN_RECONNECT_MS;
      this.tradingReconnectAttempt = 0;
      console.log('[AlpacaStream/trading] Connected — authenticating');
      this.tradingWs!.send(JSON.stringify({
        action: 'auth',
        key:    config.ALPACA_API_KEY,
        secret: config.ALPACA_SECRET_KEY,
      }));
      this._startTradingHeartbeat();
    };

    this.tradingWs.onmessage = (ev) => {
      const raw = ev.data instanceof ArrayBuffer
        ? new TextDecoder().decode(ev.data)
        : String(ev.data);
      this._handleTradingMessage(raw);
    };

    this.tradingWs.onerror = () => {
      console.error('[AlpacaStream/trading] WebSocket error');
    };

    this.tradingWs.onclose = () => {
      this._stopTradingHeartbeat();
      console.warn('[AlpacaStream/trading] Connection closed — will reconnect');
      this.tradingWs = null;
      this.emit('stream_down', 'trading');
      this._scheduleTradingReconnect();
    };
  }

  private _handleTradingMessage(raw: string): void {
    this.tradingLastMessageAt = Date.now();
    let msg: unknown;
    try { msg = JSON.parse(raw); }
    catch { return; }

    const m = msg as Record<string, unknown>;

    // Auth success → subscribe to trade_updates
    if (m['stream'] === 'authorization') {
      const data = m['data'] as Record<string, string> | undefined;
      if (data?.['status'] === 'authorized') {
        console.log('[AlpacaStream/trading] Authenticated — subscribing trade_updates');
        this.tradingWs!.send(JSON.stringify({
          action: 'listen',
          data: { streams: ['trade_updates'] },
        }));
        this.emit('stream_up', 'trading');
      } else {
        console.error('[AlpacaStream/trading] Auth failed:', data?.['message']);
      }
      return;
    }

    // Listening confirmation
    if (m['stream'] === 'listening') {
      console.log('[AlpacaStream/trading] Listening to:', JSON.stringify(m['data']));
      return;
    }

    // Trade update
    if (m['stream'] === 'trade_updates') {
      const data = m['data'] as TradeUpdateEvent | undefined;
      if (!data?.order?.id) return;

      const orderId = data.order.id;
      const cb = this.orderCallbacks.get(orderId);
      if (cb) {
        cb(data);
        // Remove on terminal events
        if (['fill', 'canceled', 'expired', 'rejected'].includes(data.event)) {
          this.orderCallbacks.delete(orderId);
        }
      }

      this.emit('trade_update', data);
    }
  }

  private _scheduleTradingReconnect(): void {
    if (!this.started) return;
    this.tradingReconnectAttempt++;

    // First attempt is immediate (no delay)
    if (this.tradingReconnectAttempt === 1) {
      console.log('[AlpacaStream/trading] Reconnecting immediately (attempt 1)');
      this._connectTrading();
      return;
    }

    // Subsequent attempts: exponential backoff with jitter, capped at MAX_RECONNECT_MS
    const jitter = Math.random() * 0.3 + 0.85; // 0.85–1.15x
    const delay = Math.min(Math.round(this.tradingReconnectMs * jitter), MAX_RECONNECT_MS);
    console.log(`[AlpacaStream/trading] Reconnecting in ${delay}ms (attempt ${this.tradingReconnectAttempt})`);
    this.tradingReconnectTimer = setTimeout(() => {
      this.tradingReconnectTimer = null;
      this._connectTrading();
    }, delay);
    this.tradingReconnectMs = Math.min(this.tradingReconnectMs * 2, MAX_RECONNECT_MS);
  }

  // ── Heartbeat (activity-based dead connection detection) ─────────────────────
  //
  // The SIP data stream delivers trades/quotes/bars continuously during market
  // hours, so silence for HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS means the
  // connection is dead. The trading stream is quieter, so we also check
  // readyState as a secondary signal.

  private _startDataHeartbeat(): void {
    this._stopDataHeartbeat();
    this.dataLastMessageAt = Date.now();
    this.dataHeartbeatTimer = setInterval(() => {
      if (!this.dataWs || this.dataWs.readyState !== WebSocket.OPEN) return;
      const silenceMs = Date.now() - this.dataLastMessageAt;
      if (silenceMs > HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS) {
        console.error(`[AlpacaStream/data] No message for ${Math.round(silenceMs / 1000)}s — forcing reconnect`);
        this.dataWs.close();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopDataHeartbeat(): void {
    if (this.dataHeartbeatTimer) { clearInterval(this.dataHeartbeatTimer); this.dataHeartbeatTimer = null; }
  }

  private _startTradingHeartbeat(): void {
    this._stopTradingHeartbeat();
    this.tradingLastMessageAt = Date.now();
    this.tradingHeartbeatTimer = setInterval(() => {
      if (!this.tradingWs || this.tradingWs.readyState !== WebSocket.OPEN) return;
      const silenceMs = Date.now() - this.tradingLastMessageAt;
      if (silenceMs > HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS) {
        console.error(`[AlpacaStream/trading] No message for ${Math.round(silenceMs / 1000)}s — forcing reconnect`);
        this.tradingWs.close();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopTradingHeartbeat(): void {
    if (this.tradingHeartbeatTimer) { clearInterval(this.tradingHeartbeatTimer); this.tradingHeartbeatTimer = null; }
  }

  // ── Bar aggregation ─────────────────────────────────────────────────────────

  /**
   * Aggregate 1-minute bars into N-minute bars aligned to epoch boundaries.
   * Incomplete (in-progress) buckets are excluded — only complete bars.
   */
  private _aggregate(oneMins: OHLCVBar[], timeframe: Timeframe): OHLCVBar[] {
    const n = this._tfMinutes(timeframe);
    if (n <= 1) return [...oneMins];

    const bucketMs = n * 60_000;
    const nowBucket = Math.floor(Date.now() / bucketMs) * bucketMs;

    const groups = new Map<number, OHLCVBar[]>();
    for (const bar of oneMins) {
      const ts = new Date(bar.timestamp).getTime();
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      // Exclude the currently-forming bucket (not yet complete)
      if (bucket >= nowBucket) continue;
      let g = groups.get(bucket);
      if (!g) { g = []; groups.set(bucket, g); }
      g.push(bar);
    }

    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucket, bars]) => ({
        timestamp: new Date(bucket).toISOString(),
        open:      bars[0]!.open,
        high:      Math.max(...bars.map(b => b.high)),
        low:       Math.min(...bars.map(b => b.low)),
        close:     bars[bars.length - 1]!.close,
        volume:    bars.reduce((s, b) => s + b.volume, 0),
        vwap:      (() => {
          if (!bars.some(b => b.vwap !== undefined)) return undefined;
          const totalVol = bars.reduce((s, b) => s + b.volume, 0);
          if (totalVol === 0) return undefined;
          return bars.reduce((s, b) => s + (b.vwap ?? 0) * b.volume, 0) / totalVol;
        })(),
      }));
  }

  private _tfMinutes(tf: Timeframe): number {
    switch (tf) {
      case '1m':  return 1;
      case '2m':  return 2;
      case '3m':  return 3;
      case '5m':  return 5;
      case '15m': return 15;
      default:    return 0;
    }
  }
}
