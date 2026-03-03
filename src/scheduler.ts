import cron from 'node-cron';
import { runPipeline } from './pipeline/trading-pipeline.js';
import { runDailyCleanup } from './pipeline/daily-cleanup.js';
import { notifySignalAnalysis, notifyAlert } from './telegram/notifier.js';
import { AlpacaStreamManager } from './lib/alpaca-stream.js';
import {
  insertSchedulerRun,
  completeSchedulerRun,
  type TickerRunResult,
} from './db/repositories/scheduler-runs.js';

// Default AUTO tickers — can be extended via config
const AUTO_TICKERS: Array<{ ticker: string; profile: 'S' | 'M' | 'L' }> = [
  { ticker: 'SPY', profile: 'S' },
  { ticker: 'QQQ', profile: 'S' },
];

const TRADING_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

/** Scheduler skips a ticker if stream triggered it within this window */
const STREAM_FALLBACK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Per-ticker state (replaces single isRunning boolean)
const isRunning = new Map<string, boolean>(); // true while pipeline is executing
const lastRunAt = new Map<string, number>();  // ms timestamp of most recent run start

/** True when current UTC time is within the trading window: Mon-Fri 13:30-20:30 UTC (9:30 AM - 4:30 PM ET) */
function isTradingWindow(): boolean {
  const now    = new Date();
  const day    = now.getUTCDay();     // 0=Sun, 6=Sat
  const hour   = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const afterStart = hour > 13 || (hour === 13 && minute >= 30);
  const beforeEnd  = hour < 20 || (hour === 20 && minute < 30);
  return day >= 1 && day <= 5 && afterStart && beforeEnd;
}

/**
 * Milliseconds until the next UTC-aligned 3-minute boundary
 * (epoch multiples of 3 min → aligns to :00 :03 :06 … :57 of each hour).
 * Adds one full interval when we are <100 ms away to avoid double-firing.
 */
function msUntilNextBoundary(): number {
  const now   = Date.now();
  const next  = Math.ceil(now / TRADING_INTERVAL_MS) * TRADING_INTERVAL_MS;
  const delay = next - now;
  return delay < 100 ? delay + TRADING_INTERVAL_MS : delay;
}

/**
 * Run the full pipeline for a single ticker and record DB + Telegram output.
 * Used by both the stream trigger and the scheduler fallback.
 */
async function runOneTicker(
  cfg: { ticker: string; profile: 'S' | 'M' | 'L' },
  trigger: 'AUTO' | 'STREAM',
): Promise<TickerRunResult> {
  const { ticker, profile } = cfg;
  const runAt = new Date();
  const t0    = Date.now();

  isRunning.set(ticker, true);
  lastRunAt.set(ticker, t0);

  let runId: string | undefined;
  try {
    runId = await insertSchedulerRun(runAt, trigger, 'RUNNING');
  } catch (err) {
    console.error(`[Scheduler] Failed to insert run record for ${ticker}:`, (err as Error).message);
  }

  // Safety net: force-reset isRunning if this ticker's run exceeds 150 s.
  const forceReset = setTimeout(() => {
    if (isRunning.get(ticker)) {
      console.error(`[Scheduler] ${ticker} run exceeded 150 s — force-resetting isRunning`);
      void notifyAlert(`[Scheduler] ${ticker} tick timed out after 150 s — isRunning force-reset`);
      if (runId) {
        void completeSchedulerRun(runId, 'TIMEOUT', [], Date.now() - t0).catch(() => {});
      }
      isRunning.set(ticker, false);
    }
  }, 150_000);

  let result: TickerRunResult;
  try {
    const pipelineResult = await runPipeline(ticker, profile, 'AUTO');
    result = {
      ticker,
      profile,
      status: 'ok',
      decision: pipelineResult.decision,
      duration_ms: Date.now() - t0,
    };
    if (pipelineResult.decision !== 'WAIT' || pipelineResult.orderSubmitted || pipelineResult.error) {
      await notifySignalAnalysis(pipelineResult);
    }
  } catch (err) {
    const msg = `${trigger} run failed for ${ticker}: ${(err as Error).message}`;
    console.error('[Scheduler]', msg);
    result = {
      ticker,
      profile,
      status: 'error',
      duration_ms: Date.now() - t0,
      error: (err as Error).message,
    };
    await notifyAlert(msg);
  } finally {
    clearTimeout(forceReset);
    if (runId) {
      void completeSchedulerRun(runId, 'COMPLETED', [result!], Date.now() - t0).catch(() => {});
    }
    isRunning.set(ticker, false);
  }

  return result!;
}

