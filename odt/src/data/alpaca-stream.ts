import { config } from "../config.js";
import { logger } from "../util/logger.js";
import type { Bar } from "../types.js";

const log = logger("alpaca-stream");

type BarHandler = (symbol: string, bar: Bar) => void;
export type TradeUpdate = {
  event: string;
  order: { id: string; status: string; filled_avg_price?: string };
};
type TradeUpdateHandler = (ev: TradeUpdate) => void;

interface AlpacaBarMsg {
  T: "b";
  S: string;
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export class AlpacaStream {
  private dataWs?: WebSocket;
  private tradeWs?: WebSocket;
  private barHandlers = new Set<BarHandler>();
  private tradeHandlers = new Set<TradeUpdateHandler>();
  private subscribedBars = new Set<string>();
  private dataAuthed = false;

  async connect(): Promise<void> {
    await this._connectData();
    await this._connectTrade();
  }

  private _connectData(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://stream.data.alpaca.markets/v2/sip");
      this.dataWs = ws;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({ action: "auth", key: config.alpaca.apiKey, secret: config.alpaca.secretKey }),
        );
      };
      ws.onmessage = (ev: MessageEvent) => {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const m of arr) {
          const msg = m as { T?: string; msg?: string };
          if (msg.T === "success" && msg.msg === "authenticated") {
            this.dataAuthed = true;
            if (this.subscribedBars.size > 0) {
              ws.send(JSON.stringify({ action: "subscribe", bars: Array.from(this.subscribedBars) }));
            }
            resolve();
          } else if (msg.T === "b") {
            const b = m as AlpacaBarMsg;
            const bar: Bar = { t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
            for (const h of this.barHandlers) h(b.S, bar);
          } else if (msg.T === "error") {
            log.error("stream error", msg);
          }
        }
      };
      ws.onerror = () => {
        if (!this.dataAuthed) reject(new Error("data ws error before auth"));
      };
      ws.onclose = () => {
        this.dataAuthed = false;
        log.warn("data ws closed");
      };
    });
  }

  private _connectTrade(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = config.alpaca.baseUrl.replace(/^https?:/, "wss:") + "/stream";
      const ws = new WebSocket(url);
      this.tradeWs = ws;
      ws.binaryType = "arraybuffer";
      let authed = false;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({ action: "auth", key: config.alpaca.apiKey, secret: config.alpaca.secretKey }),
        );
      };
      ws.onmessage = (ev: MessageEvent) => {
        const text =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        let msg: { stream?: string; data?: unknown };
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.stream === "authorization") {
          authed = true;
          ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
          resolve();
        } else if (msg.stream === "trade_updates") {
          for (const h of this.tradeHandlers) h(msg.data as TradeUpdate);
        }
      };
      ws.onerror = () => {
        if (!authed) reject(new Error("trade ws error before auth"));
      };
    });
  }

  subscribeBars(symbols: string[]): void {
    for (const s of symbols) this.subscribedBars.add(s);
    if (this.dataWs && this.dataAuthed) {
      this.dataWs.send(JSON.stringify({ action: "subscribe", bars: symbols }));
    }
  }

  onBar(h: BarHandler): () => void {
    this.barHandlers.add(h);
    return () => {
      this.barHandlers.delete(h);
    };
  }

  onTradeUpdate(h: TradeUpdateHandler): () => void {
    this.tradeHandlers.add(h);
    return () => {
      this.tradeHandlers.delete(h);
    };
  }

  disconnect(): void {
    this.dataWs?.close();
    this.tradeWs?.close();
    this.dataAuthed = false;
  }
}
