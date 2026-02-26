export interface AlpacaConfig {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  dataUrl: string;
}

export class AlpacaClient {
  private headers: Record<string, string>;

  constructor(private cfg: AlpacaConfig) {
    this.headers = {
      'APCA-API-KEY-ID': cfg.apiKey,
      'APCA-API-SECRET-KEY': cfg.secretKey,
      'Content-Type': 'application/json',
    };
  }

  async get<T>(baseOverride: 'base' | 'data', path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const base = baseOverride === 'data' ? this.cfg.dataUrl : this.cfg.baseUrl;
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const res = await fetch(url.toString(), { headers: this.headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.cfg.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca API ${res.status}: ${text}`);
    }
    // DELETE /positions returns JSON with order info
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return {} as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca API ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

export function createAlpacaClient(): AlpacaClient {
  const apiKey = process.env['ALPACA_API_KEY'];
  const secretKey = process.env['ALPACA_SECRET_KEY'];
  const baseUrl = process.env['ALPACA_BASE_URL'] ?? 'https://paper-api.alpaca.markets';
  const dataUrl = process.env['ALPACA_DATA_URL'] ?? 'https://data.alpaca.markets';

  if (!apiKey || !secretKey) {
    throw new Error('ALPACA_API_KEY and ALPACA_SECRET_KEY must be set');
  }

  return new AlpacaClient({ apiKey, secretKey, baseUrl, dataUrl });
}
