#!/usr/bin/env npx tsx
/**
 * backtest-aapl.ts — Convenience wrapper for AAPL backtesting.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-aapl.ts [YYYY-MM-DD]
 */

const dateArg = process.argv[2] || '2026-03-18';
process.argv = [process.argv[0]!, process.argv[1]!, dateArg, 'AAPL', ...process.argv.slice(3)];

await import('./backtest-day.js');
