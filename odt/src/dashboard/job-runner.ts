import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { logger } from "../util/logger.js";

const log = logger("job-runner");

export type JobStatus = "running" | "succeeded" | "failed" | "canceled";

export interface JobSpec {
  name: string;
  cmd: string;
  args: string[];
}

export interface Job {
  id: string;
  name: string;
  cmd: string;
  args: string[];
  status: JobStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  output: string[];
  listeners: EventEmitter;
  proc?: ChildProcess;
}

const MAX_JOBS = 50;
const jobs = new Map<string, Job>();

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function startJob(spec: JobSpec): Job {
  const id = randomUUID();
  const listeners = new EventEmitter();
  listeners.setMaxListeners(50);
  const job: Job = {
    id,
    name: spec.name,
    cmd: spec.cmd,
    args: spec.args,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    output: [],
    listeners,
  };
  jobs.set(id, job);

  const proc = spawn(spec.cmd, spec.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
  });
  job.proc = proc;

  const onData = (chunk: Buffer) => {
    const lines = chunk.toString("utf8").split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      job.output.push(line);
      if (job.output.length > 5000) job.output.shift();
      listeners.emit("line", line);
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  proc.on("exit", (code, signal) => {
    job.exitCode = code;
    job.endedAt = Date.now();
    if (signal) job.status = "canceled";
    else job.status = code === 0 ? "succeeded" : "failed";
    log.info(`job ${job.id.slice(0, 8)} ${job.status} exit=${code} signal=${signal}`);
    listeners.emit("done", job);
  });
  proc.on("error", (err) => {
    job.status = "failed";
    job.endedAt = Date.now();
    job.output.push(`[spawn error] ${err.message}`);
    listeners.emit("done", job);
  });

  if (jobs.size > MAX_JOBS) {
    const old = Array.from(jobs.values())
      .filter((j) => j.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const j of old.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
  }

  return job;
}

export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || !j.proc || j.status !== "running") return false;
  j.proc.kill("SIGTERM");
  return true;
}

export const PRESETS: Record<string, (params: Record<string, string>) => JobSpec> = {
  "unit-tests": () => ({
    name: "Unit tests (vitest)",
    cmd: "npx",
    args: ["vitest", "run", "odt/test", "--reporter=verbose"],
  }),
  "type-check": () => ({
    name: "TypeScript type-check",
    cmd: "npx",
    args: ["tsc", "-p", "odt/tsconfig.json"],
  }),
  backtest: (p) => ({
    name: `Backtest ${p.symbol ?? "SPY"} ${p.start ?? ""}..${p.end ?? ""}`,
    cmd: "npx",
    args: [
      "tsx",
      "odt/src/cli/backtest.ts",
      "--symbol", p.symbol ?? "SPY",
      "--start", p.start ?? "",
      "--end", p.end ?? "",
      "--strategy", p.strategy ?? "orb",
      "--vehicle", p.vehicle ?? "long_option",
    ],
  }),
  "walk-forward": (p) => ({
    name: `Walk-forward ${p.symbol ?? "SPY"} ${p.start}..${p.end} folds=${p.folds ?? "3"}`,
    cmd: "npx",
    args: [
      "tsx",
      "odt/src/cli/walk-forward.ts",
      "--symbol", p.symbol ?? "SPY",
      "--start", p.start ?? "",
      "--end", p.end ?? "",
      "--folds", p.folds ?? "3",
      "--strategy", p.strategy ?? "orb",
      "--vehicle", p.vehicle ?? "long_option",
    ],
  }),
};

export function buildPresetJob(preset: string, params: Record<string, string>): JobSpec {
  const fn = PRESETS[preset];
  if (!fn) throw new Error(`unknown preset: ${preset}`);
  const spec = fn(params);
  if (spec.args.some((a) => a === "")) throw new Error(`missing required param for preset ${preset}`);
  return spec;
}
