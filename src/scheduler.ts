import cron from 'node-cron';
import { runPipeline } from './pipeline/trading-pipeline.js';
import { notifySignalAnalysis, notifyAlert } from './telegram/notifier.js';
import { config } from './config.js';

// Default AUTO tickers — can be extended via config
const AUTO_TICKERS: Array<{ ticker: string; profile: 'S' | 'M' | 'L' }> = [
  { ticker: 'SPY', profile: 'S' },
  { ticker: 'QQQ', profile: 'S' },
];

let isRunning = false;

async function runAutoMode(): Promise<void> {
  if (isRunning) {
    console.log('[Scheduler] Skipping — previous run still active');
    return;
  }

  isRunning = true;
  console.log(`[Scheduler] AUTO trigger at ${new Date().toUTCString()}`);

  for (const { ticker, profile } of AUTO_TICKERS) {
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
  }

  isRunning = false;
}

/**
 * Start the cron scheduler.
 * Runs every 5 minutes, Monday-Friday, 12:00-21:00 UTC
 * (covers ~7:00 AM - 4:00 PM ET, which is pre-market through market close)
 */
export function startScheduler(): void {
  // */5 — every 5 minutes
  // * — every hour (filtered by time check)
  // 12-21 — hours 12-21 UTC
  // * — every day of month
  // * — every month
  // 1-5 — Monday-Friday
  const cronExpression = '*/5 12-21 * * 1-5';

  cron.schedule(cronExpression, async () => {
    await runAutoMode();
  }, {
    timezone: 'UTC',
  });

  console.log(`[Scheduler] Started — cron: "${cronExpression}" (Mon-Fri 12:00-21:00 UTC)`);
  console.log(`[Scheduler] AUTO tickers: ${AUTO_TICKERS.map(t => `${t.ticker}(${t.profile})`).join(', ')}`);
}

/** Run one manual trigger for dev/testing */
export async function triggerManual(ticker: string, profile: 'S' | 'M' | 'L'): Promise<void> {
  const result = await runPipeline(ticker, profile, 'MANUAL');
  await notifySignalAnalysis(result);
}
