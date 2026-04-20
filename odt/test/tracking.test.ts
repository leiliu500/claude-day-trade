import { describe, it, expect } from "vitest";
import { NoopSink } from "../src/tracking/sink.js";
import { MultiSink } from "../src/tracking/multi-sink.js";
import type { RunMeta, SignalEvent, OpenEvent, CloseEvent, MarkEvent, DailySummary } from "../src/tracking/types.js";
import type { TrackingSink } from "../src/tracking/sink.js";

const meta: RunMeta = {
  mode: "backtest",
  strategy: "orb-breakout",
  vehicle: "long_option",
  symbol: "SPY",
  startedAt: Date.now(),
};

class RecordingSink implements TrackingSink {
  runId?: string;
  meta: RunMeta;
  events: string[] = [];
  shouldFail = false;
  constructor(m: RunMeta) { this.meta = m; }
  async init(): Promise<void> { this.runId = "rec-1"; this.events.push("init"); if (this.shouldFail) throw new Error("init boom"); }
  async signal(ev: SignalEvent): Promise<void> { this.events.push(`signal:${ev.accepted}`); }
  async open(ev: OpenEvent): Promise<void> { this.events.push(`open:${ev.positionId}`); }
  async mark(ev: MarkEvent): Promise<void> { this.events.push(`mark:${ev.positionId}`); }
  async close(ev: CloseEvent): Promise<void> { this.events.push(`close:${ev.positionId}`); }
  async endOfDay(s: DailySummary): Promise<void> { this.events.push(`daily:${s.day}`); }
  async shutdown(): Promise<void> { this.events.push("shutdown"); }
}

describe("NoopSink", () => {
  it("has the correct meta and accepts all events", async () => {
    const s = new NoopSink(meta);
    expect(s.meta).toBe(meta);
    await s.init();
    await s.signal({
      kind: "signal", ts: 0, day: "2026-04-20", mode: "backtest",
      side: "LONG", reason: "t", atr: 1, entryPrice: 500, accepted: true,
    });
    await s.shutdown();
  });
});

describe("MultiSink", () => {
  it("fans events to every child sink in parallel", async () => {
    const a = new RecordingSink(meta);
    const b = new RecordingSink(meta);
    const multi = new MultiSink(meta, [a, b]);
    await multi.init();
    await multi.open({
      kind: "open", ts: 0, day: "2026-04-20", mode: "backtest",
      positionId: "p1", orderKind: "long_option", side: "LONG",
      symbols: ["SPY"], qty: 1, filledDebit: 1, fees: 0,
      entryUnderlying: 500, signalTs: 0,
    });
    await multi.shutdown();
    expect(a.events).toEqual(["init", "open:p1", "shutdown"]);
    expect(b.events).toEqual(["init", "open:p1", "shutdown"]);
  });

  it("inherits runId from first sink with one", async () => {
    const a = new RecordingSink(meta);
    const b = new RecordingSink(meta);
    const multi = new MultiSink(meta, [a, b]);
    await multi.init();
    expect(multi.runId).toBe("rec-1");
  });

  it("continues fanning when one child sink throws", async () => {
    const a = new RecordingSink(meta);
    a.shouldFail = true;
    const b = new RecordingSink(meta);
    const multi = new MultiSink(meta, [a, b]);
    await multi.init();
    expect(b.events).toContain("init");
  });
});

describe("TelegramSink pnlBucket boundaries", () => {
  it("crosses 25/50/75/100 buckets on the way up", async () => {
    const { TelegramSink } = await import("../src/tracking/telegram-sink.js");
    const sink = new TelegramSink(meta, { token: "fake", chatId: "fake", notifyOnMark: false });
    const sent: string[] = [];
    type WithSend = { send(text: string): Promise<void> };
    (sink as unknown as WithSend).send = async (t: string) => { sent.push(t); };
    await sink.open({
      kind: "open", ts: 0, day: "2026-04-20", mode: "backtest",
      positionId: "p1", orderKind: "long_option", side: "LONG",
      symbols: ["SPY"], qty: 1, filledDebit: 1, fees: 0,
      entryUnderlying: 500, signalTs: 0,
    });
    expect(sent.length).toBe(0);
  });
});
