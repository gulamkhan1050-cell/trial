"""Re-run the pullback strategy that MT5 tested, on the same dates, to check this backtester against MT5."""
import sys, time
from engine import load, Market, stats
from strategies import pullback

D = sys.argv[1]
t0 = time.time()
m1 = load(D, "2024-12-01", "2026-10-01")
mk = Market(m1)
tr = mk.run(pullback(m1))
print("loaded+run %.0fs" % (time.time() - t0))
s = stats(tr, 1.0, "2025-06-01", "2026-10-01")
print({k: round(v, 3) for k, v in s.items()})
sub = tr[(tr.entry_t >= __import__("numpy").datetime64("2025-06-01"))]
print("avg win R %.2f  avg loss R %.2f  longs %d shorts %d" % (sub.R[sub.R > 0].mean(), sub.R[sub.R < 0].mean(),
      (sub.dir > 0).sum(), (sub.dir < 0).sum()))
