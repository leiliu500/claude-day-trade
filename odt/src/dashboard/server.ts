import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  compareDay,
  listRecentRuns,
  listSymbols,
  positionMarks,
  todayLive,
} from "./queries.js";
import { config } from "../config.js";
import {
  buildPresetJob,
  cancelJob,
  getJob,
  listJobs,
  startJob,
} from "./job-runner.js";
import { logger } from "../util/logger.js";

const log = logger("dashboard");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DashboardOptions {
  port: number;
}

export function createApp() {
  const app = express();
  app.use(express.json());

  const staticRoot = join(__dirname, "static");
  if (existsSync(staticRoot)) app.use("/static", express.static(staticRoot));

  app.get("/", (_req, res) => {
    const htmlPath = join(staticRoot, "index.html");
    if (!existsSync(htmlPath)) {
      res.status(500).send("dashboard static/index.html not found");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(readFileSync(htmlPath, "utf8"));
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, now: Date.now() });
  });

  app.get("/api/symbols", async (_req, res) => {
    try {
      const dbSymbols = await listSymbols();
      const configured = config.symbols.map((s) => s.symbol);
      const merged = Array.from(new Set([...configured, ...dbSymbols])).sort();
      res.json({ symbols: merged, configured });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/runs", async (_req, res) => {
    try {
      const runs = await listRecentRuns(30);
      res.json({ runs });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/live/today", async (req, res) => {
    try {
      const symbol = String(req.query.symbol ?? "SPY");
      const data = await todayLive(symbol);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/compare", async (req, res) => {
    try {
      const symbol = String(req.query.symbol ?? "SPY");
      const day = String(req.query.day ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        res.status(400).json({ error: "day must be YYYY-MM-DD" });
        return;
      }
      const data = await compareDay(day, symbol);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/position-marks", async (req, res) => {
    try {
      const runId = String(req.query.runId ?? "");
      const positionId = String(req.query.positionId ?? "");
      if (!runId || !positionId) {
        res.status(400).json({ error: "runId and positionId required" });
        return;
      }
      res.json({ marks: await positionMarks(runId, positionId) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/jobs", (req, res) => {
    try {
      const { preset, params } = req.body as {
        preset: string;
        params?: Record<string, string>;
      };
      if (!preset) {
        res.status(400).json({ error: "preset is required" });
        return;
      }
      const spec = buildPresetJob(preset, params ?? {});
      const job = startJob(spec);
      res.json({
        id: job.id,
        name: job.name,
        status: job.status,
        cmd: job.cmd,
        args: job.args,
        startedAt: job.startedAt,
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get("/api/jobs", (_req, res) => {
    res.json({
      jobs: listJobs().map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        exitCode: j.exitCode,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        lineCount: j.output.length,
      })),
    });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const j = getJob(req.params.id);
    if (!j) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({
      id: j.id,
      name: j.name,
      status: j.status,
      exitCode: j.exitCode,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      output: j.output,
    });
  });

  app.post("/api/jobs/:id/cancel", (req, res) => {
    const ok = cancelJob(req.params.id);
    res.json({ canceled: ok });
  });

  app.get("/api/jobs/:id/stream", (req, res) => {
    const j = getJob(req.params.id);
    if (!j) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for (const line of j.output) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
    if (j.status !== "running") {
      res.write(`event: done\ndata: ${JSON.stringify({ status: j.status, exitCode: j.exitCode })}\n\n`);
      res.end();
      return;
    }

    const onLine = (line: string) => res.write(`data: ${JSON.stringify({ line })}\n\n`);
    const onDone = () => {
      res.write(`event: done\ndata: ${JSON.stringify({ status: j.status, exitCode: j.exitCode })}\n\n`);
      res.end();
    };
    j.listeners.on("line", onLine);
    j.listeners.once("done", onDone);
    req.on("close", () => {
      j.listeners.off("line", onLine);
      j.listeners.off("done", onDone);
    });
  });

  return app;
}

export async function startDashboard(opts: DashboardOptions): Promise<void> {
  const app = createApp();
  app.listen(opts.port, () => {
    log.info(`dashboard listening on http://localhost:${opts.port}`);
  });
}
