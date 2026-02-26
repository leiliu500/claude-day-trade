# claude-day-trade

Option day trading system using Claude agents + MCP servers, replacing an n8n workflow.

## Architecture

```
Telegram trigger / 5-min cron
        │
        ▼
TradingPipeline (src/pipeline/trading-pipeline.ts)
  ├── SignalAgent         → fetch bars → DMI + ATR + TD Sequential + candle patterns
  ├── OptionAgent         → dual CALL+PUT scoring → select winner
  ├── AnalysisAgent       → deterministic confidence + Claude Haiku explanation
  ├── DecisionOrchestrator→ Claude Sonnet: NEW_ENTRY / CONFIRM_HOLD / EXIT / WAIT / ...
  ├── ExecutionAgent      → conviction sizing → Alpaca order submission
  └── EvaluationAgent     → Claude Sonnet: A-F grade after trade closes
        │
        ▼
  PostgreSQL (trading schema) + Telegram notifications + Web dashboard
```

## MCP Servers

| Server | Tools |
|---|---|
| `packages/mcp-alpaca` | `get_stock_bars`, `get_option_contracts`, `get_option_snapshots`, `submit_order`, `close_position`, `get_account`, `get_positions` |
| `packages/mcp-postgres` | `pg_query` (SELECT), `pg_execute` (INSERT/UPDATE), `pg_list_tables` |

## Setup

```bash
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, ALPACA_API_KEY/SECRET, TELEGRAM_BOT_TOKEN/CHAT_ID

# Docker (production)
docker-compose up -d

# Dev
npm install
npm run dev
```

## Telegram Interface

Send a message to your bot:
```
SPY S       # SPY Scalp profile (2m/3m/5m)
QQQ M       # QQQ Medium profile (1m/5m/15m)
AAPL L      # AAPL Long profile (5m/1h/1d)

/status     # System status + open position count
/positions  # List all open positions
```

## Dashboard

Open `http://localhost:3001` after starting.

Tabs: **Positions** | **Signals** | **Decisions** | **Evaluations** | **Orders**

Auto-refreshes every 30 seconds.

## Trading Profiles

| Profile | Timeframes | Typical Hold |
|---|---|---|
| S (Scalp) | 2m / 3m / 5m | 5–30 min |
| M (Medium) | 1m / 5m / 15m | 15–120 min |
| L (Long) | 5m / 1h / 1d | Multi-hour |

## Key Design Principles

1. **Deterministic over AI** — all indicators (DMI, ATR, TD Sequential) computed in TypeScript; confidence is a formula, not a guess
2. **Dual-candidate fairness** — CALL + PUT evaluated equally before winner selected
3. **8 safety gates** — market open, liquidity, confidence, R:R, side match, candidate pass, buying power, qty cap; any fail → WAIT
4. **3-confirmation entry** — OBSERVE → BUILDING_CONVICTION → CONFIRMED_ENTRY (override at confidence >= 0.85 + all_aligned)
5. **Learn from past** — EvaluationAgent grades every trade A-F; DecisionOrchestrator reads feedback to avoid repeating D/F patterns

## Project Structure

```
claude-day-trade/
├── docker-compose.yml
├── sql/                           # DB migrations (auto-run on startup)
│   ├── 001_schema.sql
│   ├── 002_views.sql
│   └── 003_indexes.sql
├── packages/
│   ├── mcp-alpaca/                # MCP server: Alpaca REST API
│   └── mcp-postgres/              # MCP server: PostgreSQL
└── src/
    ├── index.ts                   # Bootstrap
    ├── scheduler.ts               # 5-min AUTO cron
    ├── config.ts                  # Zod env validation
    ├── types/                     # TypeScript interfaces
    ├── indicators/                # DMI, ATR, TD Sequential (pure math)
    ├── agents/                    # 6 agent classes
    ├── pipeline/                  # TradingPipeline, safety gates, context builder
    ├── db/                        # Pool, migrate, repositories
    ├── telegram/                  # Bot + notifier
    └── dashboard/                 # Express API + HTML/JS frontend
```
