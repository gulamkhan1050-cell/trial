"""Bar-by-bar gold backtester on 1-minute data.

Signals are generated on higher timeframes (M5, H1) and filled on the next 1-minute open. Every
trade is then walked minute by minute: stop-loss first when stop and target fall inside the same
minute (the pessimistic order), breakeven and trailing stops move on minute closes, positions are
closed before the weekend gap, and overnight holds pay the broker's swap.

Prices are PAXG/USDT trade prices, used as the XAUUSD mid; a fixed spread and slippage are added on
top. All times are UTC; `server` columns are broker server time (New York time + 7 hours, the
convention MetaQuotes-Demo and most MT5 gold brokers use: GMT+2 in winter, GMT+3 in summer).
"""
import numpy as np
import pandas as pd
from numba import njit

SPREAD = 0.30      # $ per oz, typical XAUUSD retail spread
SLIP = 0.05        # $ per oz on market entries and stop exits
SWAP_LONG = 0.126  # $ per oz per night (MetaQuotes-Demo: -12.6 points at 100 oz/lot)
SWAP_SHORT = 0.046


def load(path, start=None, end=None):
    d = pd.read_csv(path)
    d.index = pd.to_datetime(d.pop("t"), unit="ms", utc=True)
    if start:
        d = d[d.index >= pd.Timestamp(start, tz="UTC")]
    if end:
        d = d[d.index < pd.Timestamp(end, tz="UTC")]
    server = d.index.tz_convert("America/New_York").tz_localize(None) + pd.Timedelta(hours=7)
    # Gold trades Monday 00:00 to Friday 23:59 server time; PAXG also trades the weekend.
    d = d[(server.dayofweek < 5)]
    d["server"] = d.index.tz_convert("America/New_York").tz_localize(None) + pd.Timedelta(hours=7)
    return d


def resample(m1, rule):
    o = m1.resample(rule, label="left", closed="left").agg(
        {"o": "first", "h": "max", "l": "min", "c": "last", "v": "sum"}).dropna()
    o["server"] = o.index.tz_convert("America/New_York").tz_localize(None) + pd.Timedelta(hours=7)
    return o


def ema(x, n):
    return x.ewm(span=n, adjust=False).mean()


