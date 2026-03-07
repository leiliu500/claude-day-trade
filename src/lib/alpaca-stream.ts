/**
 * AlpacaStreamManager — Singleton managing two persistent WebSocket connections:
 *
 *  1. Data stream  (wss://stream.data.alpaca.markets/v2/iex)
 *     Subscribes to 1-minute bars for all watched tickers.
 *     Maintains an in-memory ring buffer of 1-min OHLCVBar per ticker.
 *     getBars() derives any N-minute aggregation on demand.
 *
 *  2. Trading stream (wss based on ALPACA_BASE_URL)
 *     Subscribes to trade_updates — emits fill events immediately
 *     so OrderAgents detect fills without polling.
 *
 * Both streams auto-reconnect with exponential backoff.
 * getBars() returns null when cache is empty or stale so callers
 * fall back to the Alpaca REST API transparently.
 */

import { EventEmitter } from 'events';
import { config } from '../config.js';
import type { OHLCVBar, Timeframe } from '../types/market.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** 1-min bars to keep per ticker — 800 covers ~2 full regular-session trading days (390 bars each) */
const BAR_CACHE_SIZE = 800;

/** Cache is stale when newest bar is older than this many seconds.
 *  90 s allows one missed bar before falling back to REST. */
const STALENESS_THRESHOLD_S = 90;

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

// ── Internal types ────────────────────────────────────────────────────────────

interface AlpacaStreamBar {
  T: 'b';
  S: string;
  o: number; h: number; l: number; c: number;
  v: number;
  vw?: number;
  t: string;
}

interface AlpacaStreamQuote {
  T: 'q';
  S: string;
  bp: number; // bid price
  ap: number; // ask price
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

  // Tickers subscribed on the data stream
  private readonly subscribedTickers = new Set<string>();

  // Order ID → fill callback for trading stream
  private readonly orderCallbacks = new Map<string, FillCallback>();

  // Option symbol → mid-price callback for real-time stop/TP monitoring
  private readonly optionQuoteCallbacks  = new Map<string, PriceCallback>();
  private readonly subscribedOptionSymbols = new Set<string>();

  // WebSocket handles
  private dataWs: WebSocket | null = null;
  private tradingWs: WebSocket | null = null;

  // Reconnect state
  private dataReconnectMs    = MIN_RECONNECT_MS;
  private tradingReconnectMs = MIN_RECONNECT_MS;
  private dataReconnectTimer:    ReturnType<typeof setTimeout> | null = null;
  private tradingReconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
   *  - newest cached bar is older than STALENESS_THRESHOLD_S
   *  - cache has fewer than minBars after aggregation
   *  - timeframe is 1h or 1d (derived from too few bars — use REST)
   */
  getBars(ticker: string, timeframe: Timeframe, minBars: number): OHLCVBar[] | null {
    // 1h and 1d require too much history to derive from 1-min cache
    if (timeframe === '1h' || timeframe === '1d') return null;

    const ones = this.barCache.get(ticker);
    if (!ones || ones.length === 0) return null;

    // Staleness check
    const latest = ones[ones.length - 1]!;
    const ageS = (Date.now() - new Date(latest.timestamp).getTime()) / 1_000;
    if (ageS > STALENESS_THRESHOLD_S) return null;

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
   * Subscribe to real-time mid-price updates for an option symbol.
   * The callback fires on every quote update (bid/ask change) from the data stream.
   * Used by OrderAgents after fill to detect stop/TP breaches immediately.
   */
  watchOptionQuote(symbol: string, callback: PriceCallback): void {
    this.optionQuoteCallbacks.set(symbol, callback);
    this.subscribedOptionSymbols.add(symbol);
    this._subscribeOptionSymbols([symbol]);
  }

  unwatchOptionQuote(symbol: string): void {
    this.optionQuoteCallbacks.delete(symbol);
    this.subscribedOptionSymbols.delete(symbol);
    if (this.dataWs?.readyState === WebSocket.OPEN) {
      this.dataWs.send(JSON.stringify({ action: 'unsubscribe', quotes: [symbol] }));
    }
  }

  /** Graceful shutdown */
  disconnect(): void {
    if (this.dataReconnectTimer)    { clearTimeout(this.dataReconnectTimer);    this.dataReconnectTimer    = null; }
    if (this.tradingReconnectTimer) { clearTimeout(this.tradingReconnectTimer); this.tradingReconnectTimer = null; }
    this.dataWs?.close();
    this.tradingWs?.close();
    this.dataWs    = null;
    this.tradingWs = null;
    this.started   = false;
    this.optionQuoteCallbacks.clear();
    this.subscribedOptionSymbols.clear();
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
      console.log('[AlpacaStream/data] Connected — authenticating');
      this.dataWs!.send(JSON.stringify({
        action: 'auth',
        key:    config.ALPACA_API_KEY,
        secret: config.ALPACA_SECRET_KEY,
      }));
    };

    this.dataWs.onmessage = (ev) => this._handleDataMessage(String(ev.data));

    this.dataWs.onerror = () => {
      console.error('[AlpacaStream/data] WebSocket error');
    };

    this.dataWs.onclose = () => {
      console.warn('[AlpacaStream/data] Connection closed — will reconnect');
      this.dataWs = null;
      this._scheduleDataReconnect();
    };
  }

