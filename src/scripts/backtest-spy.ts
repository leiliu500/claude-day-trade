#!/usr/bin/env npx tsx
/**
 * backtest-spy.ts — Convenience wrapper for SPY backtesting.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-spy.ts [YYYY-MM-DD]
 *   Defaults: 2026-03-18
 *
 * Config: src/scripts/backtest-configs/spy.ts
 * Results Q1 2026: 13W/6L (68%), +159.8%
 */

// Inject ticker before backtest-day.ts parses argv
const dateArg = process.argv[2] || '2026-03-18';
process.argv = [process.argv[0]!, process.argv[1]!, dateArg, 'SPY', ...process.argv.slice(3)];

await import('./backtest-day.js');