def atr(b, n=14):
    pc = b.c.shift()
    tr = pd.concat([b.h - b.l, (b.h - pc).abs(), (b.l - pc).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean()  # MT5's iATR is a simple average of true range


@njit(cache=True)
def _simulate(o, h, l, c, gap_after, rollover, sig_i, sig_dir, sig_dist, sig_tp, sig_be, sig_trail,
              sig_texit, hs, slip, swap_l, swap_s):
    n = len(sig_i)
    out = np.full((n, 5), np.nan)  # entry_i, exit_i, dir, pnl per oz, risk per oz
    busy_until = -1
    k = 0
    for s in range(n):
        i = sig_i[s]
        if i <= busy_until or i >= len(o):
            continue
        d = sig_dir[s]
        dist = sig_dist[s]
        entry = o[i] + d * (hs + slip)
        sl = entry - d * dist
        tp = entry + d * sig_tp[s] * dist if sig_tp[s] > 0 else np.nan
        be_hit = False
        swap = 0.0
        j = i
        exit_px = np.nan
        while j < len(o):
            if j >= sig_texit[s]:
                exit_px = o[j] - d * hs
                break
            if d > 0:
                if l[j] - hs <= sl:
                    exit_px = min(sl, o[j] - hs) - slip
                    break
                if tp == tp and h[j] - hs >= tp:
                    exit_px = tp
                    break
                px = c[j] - hs
                if sig_be[s] > 0 and px - entry >= sig_be[s] * dist:
                    be_hit = True
                if be_hit:
                    sl = max(sl, entry + 0.1 * dist, px - sig_trail[s])
            else:
                if h[j] + hs >= sl:
                    exit_px = max(sl, o[j] + hs) + slip
                    break
                if tp == tp and l[j] + hs <= tp:
                    exit_px = tp
                    break
                px = c[j] + hs
                if sig_be[s] > 0 and entry - px >= sig_be[s] * dist:
                    be_hit = True
                if be_hit:
                    sl = min(sl, entry - 0.1 * dist, px + sig_trail[s])
            swap += rollover[j] * (swap_l if d > 0 else swap_s)
            if gap_after[j]:
                exit_px = c[j] - d * hs
                break
            j += 1
        if exit_px != exit_px:
            continue
        out[k, 0] = i
        out[k, 1] = j
        out[k, 2] = d
        out[k, 3] = d * (exit_px - entry) - swap
        out[k, 4] = dist
        busy_until = j
        k += 1
    return out[:k]


class Market:
    def __init__(self, m1):
        self.m1 = m1
        self.t = m1.index.values
        self.o, self.h, self.l, self.c = (m1[k].to_numpy(np.float64) for k in "ohlc")
        gaps = np.diff(self.t).astype("timedelta64[m]").astype(np.int64)
        self.gap_after = np.append(gaps > 360, True)  # weekend / holiday: flat before the gap
        sv = m1.server
        self.rollover = ((sv.dt.hour == 0) & (sv.dt.minute == 0)).to_numpy(np.float64)
        self.rollover[(sv.dt.dayofweek == 3).to_numpy() & (self.rollover > 0)] = 3.0  # triple swap

    def index_at(self, times):
        """1-minute bar index at or after each timestamp (the next open after a signal bar closes)."""
        return np.searchsorted(self.t, np.asarray(times, dtype="datetime64[ns]"))

    def run(self, sig, spread=SPREAD, slip=SLIP):
        """sig: DataFrame with columns time (fill time), dir, dist, tp, be, trail, texit (fill-time limit)."""
        if len(sig) == 0:
            return pd.DataFrame(columns=["entry", "exit", "dir", "pnl", "risk", "R"])
        sig = sig.sort_values("time")
        i = self.index_at(sig.time.values)
        tex = self.index_at(sig.texit.values) if "texit" in sig else np.full(len(sig), 1 << 62)
        out = _simulate(self.o, self.h, self.l, self.c, self.gap_after, self.rollover,
                        i.astype(np.int64), sig.dir.to_numpy(np.float64), sig.dist.to_numpy(np.float64),
                        sig.tp.to_numpy(np.float64), sig.be.to_numpy(np.float64),
                        sig.trail.to_numpy(np.float64), tex.astype(np.int64), spread / 2, slip,
                        SWAP_LONG, SWAP_SHORT)
        tr = pd.DataFrame(out, columns=["entry", "exit", "dir", "pnl", "risk"])
        tr["entry_t"] = self.t[tr.entry.astype(int)]
        tr["exit_t"] = self.t[tr.exit.astype(int)]
        tr["R"] = tr.pnl / tr.risk
        return tr


def stats(tr, risk_pct=1.0, start=None, end=None):
    """Profit factor and win rate on R; drawdown and return on a compounding account risking risk_pct a trade."""
    if start is not None:
        tr = tr[(tr.entry_t >= pd.Timestamp(start).to_datetime64()) & (tr.entry_t < pd.Timestamp(end).to_datetime64())]
    n = len(tr)
    if n == 0:
        return dict(trades=0, pf=np.nan, win=np.nan, avgR=np.nan, ret=0.0, dd=0.0, per_month=0.0)
    R = tr.R.to_numpy()
    eq = np.cumprod(1 + R * risk_pct / 100)
    peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))[1:]
    gp, gl = R[R > 0].sum(), -R[R < 0].sum()
    months = max((tr.entry_t.max() - tr.entry_t.min()) / np.timedelta64(30, "D"), 1)
    return dict(trades=n, pf=gp / gl if gl > 0 else np.inf, win=(R > 0).mean() * 100, avgR=R.mean(),
                ret=(eq[-1] - 1) * 100, dd=((peak - eq) / peak).max() * 100, per_month=n / months)