  private _handleDataMessage(raw: string): void {
    let msgs: unknown[];
    try { msgs = JSON.parse(raw) as unknown[]; }
    catch { return; }

    for (const m of msgs) {
      const obj = m as Record<string, unknown>;
      const T = obj['T'] as string | undefined;

      if (T === 'success' && obj['msg'] === 'authenticated') {
        console.log('[AlpacaStream/data] Authenticated — subscribing bars');
        this._subscribeDataTickers([...this.subscribedTickers]);
        if (this.subscribedOptionSymbols.size > 0) {
          this._subscribeOptionSymbols([...this.subscribedOptionSymbols]);
        }
        continue;
      }

      if (T === 'subscription') {
        console.log('[AlpacaStream/data] Subscription confirmed:', JSON.stringify(obj['bars']));
        continue;
      }

      if (T === 'b') {
        this._ingestBar(m as unknown as AlpacaStreamBar);
      }

      if (T === 'q') {
        this._handleQuote(m as unknown as AlpacaStreamQuote);
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
      this.dataWs.send(JSON.stringify({ action: 'subscribe', bars: toSubscribe }));
      console.log(`[AlpacaStream/data] Subscribed bars: ${toSubscribe.join(',')}`);
    }
  }

  private _subscribeOptionSymbols(symbols: string[]): void {
    if (symbols.length === 0) return;
    if (this.dataWs?.readyState === WebSocket.OPEN) {
      this.dataWs.send(JSON.stringify({ action: 'subscribe', quotes: symbols }));
      console.log(`[AlpacaStream/data] Subscribed option quotes: ${symbols.join(',')}`);
    }
  }

  private _handleQuote(quote: AlpacaStreamQuote): void {
    const cb = this.optionQuoteCallbacks.get(quote.S);
    if (!cb) return;
    const mid = (quote.bp + quote.ap) / 2;
    if (mid > 0) cb(mid);
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
    const delay = this.dataReconnectMs;
    console.log(`[AlpacaStream/data] Reconnecting in ${delay}ms`);
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
      console.log('[AlpacaStream/trading] Connected — authenticating');
      this.tradingWs!.send(JSON.stringify({
        action: 'auth',
        key:    config.ALPACA_API_KEY,
        secret: config.ALPACA_SECRET_KEY,
      }));
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
      console.warn('[AlpacaStream/trading] Connection closed — will reconnect');
      this.tradingWs = null;
      this._scheduleTradingReconnect();
    };
  }

  private _handleTradingMessage(raw: string): void {
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
    const delay = this.tradingReconnectMs;
    console.log(`[AlpacaStream/trading] Reconnecting in ${delay}ms`);
    this.tradingReconnectTimer = setTimeout(() => {
      this.tradingReconnectTimer = null;
      this._connectTrading();
    }, delay);
    this.tradingReconnectMs = Math.min(this.tradingReconnectMs * 2, MAX_RECONNECT_MS);
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