/**
 * Subscribe to 1-min bar events from the data stream.
 * Each new bar for a watched ticker triggers the pipeline immediately,
 * replacing the 3-min scheduled tick as the primary driver.
 */
function subscribeToStreamTrigger(): void {
  AlpacaStreamManager.getInstance().on('bar', (ticker: string) => {
    const cfg = AUTO_TICKERS.find(t => t.ticker === ticker);
    if (!cfg) return;
    if (!isTradingWindow()) return;
    if (isRunning.get(ticker)) return; // pipeline already in progress for this ticker

    console.log(`[Scheduler] Stream bar received — triggering pipeline for ${ticker}`);
    void runOneTicker(cfg, 'STREAM');
  });
  console.log('[Scheduler] Stream trigger subscribed');
}

/**
 * Fallback scheduler tick — runs tickers that the stream has not recently triggered.
 * If the stream is healthy, lastRunAt will be fresh and all tickers are skipped.
 * If the stream is down/stale, lastRunAt ages out and this takes over.
 */
async function runAutoMode(): Promise<void> {
  const now = Date.now();

  const toRun = AUTO_TICKERS.filter(cfg => {
    if (isRunning.get(cfg.ticker)) return false;
    const last = lastRunAt.get(cfg.ticker) ?? 0;
    return now - last > STREAM_FALLBACK_THRESHOLD_MS;
  });

  if (toRun.length === 0) {
    console.log('[Scheduler] All tickers recently triggered by stream — skipping fallback');
    void insertSchedulerRun(new Date(), 'AUTO', 'SKIPPED', 'STREAM_ACTIVE').catch(() => {});
    return;
  }

  console.log(`[Scheduler] Fallback AUTO trigger at ${new Date().toUTCString()} for: ${toRun.map(t => t.ticker).join(', ')}`);
  await Promise.allSettled(toRun.map(cfg => runOneTicker(cfg, 'AUTO')));
}

/**
 * Self-correcting trading tick scheduler (fallback path).
 *
 * Schedules the NEXT tick before executing the current one so that a slow
 * pipeline run can never delay future ticks. Aligns to UTC 3-minute
 * boundaries (epoch multiples) — same cadence as before but now only fires
 * for tickers the stream hasn't already covered.
 */
function scheduleTradingTick(): void {
  const delay = msUntilNextBoundary();
  setTimeout(() => {
    scheduleTradingTick();            // arm next tick FIRST
    if (isTradingWindow()) {
      void runAutoMode();
    }
  }, delay);
}

/**
 * Start the scheduler.
 *
 * Primary trigger: stream bar events via subscribeToStreamTrigger().
 * Fallback trigger: self-correcting 3-min setTimeout chain, Mon-Fri 13:30-20:30 UTC.
 * Daily cleanup: 07:00 UTC Mon-Fri.
 */
export function startScheduler(): void {
  // Primary: stream-driven trigger (fires on each new 1-min bar)
  subscribeToStreamTrigger();

  // Fallback: 3-min tick — only runs tickers not recently covered by stream
  scheduleTradingTick();
  console.log(`[Scheduler] Fallback interval: every 3 min, Mon-Fri 13:30-20:30 UTC`);

  // Daily cleanup — once a day, cron precision is fine here
  const cleanupCron = '0 7 * * 1-5';
  cron.schedule(cleanupCron, async () => {
    console.log('[Scheduler] Daily cleanup triggered');
    await runDailyCleanup();
  }, { timezone: 'UTC' });
  console.log(`[Scheduler] Cleanup cron: "${cleanupCron}" (Mon-Fri 07:00 UTC)`);

  console.log(`[Scheduler] AUTO tickers: ${AUTO_TICKERS.map(t => `${t.ticker}(${t.profile})`).join(', ')}`);
}

/** Run one manual trigger for dev/testing */
export async function triggerManual(ticker: string, profile: 'S' | 'M' | 'L'): Promise<void> {
  const result = await runPipeline(ticker, profile, 'MANUAL');
  await notifySignalAnalysis(result);
}
