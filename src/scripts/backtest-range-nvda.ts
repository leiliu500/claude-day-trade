#!/usr/bin/env npx tsx
/**
 * backtest-range-nvda.ts — Run NVDA signal quality backtest across a date range.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-range-nvda.ts 2025-10-01 2026-03-26
 */

import { execSync } from 'child_process';

const START = process.argv[2] || '2025-10-01';
const END = process.argv[3] || '2026-03-26';

execSync(
  `npx tsx src/scripts/backtest-signal-quality.ts ${START} ${END} NVDA`,
  { stdio: 'inherit', timeout: 600_000 },
);
