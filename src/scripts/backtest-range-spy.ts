#!/usr/bin/env npx tsx
/**
 * backtest-range-spy.ts — Run SPY signal quality backtest across a date range.
 *
 * Thin wrapper around backtest-signal-quality.ts for backwards compatibility.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-range-spy.ts 2025-10-01 2026-03-25
 */

import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-03-25';

execSync(
  `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} SPY`,
  { stdio: 'inherit', timeout: 600_000 },
);
