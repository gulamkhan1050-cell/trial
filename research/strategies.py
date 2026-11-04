"""Entry signals. Each returns a DataFrame: time (fill time = signal bar close), dir, dist, tp, be, trail, texit."""
import numpy as np
import pandas as pd

from engine import atr, ema, resample

NEVER = pd.Timestamp("2100-01-01")


def _frame(times, dirs, dist, tp, be=0.0, trail=0.0, texit=None):
    n = len(times)
    f = pd.DataFrame({"time": pd.to_datetime(np.asarray(times)), "dir": np.asarray(dirs, float),
                      "dist": np.asarray(dist, float)})
    f["tp"] = tp
    f["be"] = be
    f["trail"] = np.broadcast_to(trail, n) if np.ndim(trail) == 0 else np.asarray(trail, float)
    f["texit"] = NEVER if texit is None else texit
    return f[(f.dist > 0) & np.isfinite(f.dist)]


def _cap_per_day(f, server, per_day):
    """server: server times aligned with f's original row positions."""
    day = pd.Series(np.asarray(server), dtype="datetime64[ns]").dt.normalize().loc[f.index]
    return f[(day.groupby(day).cumcount() < per_day).to_numpy()]


def pullback(m1, sl_atr=1.5, tp=2.0, be=1.0, trail_atr=2.0, start_h=10, end_h=22, per_day=6, tf="5min"):
    """Replica of XauPullback v1: H1 EMA50/200 trend, M5 dip into EMA20 closing back with the trend."""
    b = resample(m1, tf)
    h1 = resample(m1, "1h")
    f50, s200 = ema(h1.c, 50), ema(h1.c, 200)
    up = (f50 > s200) & (f50 > f50.shift(3))
    dn = (f50 < s200) & (f50 < f50.shift(3))
    # Trend known at a bar's close = last H1 bar closed by then.
    close_t = b.index + pd.Timedelta(tf)
    h1_close = h1.index + pd.Timedelta("1h")
    pos = np.searchsorted(h1_close.values, close_t.values, side="right") - 1
    trend = np.where(pos >= 0, np.where(up.values[pos.clip(0)], 1, np.where(dn.values[pos.clip(0)], -1, 0)), 0)
    e = ema(b.c, 20)
    a = atr(b)
    sig = np.where((trend > 0) & (b.l <= e) & (b.c > e) & (b.c > b.o), 1,
                   np.where((trend < 0) & (b.h >= e) & (b.c < e) & (b.c < b.o), -1, 0))
    sh = (b.server + pd.Timedelta(tf)).dt
    ok = (sig != 0) & (sh.hour >= start_h) & (sh.hour < end_h) & ~((sh.dayofweek == 4) & (sh.hour >= 20)) & a.notna()
    idx = np.flatnonzero(ok)
    f = _frame(close_t[idx].tz_localize(None), sig[idx], sl_atr * a.values[idx], tp, be, trail_atr * a.values[idx])
    return _cap_per_day(f, b.server.iloc[idx].to_numpy(), per_day)


def range_breakout(m1, r_start=2, r_end=10, trade_end=14, exit_h=22, buf_atr=0.1, stop="mid", sl_atr=1.5,
                   tp=2.0, be=0.0, trail_atr=2.0, min_stop=2.0, max_stop=15.0, tf="5min", ny_open=False,
                   both_sides=False):
    """First close outside a session range after it ends. Hours are server time.

    stop: 'mid' = range middle, 'far' = opposite side of the range, 'atr' = sl_atr * ATR.
    ny_open: range is the first r_end-r_start minutes after the New York cash open (09:30 NY).
    """
    b = resample(m1, tf)
    a = atr(b)
    sv = b.server
    day = sv.dt.normalize()
    if ny_open:
        ny = b.index.tz_convert("America/New_York").tz_localize(None)
        mins = (ny.hour * 60 + ny.minute).to_numpy()
        in_range = (mins >= 570) & (mins < 570 + r_end)
        after = (mins >= 570 + r_end) & (mins < 570 + trade_end)
    else:
        hr = sv.dt.hour.to_numpy()
        in_range = (hr >= r_start) & (hr < r_end)
        after = (hr >= r_end) & (hr < trade_end)
    rh = b.h.where(in_range).groupby(day).transform("max")
    rl = b.l.where(in_range).groupby(day).transform("min")
    buf = buf_atr * a
    sig = np.where(after & (b.c > rh + buf), 1, np.where(after & (b.c < rl - buf), -1, 0))
    f = pd.DataFrame({"sig": sig, "day": day.values, "c": b.c.values, "rh": rh.values, "rl": rl.values,
                      "a": a.values, "t": (b.index + pd.Timedelta(tf)).tz_localize(None),
                      "fri": (sv.dt.dayofweek == 4).values})
    f = f[f.sig != 0]
    if not both_sides:
        f = f.groupby("day").head(1)
    mid = (f.rh + f.rl) / 2
    if stop == "mid":
        dist = np.where(f.sig > 0, f.c - mid, mid - f.c)
    elif stop == "far":
        dist = np.where(f.sig > 0, f.c - f.rl, f.rh - f.c)
    else:
        dist = sl_atr * f.a
    dist = pd.Series(dist, index=f.index)
    keep = (dist >= min_stop) & (dist <= max_stop)
    f, dist = f[keep], dist[keep]
    texit = pd.to_datetime(f.day) + pd.Timedelta(hours=exit_h)  # server time
    texit_utc = (texit - pd.Timedelta(hours=7)).dt.tz_localize("America/New_York", ambiguous="NaT",
                                                               nonexistent="shift_forward").dt.tz_convert("UTC").dt.tz_localize(None)
    return _frame(f.t.values, f.sig.values, dist.values, tp, be, trail_atr * f.a.values, texit_utc.values)


