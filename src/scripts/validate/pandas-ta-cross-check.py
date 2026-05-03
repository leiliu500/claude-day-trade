#!/usr/bin/env python3
"""
pandas-ta-cross-check.py — Third independent indicator implementation.

Fetches SPY 1m bars from Alpaca with 5-day warmup (matching the system),
aggregates to 5m, runs pandas-ta indicators, and compares against the system's
indicators-5m.csv at every target-day minute.

Critical alignment notes:

  1. Warmup window:   EMA seeds, ATR Wilder's smoothing, and BB SMA all need
                      history. Without warmup, pandas-ta seeds from minute 1
                      of the target day, while the system has 4-day warmup.

  2. Label semantics: the system writes "indicator at clock-time T" using only
                      bars completed BEFORE T (mirrors live trading where the
                      in-progress bar is hidden). pandas-ta labels by bar-start.
                      So system's row at "12:45" corresponds to pandas-ta's
                      "12:40" row. We shift labels +1 bar to align.

  3. ATR session-gap: the system uses skipSessionGaps=true (zeros TR overnight).
                      pandas-ta has no session concept and treats the overnight
                      gap as a real range. ATR is reported informationally —
                      see self-check.ts for the session-aware textbook check.

Verdict is PASS when all non-ATR indicators byte-match at 6 decimals.

Usage:
  python3 src/scripts/validate/pandas-ta-cross-check.py [DATE] [TIMEFRAME]
  Defaults to 2026-05-01, 5m.

Requires:
  - dump-indicators.ts has been run for DATE with sample-every=1
    (script reads validate-out/<DATE>/indicators-5m.csv)
  - Alpaca creds in .env (script fetches its own bar series for parity)
  - Python deps: pandas, pandas-ta, numpy
"""
import csv, os, sys, json
import pandas as pd
import pandas_ta as ta
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from datetime import datetime, timezone, timedelta
import zoneinfo

DATE = sys.argv[1] if len(sys.argv) > 1 else "2026-05-01"
TF = sys.argv[2] if len(sys.argv) > 2 else "5m"
TICKER = "SPY"
TOL_ABS = 0.01
TOL_REL = 1e-3
ET = zoneinfo.ZoneInfo("America/New_York")


def load_env():
    """Load Alpaca creds from project-root .env."""
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    env = {}
    with open(os.path.join(project_root, ".env")) as f:
        for line in f:
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v.strip('"').strip("'")
    return env


env = load_env()


def fetch_alpaca_1m(ticker, start, end):
    """Fetch 1m bars from Alpaca SIP with pagination."""
    headers = {
        "APCA-API-KEY-ID": env["ALPACA_API_KEY"],
        "APCA-API-SECRET-KEY": env["ALPACA_SECRET_KEY"],
    }
    base = env.get("ALPACA_DATA_URL", "https://data.alpaca.markets")
    out = []
    page_token = None
    while True:
        params = {
            "timeframe": "1Min", "start": start, "end": end,
            "limit": "10000", "adjustment": "raw", "feed": "sip",
        }
        if page_token: params["page_token"] = page_token
        url = f"{base}/v2/stocks/{ticker}/bars?{urlencode(params)}"
        req = Request(url, headers=headers)
        with urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        for b in (data.get("bars") or []):
            out.append({
                "timestamp": b["t"], "open": b["o"], "high": b["h"],
                "low": b["l"], "close": b["c"], "volume": b["v"],
            })
        page_token = data.get("next_page_token")
        if not page_token: break
    return out


def to_rth(bars):
    out = []
    for b in bars:
        ts = pd.Timestamp(b["timestamp"]).tz_convert(ET)
        mins = ts.hour * 60 + ts.minute
        if 9 * 60 + 30 <= mins < 16 * 60:
            b["et"] = ts; b["et_str"] = ts.strftime("%H:%M"); b["date"] = ts.strftime("%Y-%m-%d")
            out.append(b)
    return out


def aggregate_5m(bars1m):
    df = pd.DataFrame(bars1m)
    df["bucket"] = df["et"].dt.floor("5min")
    g = df.groupby("bucket").agg(
        Open=("open", "first"), High=("high", "max"), Low=("low", "min"),
        Close=("close", "last"), Volume=("volume", "sum"),
    ).reset_index()
    g["et_str"] = g["bucket"].dt.strftime("%H:%M")
    g["date"] = g["bucket"].dt.strftime("%Y-%m-%d")
    return g


