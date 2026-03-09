import cron from 'node-cron';
import { runPipeline } from './pipeline/trading-pipeline.js';
import { runDailyCleanup } from './pipeline/daily-cleanup.js';
import { notifySignalAnalysis, notifyAlert } from './telegram/notifier.js';
import { AlpacaStreamManager } from './lib/alpaca-stream.js';
import { cancelAllOpenOrders, closeAllPositions } from './lib/alpaca-api.js';
import { OrderAgentRegistry } from './agents/order-agent-registry.js';
import {
  insertSchedulerRun,
  completeSchedulerRun,
  type TickerRunResult,
} from './db/repositories/scheduler-runs.js';

// Default AUTO tickers — can be extended via config
const AUTO_TICKERS: Array<{ ticker: string; profile: 'S' | 'M' | 'L' }> = [
  { ticker: 'SPY', profile: 'S' },
  { ticker: 'AAPL', profile: 'S' },
];

const TRADING_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

/** Scheduler skips a ticker if stream triggered it within this window */
const STREAM_FALLBACK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Per-ticker state (replaces single isRunning boolean)
const isRunning = new Map<string, boolean>(); // true while pipeline is executing
const lastRunAt = new Map<string, number>();  // ms timestamp of most recent run start

/** True when current UTC time is within the trading window: Mon-Fri 9:30 AM - 4:30 PM ET (DST-aware) */
function isTradingWindow(): boolean {
  const now  = new Date();
  const day  = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;

  // DST detection: 2nd Sunday March → 1st Sunday November (US Eastern)
  const year = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 1));
  dstStart.setUTCDate(1 + ((7 - dstStart.getUTCDay()) % 7) + 7); // 2nd Sunday March
  const dstEnd = new Date(Date.UTC(year, 10, 1));
  dstEnd.setUTCDate(1 + ((7 - dstEnd.getUTCDay()) % 7)); // 1st Sunday November
  const isDst = now >= dstStart && now < dstEnd;

  const etOffsetMin = isDst ? -4 * 60 : -5 * 60;
  const totalUtcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const etMin = ((totalUtcMin + etOffsetMin) + 24 * 60) % (24 * 60);

  const marketOpenMin  = 9 * 60 + 30;  // 9:30 AM ET
  const marketCloseMin = 16 * 60 + 30; // 4:30 PM ET
  return etMin >= marketOpenMin && etMin < marketCloseMin;
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

  // Midnight PST close — 08:00 UTC Mon-Fri: cancel all orders + close all positions
  const midnightCloseCron = '0 8 * * 1-5';
  cron.schedule(midnightCloseCron, async () => {
    console.log('[Scheduler] Midnight PST close — cancelling orders and closing all positions');

    // Shut down all active order agents first so they don't interfere
    OrderAgentRegistry.getInstance().shutdownAll();

    const [cancelResult, closeResult] = await Promise.allSettled([
      cancelAllOpenOrders(),
      closeAllPositions(),
    ]);

    const cancelled = cancelResult.status === 'fulfilled' ? cancelResult.value.cancelled : 0;
    const closed    = closeResult.status  === 'fulfilled' ? closeResult.value.closed    : 0;
    const errors: string[] = [
      ...(cancelResult.status === 'fulfilled' ? cancelResult.value.errors : [`cancelAllOpenOrders threw: ${(cancelResult.reason as Error).message}`]),
      ...(closeResult.status  === 'fulfilled' ? closeResult.value.errors  : [`closeAllPositions threw: ${(closeResult.reason as Error).message}`]),
    ];

    const summary = `Midnight PST close: ${cancelled} order(s) cancelled, ${closed} position(s) closed` +
      (errors.length ? `\nErrors: ${errors.join('; ')}` : '');
    console.log(`[Scheduler] ${summary}`);
    await notifyAlert(summary);
  }, { timezone: 'UTC' });
  console.log(`[Scheduler] Midnight PST close cron: "${midnightCloseCron}" (Mon-Fri 08:00 UTC)`);

  // Pre-market-close forced liquidation — 15:50 ET (America/New_York, DST-aware)
  // Fires 10 min before the 4:00 PM ET close; closes ALL positions and orders regardless of P&L.
  const preCloseCron = '50 15 * * 1-5';
  cron.schedule(preCloseCron, async () => {
    console.log('[Scheduler] Pre-close forced liquidation — cancelling orders and closing all positions');

    // Shut down all active order agents first so they don't fight the close
    OrderAgentRegistry.getInstance().shutdownAll();

    const [cancelResult, closeResult] = await Promise.allSettled([
      cancelAllOpenOrders(),
      closeAllPositions(),
    ]);

    const cancelled = cancelResult.status === 'fulfilled' ? cancelResult.value.cancelled : 0;
    const closed    = closeResult.status  === 'fulfilled' ? closeResult.value.closed    : 0;
    const errors: string[] = [
      ...(cancelResult.status === 'fulfilled' ? cancelResult.value.errors : [`cancelAllOpenOrders threw: ${(cancelResult.reason as Error).message}`]),
      ...(closeResult.status  === 'fulfilled' ? closeResult.value.errors  : [`closeAllPositions threw: ${(closeResult.reason as Error).message}`]),
    ];

    const summary = `Pre-close liquidation (15:50 ET): ${cancelled} order(s) cancelled, ${closed} position(s) closed` +
      (errors.length ? `\nErrors: ${errors.join('; ')}` : '');
    console.log(`[Scheduler] ${summary}`);
    await notifyAlert(summary);
  }, { timezone: 'America/New_York' });
  console.log(`[Scheduler] Pre-close cron: "${preCloseCron}" ET (Mon-Fri 15:50 ET, DST-aware)`);

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
