#!/usr/bin/env npx tsx
/**
 * backtest-nvda.ts — Convenience wrapper for NVDA backtesting.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-nvda.ts [YYYY-MM-DD]
 */

const dateArg = process.argv[2] || '2026-03-18';
process.argv = [process.argv[0]!, process.argv[1]!, dateArg, 'NVDA', ...process.argv.slice(3)];

await import('./backtest-day.js');
