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
 *
 * Trading: every 3 minutes, Monday-Friday, 12:00-21:00 UTC
 *   (covers ~7:00 AM - 4:00 PM ET, pre-market through market close)
 *
 * Daily cleanup: 07:00 UTC Mon-Fri — truncates all trading tables so each
 *   day starts with an empty database (runs ~7:30 hours before market open).
 */
export function startScheduler(): void {
  const tradingCron = '*/3 12-21 * * 1-5';
  const cleanupCron = '0 7 * * 1-5';

  cron.schedule(tradingCron, async () => {
    await runAutoMode();
  }, { timezone: 'UTC' });

  cron.schedule(cleanupCron, async () => {
    console.log('[Scheduler] Daily cleanup triggered');
    await runDailyCleanup();
  }, { timezone: 'UTC' });

  console.log(`[Scheduler] Trading cron: "${tradingCron}" (Mon-Fri 12:00-21:00 UTC)`);
  console.log(`[Scheduler] Cleanup cron: "${cleanupCron}" (Mon-Fri 07:00 UTC)`);
  console.log(`[Scheduler] AUTO tickers: ${AUTO_TICKERS.map(t => `${t.ticker}(${t.profile})`).join(', ')}`);
}

/** Run one manual trigger for dev/testing */
export async function triggerManual(ticker: string, profile: 'S' | 'M' | 'L'): Promise<void> {
  const result = await runPipeline(ticker, profile, 'MANUAL');
  await notifySignalAnalysis(result);
}
