import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CloseEvent,
  DailySummary,
  OpenEvent,
  RunMeta,
  SignalEvent,
  TrackingEvent,
} from "./types.js";

export interface TrackingSink {
  meta: RunMeta;
  signal(ev: SignalEvent): void;
  open(ev: OpenEvent): void;
  close(ev: CloseEvent): void;
  endOfDay(summary: DailySummary): void;
}

export class NoopSink implements TrackingSink {
  constructor(public meta: RunMeta) {}
  signal(): void {}
  open(): void {}
  close(): void {}
  endOfDay(): void {}
}

export class JsonlSink implements TrackingSink {
  private dir: string;

  constructor(public meta: RunMeta, logDir: string) {
    this.dir = logDir;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this._writeMeta();
  }

  private _writeMeta(): void {
    const path = join(this.dir, "run-meta.jsonl");
    appendFileSync(path, JSON.stringify({ kind: "run_meta", ...this.meta }) + "\n");
  }

  private _append(day: string, ev: TrackingEvent): void {
    const path = join(this.dir, `events-${day}.jsonl`);
    appendFileSync(path, JSON.stringify(ev) + "\n");
  }

  signal(ev: SignalEvent): void {
    this._append(ev.day, ev);
  }
  open(ev: OpenEvent): void {
    this._append(ev.day, ev);
  }
  close(ev: CloseEvent): void {
    this._append(ev.day, ev);
  }
  endOfDay(summary: DailySummary): void {
    this._append(summary.day, summary);
    const path = join(this.dir, `daily-${summary.day}.json`);
    writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
  }
}

export function makeSink(opts: { meta: RunMeta; logDir?: string }): TrackingSink {
  if (!opts.logDir) return new NoopSink(opts.meta);
  return new JsonlSink(opts.meta, opts.logDir);
}
