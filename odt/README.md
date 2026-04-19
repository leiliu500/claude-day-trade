# odt — option day-trade system v2

Self-contained TypeScript system, parallel to `../src/`. Strategy S1: trend + pullback on SPY, traded via 7–14 DTE ~0.50Δ debit verticals.

## Setup

Uses root `node_modules` and root `.env` (`ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_BASE_URL`, `ALPACA_DATA_URL`).

## Commands

All run from repo root.

```bash
# Type-check
npx tsc -p odt/tsconfig.json

# Tests
npx vitest run odt/test

# Backtest a window
npx tsx odt/src/cli/backtest.ts --start 2025-11-03 --end 2025-11-28 --symbol SPY

# Walk-forward
npx tsx odt/src/cli/walk-forward.ts --start 2025-08-01 --end 2026-01-31 --symbol SPY --folds 3

# Live (dry-run = no orders submitted)
npx tsx odt/src/cli/live.ts --symbol SPY --dry-run
```

## Design

- **Strategy** (`signal/trend-pullback.ts`) — 5-min EMA20 trend + pullback reclaim
- **IV proxy** (`vol/`) — 20-day HV rank (Alpaca cheap tier has no historical IV)
- **Contract** (`selector/`) — delta-targeted debit vertical, liquidity-gated
- **Risk** (`risk/`) — per-trade, per-day, concurrent, streak lockouts
- **Exec** (`exec/order-router.ts`) — `BacktestRouter` and `LiveRouter` share same interface
- **Position** (`position/manager.ts`) — 4 exit rules: invalidation / stop / target / time
- **Backtest** (`backtest/`) — pessimistic fills (next-bar open + slippage + fee)

## Known limits (v1)

1. IV rank = HV rank (no vendor IV data).
2. Backtest fills modeled from 1-min option bars — no tick-level NBBO.
3. Live option pricing = 5s REST poll (no Alpaca options WS).
4. Only S1 implemented; framework supports S2/S3 later.
