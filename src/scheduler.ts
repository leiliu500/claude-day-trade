import cron from 'node-cron';
import { runPipeline } from './pipeline/trading-pipeline.js';
import { runDailyCleanup } from './pipeline/daily-cleanup.js';
import { notifySignalAnalysis, notifyAlert } from './telegram/notifier.js';
import { config } from './config.js';

// Default AUTO tickers — can be extended via config
const AUTO_TICKERS: Array<{ ticker: string; profile: 'S' | 'M' | 'L' }> = [
  { ticker: 'SPY', profile: 'S' },
  { ticker: 'QQQ', profile: 'S' },
];

const TRADING_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

/** True when current UTC time is within the trading window: Mon-Fri 12:00-21:59 UTC */
function isTradingWindow(): boolean {
  const now = new Date();
  const day  = now.getUTCDay();   // 0=Sun, 6=Sat
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 12 && hour <= 21;
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

let isRunning = false;

async function runAutoMode(): Promise<void> {
  if (isRunning) {
    console.log('[Scheduler] Skipping — previous run still active');
    return;
  }

  isRunning = true;
  console.log(`[Scheduler] AUTO trigger at ${new Date().toUTCString()}`);

  await Promise.allSettled(
    AUTO_TICKERS.map(async ({ ticker, profile }) => {
      try {
        const result = await runPipeline(ticker, profile, 'AUTO');
        // Only notify if there's something meaningful (not WAIT with no positions)
        if (result.decision !== 'WAIT' || result.orderSubmitted || result.error) {
          await notifySignalAnalysis(result);
        }
      } catch (err) {
        const msg = `AUTO run failed for ${ticker}: ${(err as Error).message}`;
        console.error('[Scheduler]', msg);
        await notifyAlert(msg);
      }
    })
  );

  isRunning = false;
}

/**
 * Self-correcting trading tick scheduler.
 *
 * Schedules the NEXT tick before executing the current one so that a slow
 * pipeline run can never delay future ticks.  Aligns to UTC 3-minute
 * boundaries (epoch multiples) — same cadence as the old node-cron pattern
 * but immune to its 1-second polling drift.
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
 * Trading: self-correcting setTimeout chain, Mon-Fri 12:00-21:00 UTC
 *   (covers ~7:00 AM - 4:00 PM ET, pre-market through market close)
 *
 * Daily cleanup: 07:00 UTC Mon-Fri — truncates all trading tables so each
 *   day starts with an empty database (runs ~7:30 hours before market open).
 */
export function startScheduler(): void {
  // Trading ticks — drift-free setTimeout chain
  scheduleTradingTick();
  console.log(`[Scheduler] Trading interval: every 3 min, Mon-Fri 12:00-21:00 UTC`);

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