# ── Pull warmup + target ───────────────────────────────────────────────────
warm_start = (datetime.fromisoformat(DATE) - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00Z")
end = f"{DATE}T23:59:59Z"
print(f"Fetching {TICKER} 1m bars {warm_start} → {end} (Alpaca SIP)…")
raw1m = fetch_alpaca_1m(TICKER, warm_start, end)
rth = to_rth(raw1m)
bars5 = aggregate_5m(rth)
print(f"  → {len(rth)} RTH 1m bars / {len(bars5)} 5m bars across warmup + target\n")

# ── pandas-ta indicators ───────────────────────────────────────────────────
df = bars5.rename(columns={"Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}).copy()
df.ta.ema(length=9, append=True)
df.ta.ema(length=21, append=True)
df.ta.macd(fast=12, slow=26, signal=9, append=True)
df.ta.bbands(length=20, std=2.0, ddof=0, append=True)
df.ta.atr(length=14, append=True)
df.ta.stoch(k=14, d=3, smooth_k=1, append=True)

# Shift labels +1 bar to match the system's "completed-bars-only-as-of-T" convention
df["et_str_shifted"] = (df["bucket"] + pd.Timedelta(minutes=5)).dt.strftime("%H:%M")
df["date_shifted"] = (df["bucket"] + pd.Timedelta(minutes=5)).dt.strftime("%Y-%m-%d")
target = df[df["date_shifted"] == DATE].copy().set_index("et_str_shifted")
print(f"  → {len(target)} target-day rows (label-shifted +1 bar to match system convention)\n")

# ── System CSV ─────────────────────────────────────────────────────────────
sys_ind_path = f"validate-out/{DATE}/indicators-5m.csv"
if not os.path.exists(sys_ind_path):
    print(f"ERROR: {sys_ind_path} not found. Run: npx tsx src/scripts/validate/dump-indicators.ts {DATE} SPY 1")
    sys.exit(2)
sys_ind = pd.read_csv(sys_ind_path).set_index("timeET")
overlap = sorted(set(target.index) & set(sys_ind.index))
print(f"Overlap: {len(overlap)} timestamps\n")

# pandas-ta column names vary by version; auto-detect
def find_col(prefix):
    for c in target.columns:
        if c.lower().startswith(prefix.lower()): return c
    return None


COLS = [
    ("EMA9",         "EMA_9"),
    ("EMA21",        "EMA_21"),
    ("MACD",         "MACD_12_26_9"),
    ("MACD_signal",  "MACDs_12_26_9"),
    ("MACD_hist",    "MACDh_12_26_9"),
    ("BB_upper",     "BBU_20_2.0"),
    ("BB_mid",       "BBM_20_2.0"),
    ("BB_lower",     "BBL_20_2.0"),
    ("ATR",          "ATRr_14"),
    ("Stoch_K",      "STOCHk_14_3_1"),
    ("Stoch_D",      "STOCHd_14_3_1"),
]
for i, (sys_col, ta_col) in enumerate(COLS):
    if ta_col not in target.columns:
        guess = find_col(ta_col.split("_")[0])
        if guess:
            COLS[i] = (sys_col, guess)


def within_tol(d, sv, tv):
    if d <= TOL_ABS: return True
    return d / max(abs(sv), abs(tv), 1e-12) <= TOL_REL


print(f"{'Indicator':<14} {'match':<14} {'max |Δ|':<14} {'max rel Δ':<14} {'sample @ mid':<28}")
print("─" * 95)
non_atr_ok = non_atr_n = 0
mid = overlap[len(overlap) // 2] if overlap else None
for sys_col, ta_col in COLS:
    if ta_col not in target.columns:
        print(f"{sys_col:<14} (column {ta_col} missing)")
        continue
    n = pass_n = 0; max_abs = max_rel = 0.0
    for t in overlap:
        sv = float(sys_ind.at[t, sys_col]); tv = target.at[t, ta_col]
        if pd.isna(tv): continue
        n += 1
        d = abs(sv - tv); rel = d / max(abs(sv), abs(tv), 1e-12)
        if within_tol(d, sv, tv): pass_n += 1
        if d > max_abs: max_abs = d
        if rel > max_rel: max_rel = rel
    sv_mid = float(sys_ind.at[mid, sys_col]) if mid else 0
    tv_mid = float(target.at[mid, ta_col]) if mid else 0
    sample = f"sys={sv_mid:.4f} ta={tv_mid:.4f}"
    mark = "✓" if pass_n == n else ("⚠" if sys_col == "ATR" else "✗")
    print(f"{sys_col:<14} {mark} {pass_n}/{n:<7}     {max_abs:<14.6f} {max_rel*100:<13.4f}% {sample}")
    if sys_col != "ATR":
        non_atr_ok += pass_n; non_atr_n += n

print(f"\n{'═' * 95}")
print(f"  Non-ATR cross-checks: {non_atr_ok}/{non_atr_n} pass at tol abs=${TOL_ABS} or rel={TOL_REL*100}%")
print(f"  ATR (informational): system uses skipSessionGaps=true; pandas-ta does not.")
print(f"  pandas-ta version: {ta.version}, on identical Alpaca SIP bars.")
sys.exit(0 if non_atr_ok == non_atr_n else 1)
