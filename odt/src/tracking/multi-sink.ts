import type {
  CloseEvent,
  DailySummary,
  MarkEvent,
  OpenEvent,
  RunMeta,
  SignalEvent,
} from "./types.js";
import type { TrackingSink } from "./sink.js";
import { logger } from "../util/logger.js";

const log = logger("multi-sink");

export class MultiSink implements TrackingSink {
  runId?: string;
  constructor(public meta: RunMeta, private sinks: TrackingSink[]) {}

  private async _run<T extends unknown[]>(
    fnName: "init" | "signal" | "open" | "mark" | "close" | "endOfDay" | "shutdown",
    ...args: T
  ): Promise<void> {
    await Promise.all(
      this.sinks.map(async (s) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (s as any)[fnName](...args);
        } catch (e) {
          log.warn(`sink ${s.constructor.name}.${fnName} failed: ${(e as Error).message}`);
        }
      }),
    );
  }

  async init(): Promise<void> {
    await this._run("init");
    this.runId = this.sinks.find((s) => s.runId)?.runId;
  }
  async signal(ev: SignalEvent): Promise<void> {
    await this._run("signal", ev);
  }
  async open(ev: OpenEvent): Promise<void> {
    await this._run("open", ev);
  }
  async mark(ev: MarkEvent): Promise<void> {
    await this._run("mark", ev);
  }
  async close(ev: CloseEvent): Promise<void> {
    await this._run("close", ev);
  }
  async endOfDay(summary: DailySummary): Promise<void> {
    await this._run("endOfDay", summary);
  }
  async shutdown(): Promise<void> {
    await this._run("shutdown");
  }
}
