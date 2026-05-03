# Backtest Correctness Proof — SPY

Eight scripts that prove the backtest is correct via **four independent witnesses** without using any live system data or output. Each layer isolates a single component so a failure points at exactly one thing.

| Layer | Script | What it proves | Witness |
| --- | --- | --- | --- |
| 1a. Bars (data) | `dump-bars.ts` | Backtest's input OHLCV is what Alpaca SIP serves | Alpaca SIP |
| 1b. Bars (cross-feed) | `yahoo-cross-feed.py` | Same bars as Yahoo Finance at industry tolerance | Yahoo Finance |
| 1c. Invariants | `check-invariants.py` | 1m/5m/15m self-consistency, RTH bar counts, rollups | (self) |
| 2a. Indicators (textbook) | `self-check.ts` | Math agrees with textbook reference impl to `1e-9` | TS textbook ref |
| 2b. Indicators (library) | `pandas-ta-cross-check.py` | Math agrees with `pandas-ta` Python library at 6-dec | pandas-ta |
| 2c. Indicators (ToS) | `dump-indicators.ts` | CSVs ready for manual ToS export-and-diff | ToS (manual) |
| 3. Decisions | `validate-decisions.ts` | Direction + indicators are pure functions of bars | (snapshot) |
| 4. Order-sim | `validate-order-sim.ts` | Exit rules (stop/TP/trailing/...) deterministic from bars | (snapshot) |
| 5. Missed-corpus | `validate-missed-corpus.ts` | Ideal-entry detector grades real, direction-aligned, sustained moves | (nulls) |

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

## Layer 4 — Order-sim determinism

Locks down the order-agent simulation that decides when an entry exits — `simulateOrderAgent` (shared) and `simulateOrderAgentSpy` (SPY-specific). Mirrors all 10 documented exit rules: hard stop, take-profit, profit-reversal, trailing decay, small-gain lock, bad-entry fast-cut, rapid decline, etc. Once a fixture is recorded, replay is fully offline.

```bash
# One-time: record a fixture (needs Alpaca creds)
npx tsx src/scripts/validate/validate-order-sim.ts \
  --record 2026-05-01 SPY 11:00 bullish spy
# writes ./src/scripts/validate/fixtures/order-sim/spy-SPY-2026-05-01-11-00-bullish.json

# Validate every fixture (offline, run anytime):
npx tsx src/scripts/validate/validate-order-sim.ts
#   ✓ spy-SPY-2026-05-01-11-00-bullish.json   STOP 2m -20.00%
#   ✓ spy-SPY-2026-05-01-11-00-bearish.json   TP   2m +20.38%
#   ...
```

A fixture stores `{ticker, date, timeET, direction, variant, entryPrice, atr, recentBars, futureBars, cfg}` and the golden `SimResult` (exit reason / price / hold minutes / pnlPct / peakPnlPct / maxDrawdownPct). Recompute on replay must match at `1e-6`.

**Suggested fixture set** (covers exit-rule paths):
```bash
# Hard STOP (entry against trend, bullish over bear day)
... --record 2026-05-01 SPY 11:00 bullish spy
# TP hit (entry with strong move)
... --record 2026-05-01 SPY 11:00 bearish spy
# TRAILING_DECAY (peak then fade)
... --record 2026-04-15 SPY 10:30 bullish spy
# BAD_ENTRY (immediate adverse, never confirmed)
... --record 2026-04-15 SPY 09:45 bearish spy
# SMALL_GAIN_LOCK (peak 1-5%, fade near zero)
... --record 2026-04-23 SPY 10:15 bullish spy
```

**Variant** (last arg): `spy` uses `simulateOrderAgentSpy` (5x premium floor for $720 stock); `base` uses the shared `simulateOrderAgent`. Record both to lock down both code paths.

## Layer 5 — Missed-corpus detector

Validates `findIdealEntries` (the ideal-entry detector that produces the missed-entry corpus used for filter mining). Five witnesses, all run from the same fetched bars:

```bash
npx tsx src/scripts/validate/validate-missed-corpus.ts 2026-04-01:2026-05-01 SPY
#   [PASS] 1. mechanical recompute (1e-9)         — 118/118 match
#   [PASS] 2. reachability (peak vs entry)        — 118/118 reachable
#   [PASS] 3. causal volume (no future leak)      — 118/118 invariant under truncation
#   [PASS] 4. direction-flip null (<30% survive)  — 0/118 (0.0%)
#   [PASS] 5. time-jitter null (median ≥50%)      — median = 98.8%
```

What each witness rules out:
- **1. Mechanical** — clean-room MFE/MAE re-implementation must agree with the library's reported figures to 1e-9. Catches indexing/bar-offset bugs.
- **2. Reachability** — every ideal's `peakPrice` must be on the correct side of `entryPrice` (long peak ≥ entry, short peak ≤ entry). Catches direction-mislabeling regressions.
- **3. Causal volume** — re-run the detector on `bars.slice(0, idealBar + windowMin + 1)` and confirm `entryVolMult` is unchanged. Detects future-bar leakage in the volume baseline. Was a real bug fixed alongside this script (full-window mean → session-to-date prefix sum).
- **4. Direction-flip null** — flip every ideal's direction, re-grade. Healthy <30%; the 3-of-5 candle gate should make this near 0. >50% would mean the detector is volatility-driven, not direction-driven.
- **5. Time-jitter null** — shift the decision bar by ±1, ±2 bars, recompute MFE retention. Healthy median ≥50%; sub-minute wicks collapse to ~10-20%. Catches "ideals" that are sub-minute spikes the strategy couldn't realistically catch.

What this layer does **not** prove:
- **Tradability** — that the option leg corresponding to a graded ideal actually pays out under realistic spread + exit policy. That needs an order-sim re-grade pass (separate, larger track).
- **Backtest match completeness** — `bt_status` and `verdict` classification accuracy belong to `build-missed-corpus.ts` and aren't covered here.

---

## What this proves end-to-end

- **Layer 1a + 1b pass** ⇒ Two independent feeds (Alpaca SIP and Yahoo Finance) agree on inputs at industry tolerance. The backtest is fed correctly.
- **Layer 1c pass** ⇒ Bar shape, rollups, and OHLC are self-consistent.
- **Layer 2a pass** ⇒ Every indicator agrees with an independent textbook reference to `1e-9`. The math is correct per canonical formulas.
- **Layer 2b pass** ⇒ The same indicators also match `pandas-ta` (separate language, separate code, widely used in industry).
- **Layer 2c (optional) pass** ⇒ ToS chart values also match.
- **Layer 3 pass** ⇒ The decision pipeline (direction + indicator outputs) is a pure function of bars. Same input → same output, run after run.
- **Layer 4 pass** ⇒ The exit pipeline (stops, targets, trailing, profit-reversal) is also a pure function of bars + entry. Refactors that claim to be no-ops actually are.
- **Layer 5 pass** ⇒ The ideal-entry detector grades real, direction-aligned, sustained price moves — not volatility, not future-leaked volume thresholds, not sub-minute wicks. The missed-corpus is a sound foundation for filter mining.

**Together:** the backtest is a deterministic function of public market data, computed correctly per textbook formulas, with both data and math validated against multiple independent third-party witnesses. Disagreements between the backtest's verdict and a trader's expectation are about *strategy*, not *math*.

## What this does **not** prove

- **Live ↔ backtest parity.** Live can read a partial in-progress bar, persist state across restarts, or hit feed delays. Live parity needs a different track (snapshot replay; see `project_live_backtest_parity` memory).
- **Strategy correctness.** Whether a given direction call is the right call, or whether an exit rule's parameters are correct, is a strategy question. This proof scope ends at "the math is right and the code is deterministic."
- **`validate-change.ts` self-correctness.** The meta-tool that runs backtests before/after a candidate change is not yet covered (its stash/pop, baseline cache, and verdict logic are still on faith).
- **Other indicators not in `self-check.ts`** (OBV, TD-sequential, candle patterns, price-structure, market-structure, price-velocity, volume-surge) and the topology pipeline.
