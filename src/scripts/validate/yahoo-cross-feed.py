#!/usr/bin/env python3
"""
yahoo-cross-feed.py — Independent feed cross-check.

Fetches SPY 1-minute bars from Yahoo Finance (a separate data provider from
Alpaca SIP), aligns by minute against our `dump-bars.ts` CSV, and reports OHLCV
agreement at three tolerance levels:

  STRICT   (±$0.00, byte-equal):    informational — different feeds aggregate
                                    trades differently, so will rarely match
  PENNY    (±$0.01):                tight cent-level match
  FEED     (±$0.05 ≈ 0.01% on $720): industry-normal SIP-vs-Yahoo aggregation
                                    noise

Verdict is PASS if ≥99% of bars match within FEED tolerance — the rare bar
exceeding 5¢ is a feed-aggregation outlier (one feed including a midpoint
quote the other excludes), not a system bug.

Volume is reported informationally; SIP and Yahoo's feed are known to differ
in coverage of off-exchange prints.

Usage:
  python3 src/scripts/validate/yahoo-cross-feed.py [DATE] [DATE2 ...]
  Defaults to 2026-05-01.

Requires: dump-bars.ts has already been run for each DATE
          (script reads validate-out/<DATE>/bars-1m.csv).
No external Python deps — uses stdlib only.
"""
import csv, json, sys
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from datetime import datetime, timezone
import zoneinfo

DATES = sys.argv[1:] if len(sys.argv) > 1 else ["2026-05-01"]
TICKER = "SPY"
ET = zoneinfo.ZoneInfo("America/New_York")
PASS_PCT = 0.99  # ≥99% bars within FEED tolerance


def fetch_yahoo(date: str) -> dict:
    """Fetch 1m bars for `date` from Yahoo Finance v8 chart API. Returns
    {'HH:MM': (O, H, L, C, V)} keyed by ET time-of-day, RTH only."""
    day = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
    p1 = int(day.timestamp())
    p2 = p1 + 36 * 3600
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}?{urlencode({'interval': '1m', 'period1': p1, 'period2': p2, 'includePrePost': 'false'})}"
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    result = data["chart"]["result"][0]
    ts_arr = result["timestamp"]
    q = result["indicators"]["quote"][0]
    out = {}
    for i, ts in enumerate(ts_arr):
        et = datetime.fromtimestamp(ts, tz=ET)
        if et.strftime("%Y-%m-%d") != date:
            continue
        mins = et.hour * 60 + et.minute
        if mins < 9 * 60 + 30 or mins >= 16 * 60:
            continue
        if q["open"][i] is None:
            continue
        out[et.strftime("%H:%M")] = (
            q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i] or 0,
        )
    return out


def read_alpaca(date: str) -> dict:
    """Read bars-1m.csv emitted by dump-bars.ts."""
    out = {}
    with open(f"validate-out/{date}/bars-1m.csv") as f:
        for r in csv.DictReader(f):
            out[r["Time"]] = (
                float(r["Open"]), float(r["High"]), float(r["Low"]),
                float(r["Close"]), int(r["Volume"]),
            )
    return out


TOLERANCES = [("STRICT", 0.0), ("PENNY", 0.01), ("FEED", 0.05)]


def diff_day(date: str):
    print(f"── {date} ──────────────────────────────")
    yah = fetch_yahoo(date)
    alp = read_alpaca(date)
    common = sorted(set(yah) & set(alp))
    print(f"  Bar counts: Alpaca={len(alp)}, Yahoo={len(yah)}, common={len(common)}")

    fields = ["Open", "High", "Low", "Close"]
    deltas = {f: [] for f in fields}
    for t in common:
        a = alp[t]; y = yah[t]
        for i, f in enumerate(fields):
            deltas[f].append(abs(a[i] - y[i]))

    for label, tol in TOLERANCES:
        line = f"  {label:6s} (±${tol:.2f}): "
        for f in fields:
            ok = sum(1 for d in deltas[f] if d <= tol)
            mark = "✓" if ok == len(common) else "✗"
            line += f"{f}={mark}{ok}/{len(common)}  "
        print(line)

    av = sum(alp[t][4] for t in common)
    yv = sum(yah[t][4] for t in common)
    ratio = yv / av if av else 0
    print(f"  Volume: alpaca={av:,}  yahoo={yv:,}  ratio={ratio:.3f}")

    worst = "  Worst |Δ| per field:  "
    for f in fields:
        worst += f"{f}=${max(deltas[f]):.4f}  "
    print(worst); print()
    return deltas, len(common)


all_deltas = {f: [] for f in ["Open", "High", "Low", "Close"]}
total_bars = 0
for d in DATES:
    deltas, n = diff_day(d)
    for f in all_deltas:
        all_deltas[f].extend(deltas[f])
    total_bars += n

print(f"\n{'═' * 68}")
print(f"  AGGREGATE across {len(DATES)} day(s), {total_bars} bars")
print(f"{'═' * 68}")
for label, tol in TOLERANCES:
    line = f"  {label:6s} (±${tol:.2f}): "
    for f in ["Open", "High", "Low", "Close"]:
        ok = sum(1 for d in all_deltas[f] if d <= tol)
        line += f"{f}={ok}/{total_bars} ({100 * ok / total_bars:.2f}%)  "
    print(line)

# Verdict: PASS if ≥99% of bars match within FEED tolerance for every field.
feed_pass_rates = {
    f: sum(1 for d in all_deltas[f] if d <= 0.05) / total_bars
    for f in ["Open", "High", "Low", "Close"]
}
worst = min(feed_pass_rates.values())
verdict_pass = worst >= PASS_PCT
print(f"\n  Verdict: {'✓ PASS' if verdict_pass else '✗ FAIL'} "
      f"— worst-field FEED match rate {worst * 100:.2f}% (threshold ≥{PASS_PCT * 100:.0f}%)")
print(f"  (cross-feed price-aggregation noise of <5¢ on $720 stock is industry-normal;")
print(f"   isolated bars exceeding 5¢ are typically off-exchange prints one feed includes)")
sys.exit(0 if verdict_pass else 1)
