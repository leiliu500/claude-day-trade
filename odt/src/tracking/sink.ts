import type {
  CloseEvent,
  DailySummary,
  MarkEvent,
  OpenEvent,
  RunMeta,
  SignalEvent,
} from "./types.js";

export interface TrackingSink {
  meta: RunMeta;
  runId?: string;
  init(): Promise<void>;
  signal(ev: SignalEvent): Promise<void>;
  open(ev: OpenEvent): Promise<void>;
  mark(ev: MarkEvent): Promise<void>;
  close(ev: CloseEvent): Promise<void>;
  endOfDay(summary: DailySummary): Promise<void>;
  shutdown(): Promise<void>;
}

export class NoopSink implements TrackingSink {
  runId?: string;
  constructor(public meta: RunMeta) {}
  async init(): Promise<void> {}
  async signal(_ev: SignalEvent): Promise<void> {}
  async open(_ev: OpenEvent): Promise<void> {}
  async mark(_ev: MarkEvent): Promise<void> {}
  async close(_ev: CloseEvent): Promise<void> {}
  async endOfDay(_summary: DailySummary): Promise<void> {}
  async shutdown(): Promise<void> {}
}
