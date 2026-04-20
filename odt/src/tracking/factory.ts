import type { RunMeta } from "./types.js";
import type { TrackingSink } from "./sink.js";
import { NoopSink } from "./sink.js";
import { DbSink } from "./db-sink.js";
import { makeTelegramSinkFromEnv } from "./telegram-sink.js";
import { MultiSink } from "./multi-sink.js";

export interface SinkOptions {
  db?: boolean;
  telegram?: boolean;
}

export function makeSink(meta: RunMeta, opts: SinkOptions = {}): TrackingSink {
  const sinks: TrackingSink[] = [];
  if (opts.db) sinks.push(new DbSink(meta));
  if (opts.telegram) {
    const t = makeTelegramSinkFromEnv(meta);
    if (t) sinks.push(t);
  }
  if (sinks.length === 0) return new NoopSink(meta);
  if (sinks.length === 1) return sinks[0];
  return new MultiSink(meta, sinks);
}
