"""Stress the Asian-session fade: other periods, another gold token, wider spreads, month-by-month."""
import sys

import numpy as np
import pandas as pd

from engine import Market, load, stats
from strategies import fade

PAXG, XAUT = sys.argv[1], sys.argv[2]
CFG = dict(tf="15min", k=3.0, sl_atr=1.5, tp=1.0, start_h=2, end_h=10)
NEIGHBOURS = [dict(CFG, **d) for d in (dict(sl_atr=2.5, tp=0.5), dict(start_h=1), dict(end_h=8), dict(k=2.75),
                                         dict(k=3.25), dict(tp=1.25), dict(sl_atr=2.0))]


def line(label, s):
    print("%-34s PF %5.2f win %4.1f%% avgR %+.2f trades %4d (%4.1f/mo) ret %+6.1f%% dd %4.1f%%" % (
        label, s["pf"], s["win"], s["avgR"], s["trades"], s["per_month"], s["ret"], s["dd"]))


m_old = load(PAXG, "2023-12-01", "2025-06-01")
mk_old = Market(m_old)
m_new = load(PAXG, "2025-05-01")
mk_new = Market(m_new)

print("== Chosen settings", CFG)
tr_old = mk_old.run(fade(m_old, **CFG))
tr = mk_new.run(fade(m_new, **CFG))
line("2024-01..2025-05 ($1-tick data)", stats(tr_old, 1, "2024-01-01", "2025-06-01"))
line("train 2025-06..2026-01", stats(tr, 1, "2025-06-01", "2026-02-01"))
line("test  2026-02..2026-10", stats(tr, 1, "2026-02-01", "2026-11-01"))
line("all cent data 2025-06..2026-10", stats(tr, 1, "2025-06-01", "2026-11-01"))

mx = load(XAUT, "2026-03-26")
trx = Market(mx).run(fade(mx, **CFG))
line("XAUT token 2026-04..2026-10", stats(trx, 1, "2026-04-10", "2026-11-01"))
line("PAXG same window", stats(tr, 1, "2026-04-10", "2026-11-01"))

print("\n== Spread stress (all cent data)")
for sp in (0.30, 0.40, 0.50, 0.70):
    line(f"spread ${sp:.2f}", stats(mk_new.run(fade(m_new, **CFG), spread=sp), 1, "2025-06-01", "2026-11-01"))

print("\n== Neighbouring settings (all cent data)")
for n in NEIGHBOURS:
    diff = {k: v for k, v in n.items() if CFG[k] != v}
    line(str(diff), stats(mk_new.run(fade(m_new, **n)), 1, "2025-06-01", "2026-11-01"))

print("\n== Month by month (R per month, chosen settings)")
t = tr[tr.entry_t >= np.datetime64("2025-06-01")]
mon = t.groupby(pd.to_datetime(t.entry_t).dt.to_period("M")).R.agg(["count", "sum"])
print(mon.round(2).T.to_string())
print("green months: %d of %d" % ((mon["sum"] > 0).sum(), len(mon)))
print("long R %+.2f (%d)  short R %+.2f (%d)" % (t[t.dir > 0].R.mean(), (t.dir > 0).sum(), t[t.dir < 0].R.mean(), (t.dir < 0).sum()))
hours = pd.to_datetime(t.entry_t).dt.tz_localize("UTC").dt.tz_convert("America/New_York").dt.tz_localize(None) + pd.Timedelta(hours=7)
print(t.groupby(hours.dt.hour.values).R.agg(["count", "mean"]).round(2).T.to_string())
