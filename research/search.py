"""Grid-search each strategy family on the training months, then score the chosen settings on months it never saw.

Train: 2025-06-01 .. 2026-02-01 (8 months, cent-priced data).  Test: 2026-02-01 .. 2026-11-01 (9 months).
A family's settings are chosen on train only; test numbers are reported for that one choice.
"""
import itertools, json, sys
from multiprocessing import Pool

import numpy as np
import pandas as pd

from engine import Market, load, stats
import strategies as S

D = sys.argv[1]
TRAIN = ("2025-06-01", "2026-02-01")
TEST = ("2026-02-01", "2026-11-01")

GRIDS = {
    "asian_breakout": (S.range_breakout, dict(
        r_start=[1, 2, 3], r_end=[9, 10], trade_end=[13, 15], stop=["mid", "far", "atr"], tp=[1.5, 2.0, 3.0],
        be=[0.0, 1.0], max_stop=[15.0, 30.0])),
    "ny_open_breakout": (S.range_breakout, dict(
        ny_open=[True], r_end=[15, 30, 60], trade_end=[120, 240], stop=["mid", "far", "atr"], tp=[1.5, 2.0, 3.0],
        be=[0.0, 1.0], max_stop=[15.0, 30.0], exit_h=[23])),
    "prev_day_breakout": (S.prev_day_breakout, dict(
        start_h=[3, 10], end_h=[16, 20], sl_atr=[1.0, 2.0, 3.0], tp=[1.5, 2.0, 3.0], be=[0.0, 1.0], tf=["5min", "15min"])),
    "donchian_h1": (S.donchian, dict(
        tf=["1h"], n=[20, 40, 55], sl_atr=[2.0, 3.0], tp=[0.0, 3.0], be=[0.0, 1.0], trail_atr=[2.0, 3.0, 4.0])),
    "donchian_m15": (S.donchian, dict(
        tf=["15min"], n=[20, 40, 80], sl_atr=[1.5, 2.5], tp=[0.0, 2.0, 3.0], be=[0.0, 1.0], trail_atr=[2.0, 3.0],
        start_h=[9], end_h=[20])),
    "squeeze": (S.squeeze, dict(
        tf=["5min", "15min"], pct=[0.1, 0.2], k=[1.5, 2.0], sl_atr=[1.0, 1.5, 2.5], tp=[1.5, 2.0, 3.0], be=[0.0, 1.0])),
    "asian_fade": (S.fade, dict(
        tf=["5min", "15min"], k=[2.0, 2.5, 3.0], sl_atr=[1.0, 1.5, 2.5], tp=[0.5, 1.0, 1.5], start_h=[1, 2], end_h=[8, 10])),
    "pullback": (S.pullback, dict(
        sl_atr=[1.0, 1.5, 2.5], tp=[1.5, 2.0, 3.0], be=[0.0, 1.0], tf=["5min", "15min"])),
}

M1 = MK = None


def init():
    global M1, MK
    M1 = load(D, "2025-01-01")
    MK = Market(M1)


def run_one(job):
    name, params = job
    fn = GRIDS[name][0]
    try:
        tr = MK.run(fn(M1, **params))
    except Exception as e:  # a bad combination should not kill the sweep
        return name, params, None, None, repr(e)
    return name, params, stats(tr, 1.0, *TRAIN), stats(tr, 1.0, *TEST), None


def score(s):
    # Reward edge per trade, need a real sample, punish deep drawdowns.
    if s is None or s["trades"] < 30 or not np.isfinite(s["pf"]):
        return -1e9
    return (s["pf"] - 1) * np.sqrt(s["trades"]) - 0.02 * s["dd"]


if __name__ == "__main__":
    jobs = []
    for name, (_, grid) in GRIDS.items():
        keys = list(grid)
        for combo in itertools.product(*(grid[k] for k in keys)):
            jobs.append((name, dict(zip(keys, combo))))
    print(len(jobs), "settings", flush=True)
    with Pool(4, initializer=init) as p:
        rows = p.map(run_one, jobs, chunksize=4)
    out = [dict(family=n, params=pr, train=tr, test=te, err=e) for n, pr, tr, te, e in rows]
    json.dump(out, open(sys.argv[2], "w"), default=float)
    errs = [r for r in out if r["err"]]
    print(len(errs), "errors", errs[:2])
    for fam in GRIDS:
        rs = [r for r in out if r["family"] == fam and r["train"]]
        rs.sort(key=lambda r: score(r["train"]), reverse=True)
        best = rs[0]
        pos = np.mean([r["test"]["pf"] > 1 for r in rs if r["test"]["trades"] >= 20]) * 100
        f = lambda s: "PF %.2f win %4.1f%% R %+.2f trades %4d ret %+6.1f%% dd %4.1f%%" % (
            s["pf"], s["win"], s["avgR"], s["trades"], s["ret"], s["dd"])
        print(f"\n== {fam}: {len(rs)} settings, {pos:.0f}% of them profitable on test")
        print("  chosen ", best["params"])
        print("  TRAIN  ", f(best["train"]))
        print("  TEST   ", f(best["test"]))
