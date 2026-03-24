#!/usr/bin/env npx tsx
/**
 * backtest-qqq.ts — Convenience wrapper for QQQ backtesting.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-qqq.ts [YYYY-MM-DD]
 *   Defaults: 2026-03-18
 *
 * Config: src/scripts/backtest-configs/qqq.ts
 * Results Q1 2026: 6W/5L (55%), +41.1%
 */

// Inject ticker before backtest-day.ts parses argv
const dateArg = process.argv[2] || '2026-03-18';
process.argv = [process.argv[0]!, process.argv[1]!, dateArg, 'QQQ', ...process.argv.slice(3)];

await import('./backtest-day.js');