def prev_day_breakout(m1, start_h=10, end_h=20, exit_h=23, sl_atr=1.5, tp=2.0, be=0.0, trail_atr=2.0, tf="5min",
                      buf_atr=0.1):
    """First close beyond yesterday's high/low during the trading window; one trade a day."""
    b = resample(m1, tf)
    a = atr(b)
    sv = b.server
    day = sv.dt.normalize()
    dh = b.h.groupby(day).max()
    dl = b.l.groupby(day).min()
    pdh = day.map(dh.shift(1))
    pdl = day.map(dl.shift(1))
    hr = sv.dt.hour
    win = (hr >= start_h) & (hr < end_h)
    buf = buf_atr * a
    sig = np.where(win & (b.c > pdh + buf), 1, np.where(win & (b.c < pdl - buf), -1, 0))
    f = pd.DataFrame({"sig": sig, "day": day.values, "a": a.values, "t": (b.index + pd.Timedelta(tf)).tz_localize(None)})
    f = f[(f.sig != 0) & f.a.notna()].groupby("day").head(1)
    texit = (pd.to_datetime(f.day) + pd.Timedelta(hours=exit_h) - pd.Timedelta(hours=7)).dt.tz_localize(
        "America/New_York", ambiguous="NaT", nonexistent="shift_forward").dt.tz_convert("UTC").dt.tz_localize(None)
    return _frame(f.t.values, f.sig.values, sl_atr * f.a.values, tp, be, trail_atr * f.a.values, texit.values)


def donchian(m1, tf="1h", n=20, sl_atr=2.0, tp=0.0, be=1.0, trail_atr=3.0, start_h=1, end_h=22):
    """Trend breakout: close above the n-bar high (below the n-bar low), ATR stop, trailing exit."""
    b = resample(m1, tf)
    a = atr(b)
    hh = b.h.rolling(n).max().shift(1)
    ll = b.l.rolling(n).min().shift(1)
    sig = np.where(b.c > hh, 1, np.where(b.c < ll, -1, 0))
    # only the first bar of a new break
    prev = pd.Series(sig, index=b.index).shift(1).fillna(0).to_numpy()
    sig = np.where(sig != prev, sig, 0)
    sh = (b.server + pd.Timedelta(tf)).dt
    ok = (sig != 0) & a.notna().to_numpy() & (sh.hour >= start_h).to_numpy() & (sh.hour < end_h).to_numpy()
    idx = np.flatnonzero(ok)
    t = (b.index[idx] + pd.Timedelta(tf)).tz_localize(None)
    return _frame(t, sig[idx], sl_atr * a.values[idx], tp, be, trail_atr * a.values[idx])


def squeeze(m1, tf="15min", n=20, k=2.0, pct=0.2, look=100, sl_atr=1.5, tp=2.0, be=0.0, trail_atr=2.0,
            start_h=9, end_h=20):
    """Bollinger width in its lowest `pct` of the last `look` bars, then a close outside the bands."""
    b = resample(m1, tf)
    a = atr(b)
    m = b.c.rolling(n).mean()
    sd = b.c.rolling(n).std()
    width = (2 * k * sd) / m
    q = width.rolling(look).quantile(pct)
    tight = (width.shift(1) <= q.shift(1))
    sig = np.where(tight & (b.c > m + k * sd), 1, np.where(tight & (b.c < m - k * sd), -1, 0))
    sh = (b.server + pd.Timedelta(tf)).dt
    ok = (sig != 0) & a.notna().to_numpy() & (sh.hour >= start_h).to_numpy() & (sh.hour < end_h).to_numpy()
    idx = np.flatnonzero(ok)
    t = (b.index[idx] + pd.Timedelta(tf)).tz_localize(None)
    return _frame(t, sig[idx], sl_atr * a.values[idx], tp, be, trail_atr * a.values[idx])


def fade(m1, tf="15min", n=20, k=2.5, sl_atr=1.5, tp=1.0, start_h=2, end_h=9):
    """Quiet-hours mean reversion: close outside a wide band, enter back toward the mean."""
    b = resample(m1, tf)
    a = atr(b)
    m = b.c.rolling(n).mean()
    sd = b.c.rolling(n).std()
    sig = np.where(b.c > m + k * sd, -1, np.where(b.c < m - k * sd, 1, 0))
    sh = (b.server + pd.Timedelta(tf)).dt
    ok = (sig != 0) & a.notna().to_numpy() & (sh.hour >= start_h).to_numpy() & (sh.hour < end_h).to_numpy()
    idx = np.flatnonzero(ok)
    t = (b.index[idx] + pd.Timedelta(tf)).tz_localize(None)
    texit = t + pd.Timedelta(hours=4)
    return _frame(t, sig[idx], sl_atr * a.values[idx], tp, 0.0, 0.0, texit)
