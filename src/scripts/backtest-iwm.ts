#!/usr/bin/env npx tsx
/**
 * backtest-iwm.ts — Convenience wrapper for IWM backtesting.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-iwm.ts [YYYY-MM-DD]
 *   Defaults: 2026-03-18
 *
 * Config: src/scripts/backtest-configs/iwm.ts
 */

// Inject ticker before backtest-day.ts parses argv
const dateArg = process.argv[2] || '2026-03-18';
process.argv = [process.argv[0]!, process.argv[1]!, dateArg, 'IWM', ...process.argv.slice(3)];

await import('./backtest-day.js');
