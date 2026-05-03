# Backtest Correctness Proof — SPY

Seven scripts that prove the backtest is correct via **four independent witnesses** without using any live system data or output. Each layer isolates a single component so a failure points at exactly one thing.

| Layer | Script | What it proves | Witness |
| --- | --- | --- | --- |
| 1a. Bars (data) | `dump-bars.ts` | Backtest's input OHLCV is what Alpaca SIP serves | Alpaca SIP |
| 1b. Bars (cross-feed) | `yahoo-cross-feed.py` | Same bars as Yahoo Finance at industry tolerance | Yahoo Finance |
| 1c. Invariants | `check-invariants.py` | 1m/5m/15m self-consistency, RTH bar counts, rollups | (self) |
| 2a. Indicators (textbook) | `self-check.ts` | Math agrees with textbook reference impl to `1e-9` | TS textbook ref |
| 2b. Indicators (library) | `pandas-ta-cross-check.py` | Math agrees with `pandas-ta` Python library at 6-dec | pandas-ta |
| 2c. Indicators (ToS) | `dump-indicators.ts` | CSVs ready for manual ToS export-and-diff | ToS (manual) |
| 3. Decisions | `validate-decisions.ts` | Direction + indicators are pure functions of bars | (snapshot) |

---

## TL;DR — full proof in 5 commands

```bash
# Layer 1a: pull SPY bars from Alpaca SIP (writes validate-out/<DATE>/)
npx tsx src/scripts/validate/dump-bars.ts        2026-05-01 SPY

# Layer 1b: confirm same bars via Yahoo Finance (independent feed)
python3 src/scripts/validate/yahoo-cross-feed.py 2026-05-01

# Layer 1c: rollup + monotonicity self-checks
python3 src/scripts/validate/check-invariants.py 2026-05-01

# Layer 2a: indicator math vs textbook reference (offline)
npx tsx src/scripts/validate/self-check.ts       2026-05-01 SPY

# Layer 3: decision determinism (offline, runs every fixture)
npx tsx src/scripts/validate/validate-decisions.ts
```

For Layer 2b (pandas-ta) you also need the per-minute indicator CSV:
```bash
npx tsx src/scripts/validate/dump-indicators.ts        2026-05-01 SPY 1
python3 src/scripts/validate/pandas-ta-cross-check.py  2026-05-01 5m
```

---

## Python deps (Layers 1b, 1c, 2b)

`yahoo-cross-feed.py` and `check-invariants.py` use the Python stdlib only.
`pandas-ta-cross-check.py` needs:

```bash
python3 -m pip install --user pandas pandas-ta numpy
```

If your distro has both `python3` and `python3.12`, run with the version that has the deps installed (e.g. `python3.12 src/scripts/validate/pandas-ta-cross-check.py …`).

---

## Layer 1a — Bars (Alpaca SIP)

Pulls SPY 1-minute bars from Alpaca SIP for the chosen date, filters to RTH (09:30–16:00 ET), aggregates 5m/15m, writes ToS-compatible CSVs.

```bash
npx tsx src/scripts/validate/dump-bars.ts 2026-04-23 SPY
# writes ./validate-out/2026-04-23/{bars-1m.csv, bars-5m.csv, bars-15m.csv, session-summary.txt}
```

**Pass criterion:** 390 1m bars, 78 5m, 26 15m, OHLCV self-consistent.

## Layer 1b — Cross-feed vs Yahoo Finance

Fetches Yahoo Finance 1m bars for the same day(s) and diffs OHLCV against the Alpaca CSVs.

```bash
python3 src/scripts/validate/yahoo-cross-feed.py 2026-04-15 2026-04-23 2026-05-01
```

Reports per-field match counts at three tolerances (±$0.00 byte / ±$0.01 penny / ±$0.05 feed). **PASS = ≥99% of bars match within ±$0.05** (industry-normal feed-aggregation noise on a $720 stock).

