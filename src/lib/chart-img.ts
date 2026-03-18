/**
 * chart-img.com integration — generates TradingView chart images via API.
 * Used to attach charts to Telegram notifications on trading events.
 *
 * Failures are always swallowed so they never break the trading system.
 */

const CHART_IMG_BASE = 'https://api.chart-img.com';
const CHART_IMG_API_KEY = 'Y7j6O6Hfkw5dDGeSsDosl6UnUB8fgkE74wAaVzp5';

export interface ChartOptions {
  /** Underlying ticker, e.g. "SPY", "MSFT" */
  ticker: string;
  /** TradingView interval — default "5m" (5 min) */
  interval?: string;
  /** Image width in px (default 800) */
  width?: number;
  /** Image height in px (default 600) */
  height?: number;
}

/**
 * Fetch a TradingView chart PNG from chart-img.com with DI+/-, VWAP, OBV indicators.
 * Returns the image as a Buffer, or null if anything goes wrong.
 */
// Map tickers to their TradingView exchange prefix
const EXCHANGE_PREFIX: Record<string, string> = {
  SPY: 'AMEX',
};

export async function fetchChartImage(opts: ChartOptions): Promise<Buffer | null> {
  try {
    const exchange = EXCHANGE_PREFIX[opts.ticker] ?? 'NASDAQ';
    const symbol = `${exchange}:${opts.ticker}`;
    const interval = opts.interval ?? '5m';
    const width = opts.width ?? 800;
    const height = opts.height ?? 600;

    const params = new URLSearchParams();
    params.append('symbol', symbol);
    params.append('interval', interval);
    params.append('width', String(width));
    params.append('height', String(height));
    params.append('theme', 'dark');
    params.append('format', 'png');
    // DI+/DI-/ADX
    params.append('studies', 'Average Directional Index');
    // VWAP
    params.append('studies', 'VWAP');
    // OBV
    params.append('studies', 'On Balance Volume');

    const url = `${CHART_IMG_BASE}/v1/tradingview/advanced-chart?${params.toString()}`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${CHART_IMG_API_KEY}`,
      },
      signal: AbortSignal.timeout(15_000), // 15s timeout
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[ChartImg] HTTP ${res.status} for ${opts.ticker}: ${body.slice(0, 200)}`);
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('image')) {
      console.warn(`[ChartImg] Unexpected content-type "${contentType}" for ${opts.ticker}`);
      return null;
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    console.warn(`[ChartImg] Error fetching chart for ${opts.ticker}:`, (err as Error).message);
    return null;
  }
}
