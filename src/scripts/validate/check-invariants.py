#!/usr/bin/env python3
"""
check-invariants.py — Self-consistency invariants on the validate-out CSVs.

Verifies (no Alpaca, no Yahoo, no ToS — pure self-checks):
  - 1m / 5m / 15m bar counts equal expected RTH counts (390 / 78 / 26)
  - 1m bars are time-monotonic and span 09:30 → 15:59 ET
  - Session OHLC computed from 1m CSV equals session-summary.txt
  - 5m and 15m bars are correct rollups of 1m bars
    (Open=first 1m, High=max, Low=min, Close=last, Volume=sum)

Usage:
  python3 src/scripts/validate/check-invariants.py [DATE ...]
  Defaults to 2026-04-15 2026-04-23 2026-05-01.

Requires: dump-bars.ts has been run for each DATE.
No external Python deps — uses stdlib only.
"""
import csv, sys, os
from collections import defaultdict


def to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def read_csv(path: str):
    with open(path) as f:
        return list(csv.DictReader(f))


def near(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) < tol


def rollup(bars1m, n: int):
    groups = defaultdict(list)
    for b in bars1m:
        mins = to_minutes(b["Time"])
        bucket_min = (mins // n) * n
        groups[bucket_min].append(b)
    out = []
    for bm in sorted(groups):
        grp = groups[bm]
        out.append({
            "Time": f"{bm // 60:02d}:{bm % 60:02d}",
            "Open": float(grp[0]["Open"]),
            "High": max(float(b["High"]) for b in grp),
            "Low": min(float(b["Low"]) for b in grp),
            "Close": float(grp[-1]["Close"]),
            "Volume": sum(int(b["Volume"]) for b in grp),
        })
    return out


def cmp_aggregations(actual, expected, label, fail):
    if len(actual) != len(expected):
        fail.append(f"{label} count: csv={len(actual)} rolled={len(expected)}")
        return
    for a, e in zip(actual, expected):
        for k in ("Open", "High", "Low", "Close"):
            av, ev = float(a[k]), e[k]
            if not near(av, ev):
                fail.append(f"{label} {a['Time']}.{k}: csv={av} rolled={ev}")
        if int(a["Volume"]) != e["Volume"]:
            fail.append(f"{label} {a['Time']}.Volume: csv={a['Volume']} rolled={e['Volume']}")


def check_day(date: str):
    base = f"validate-out/{date}"
    if not os.path.exists(base):
        return [f"{base}/ not found — run dump-bars.ts {date} SPY first"]

    one = read_csv(f"{base}/bars-1m.csv")
    five = read_csv(f"{base}/bars-5m.csv")
    fifteen = read_csv(f"{base}/bars-15m.csv")

    fail = []

    # Bar counts
    if len(one) != 390:    fail.append(f"1m count {len(one)} != 390")
    if len(five) != 78:    fail.append(f"5m count {len(five)} != 78")
    if len(fifteen) != 26: fail.append(f"15m count {len(fifteen)} != 26")

    # Session OHLC self-consistency
    sess_open = float(one[0]["Open"])
    sess_close = float(one[-1]["Close"])
    sess_high = max(float(b["High"]) for b in one)
    sess_low = min(float(b["Low"]) for b in one)
    sess_vol = sum(int(b["Volume"]) for b in one)

    summary = {}
    for line in open(f"{base}/session-summary.txt").read().splitlines():
        if ":" in line and any(k in line for k in ("Open", "High", "Low", "Close", "Volume")):
            k, v = line.strip().split(":", 1)
            summary[k.strip()] = v.strip().replace(",", "")

    if not near(sess_open, float(summary["Open"])):   fail.append(f"open: 1m={sess_open} summary={summary['Open']}")
    if not near(sess_high, float(summary["High"])):   fail.append(f"high: 1m={sess_high} summary={summary['High']}")
    if not near(sess_low, float(summary["Low"])):     fail.append(f"low: 1m={sess_low} summary={summary['Low']}")
    if not near(sess_close, float(summary["Close"])): fail.append(f"close: 1m={sess_close} summary={summary['Close']}")
    if int(sess_vol) != int(summary["Volume"]):       fail.append(f"volume: 1m={sess_vol} summary={summary['Volume']}")

    # Aggregation rollups
    cmp_aggregations(five, rollup(one, 5), "5m", fail)
    cmp_aggregations(fifteen, rollup(one, 15), "15m", fail)

    # Time monotonicity
    times1m = [to_minutes(b["Time"]) for b in one]
    if times1m != sorted(times1m):  fail.append("1m bars not in time order")
    if times1m[0] != 9 * 60 + 30:   fail.append(f"1m first bar {times1m[0]} not 09:30")
    if times1m[-1] != 15 * 60 + 59: fail.append(f"1m last bar {times1m[-1]} not 15:59")

    return fail


DATES = sys.argv[1:] if len(sys.argv) > 1 else ["2026-04-15", "2026-04-23", "2026-05-01"]
total_fail = 0
for d in DATES:
    fails = check_day(d)
    if fails:
        print(f"  ✗ {d}: {len(fails)} failures")
        for f in fails: print(f"      {f}")
        total_fail += len(fails)
    else:
        print(f"  ✓ {d}: bars=390/78/26, OHLC-summary parity, 5m/15m rollups consistent, 1m time-monotonic 09:30→15:59")

print(f"\n  {'PASS' if total_fail == 0 else 'FAIL'}: invariants on {len(DATES)} day(s), {total_fail} failure(s)")
sys.exit(1 if total_fail else 0)