Volume between feeds typically differs by ~1-3% (SIP tape vs Yahoo's consolidated ETB) — reported informationally.

## Layer 1c — Invariants

Self-consistency on the dumped CSVs — runs offline, no fetch needed.

```bash
python3 src/scripts/validate/check-invariants.py 2026-04-15 2026-04-23 2026-05-01
```

Verifies:
- bar counts (390 / 78 / 26)
- 1m time-monotonic 09:30 → 15:59 ET
- session OHLC from 1m CSV equals session-summary.txt
- 5m/15m bars are correct rollups of 1m (Open=first, High=max, Low=min, Close=last, Volume=sum)

## Layer 2a — Indicator self-check (textbook reference)

Computes each indicator on real SPY bars two independent ways: (a) the system implementation in `src/indicators/*.ts`, and (b) a clean-room reference implementation written inline in `self-check.ts` from the textbook formula. Asserts agreement to `1e-9`.

```bash
npx tsx src/scripts/validate/self-check.ts 2026-05-01 SPY
# ... 18 passed, 0 failed (tolerance 1e-9)
```

Covers: EMA (9, 21), MACD (12, 26, 9), Bollinger (20, 2.0), ATR (14, skipSessionGaps), DMI (14 + 8), Stochastic Fast (14, 3, 1), VWAP. Both implementations agreeing on real market data ⇒ system math is sound.

This is the strongest math check that runs **without any external system**.

## Layer 2b — Cross-impl vs pandas-ta

Third independent indicator implementation, in a different language and library.

```bash
# First produce per-minute indicator dump for the day:
npx tsx src/scripts/validate/dump-indicators.ts 2026-05-01 SPY 1

# Then cross-check (5m timeframe; fetches its own warmup bars from Alpaca):
python3 src/scripts/validate/pandas-ta-cross-check.py 2026-05-01 5m
```

Pulls the same 5-day warmup window the system uses, runs `pandas-ta` indicators in Python, label-aligns against the system's CSV (the system writes "indicator at clock-time T" using bars completed *before* T — pandas-ta uses bar-start labels, so we shift +1 bar), and reports per-indicator match.

**Expected result:** all non-ATR indicators byte-match at 6 decimals (EMA, MACD, BB, Stoch). ATR differs by design — the system uses `skipSessionGaps=true` to zero TR overnight, pandas-ta has no session concept; the textbook session-aware ATR is verified by Layer 2a instead.

## Layer 2c — Indicators vs ToS (manual, optional)

For an additional external double-check, the same `dump-indicators.ts` output can be diffed against ToS chart values:

1. Open ToS, set chart to SPY on the matching timeframe + RTH-only.
2. Add studies: `MovAvgExponential` (9, 21), `MACD`, `StochasticFull` (14, 3, 1), `BollingerBands` (20, 2.0), `ATR` (14), `DMI` (period 14, or 8 for the 1m file).
3. Hover any bar in `validate-out/<DATE>/indicators-<TF>.csv` and compare each study readout vs the matching CSV columns.

Caveats:
- 1m DMI uses period **8** in the system — set ToS DMI period to 8 when checking the 1m file.
- DMI/ATR run with `skipSessionGaps=true`. ToS matches when the chart is RTH-only; on a 24H chart, ToS will differ.
- VWAP resets at midnight ET (calendar day) in both systems.

For full bar-by-bar diff:
```bash
# In ToS: chart → Save Time Series As… → CSV → save as ~/Downloads/spy-tos-1m.csv
diff <(cut -d, -f1-7 validate-out/2026-04-23/bars-1m.csv | sort) \
     <(cut -d, -f1-7 ~/Downloads/spy-tos-1m.csv         | sort)
```

## Layer 3 — Decision determinism

Locks down the decision pipeline (`detectDirection` + every indicator) with a snapshot test. Once recorded, runs entirely offline — no Alpaca, no live state.

```bash
# One-time: record a fixture (needs Alpaca creds)
npx tsx src/scripts/validate/validate-decisions.ts --record 2026-04-23 SPY 10:30
# writes ./src/scripts/validate/fixtures/SPY-2026-04-23-10-30.json

# Validate every fixture (offline, run anytime):
npx tsx src/scripts/validate/validate-decisions.ts
#   ✓ SPY-2026-04-23-10-30.json
#   ...
#   N passed, 0 failed (tolerance 1e-6)
```

A fixture stores:
- `fixture.{ltfBars, mtfBars, htfBars}` — exact bar arrays used as input
- `golden.{ltf, mtf, htf, direction, dmiTrends}` — every indicator value computed + the direction call

On replay the script recomputes everything from `fixture.*Bars` and asserts byte-equal (within `1e-6`) to `golden`. A fail means an indicator or direction-detector edit changed behavior. Regenerate (`--record`) only after confirming the new output is right.

**Suggested fixture set** (covers regimes; takes ~30s to record):
```bash
npx tsx src/scripts/validate/validate-decisions.ts --record 2026-04-15 SPY 09:45  # full-bear DMI
npx tsx src/scripts/validate/validate-decisions.ts --record 2026-04-15 SPY 13:00  # LTF flip
npx tsx src/scripts/validate/validate-decisions.ts --record 2026-04-23 SPY 10:15  # split DMI
npx tsx src/scripts/validate/validate-decisions.ts --record 2026-04-23 SPY 15:30  # full-bull DMI
npx tsx src/scripts/validate/validate-decisions.ts --record 2026-05-01 SPY 11:00  # full-bear
```

---

## What this proves end-to-end

- **Layer 1a + 1b pass** ⇒ Two independent feeds (Alpaca SIP and Yahoo Finance) agree on inputs at industry tolerance. The backtest is fed correctly.
- **Layer 1c pass** ⇒ Bar shape, rollups, and OHLC are self-consistent.
- **Layer 2a pass** ⇒ Every indicator agrees with an independent textbook reference to `1e-9`. The math is correct per canonical formulas.
- **Layer 2b pass** ⇒ The same indicators also match `pandas-ta` (separate language, separate code, widely used in industry).
- **Layer 2c (optional) pass** ⇒ ToS chart values also match.
- **Layer 3 pass** ⇒ The decision pipeline is a pure function of bars. Same input → same output, run after run.

**Together:** the backtest is a deterministic function of public market data, computed correctly per textbook formulas, with both data and math validated against multiple independent third-party witnesses. Disagreements between the backtest's verdict and a trader's expectation are about *strategy*, not *math*.

## What this does **not** prove

- **Live ↔ backtest parity.** Live can read a partial in-progress bar, persist state across restarts, or hit feed delays. Live parity needs a different track (snapshot replay; see `project_live_backtest_parity` memory).
- **Strategy correctness.** Whether a given direction call is the right call is a strategy question, not a data/math question. This proof scope ends at "the math agrees with multiple references."
