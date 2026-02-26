export type Timeframe = '1m' | '2m' | '3m' | '5m' | '15m' | '1h' | '1d';
export type TradingProfile = 'S' | 'M' | 'L';

export const PROFILE_TIMEFRAMES: Record<TradingProfile, [Timeframe, Timeframe, Timeframe]> = {
  S: ['2m', '3m', '5m'],   // Scalp — LTF, MTF, HTF
  M: ['1m', '5m', '15m'],  // Medium
  L: ['5m', '1h', '1d'],   // Long / swing
};

export interface OHLCVBar {
  timestamp: string;  // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}

// Alpaca bar response shape
export interface AlpacaBarsResponse {
  bars: Array<{
    t: string;   // timestamp
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    vw?: number;
  }>;
  symbol: string;
  next_page_token?: string;
}

export function normalizeAlpacaBars(response: AlpacaBarsResponse): OHLCVBar[] {
  return (response.bars ?? []).map(b => ({
    timestamp: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
    vwap: b.vw,
  }));
}
