#!/usr/bin/env npx tsx
/**
 * backtest-range-iwm.ts — Run IWM signal quality backtest across a date range.
 *
 * Thin wrapper around backtest-signal-quality.ts for backwards compatibility.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-range-iwm.ts 2025-10-01 2026-03-25
 */

import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-03-26';

execSync(
  `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} IWM`,
  { stdio: 'inherit', timeout: 600_000 },
);
