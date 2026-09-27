import { atr, ema, highest, lowest, rsi, sma, stdev } from './indicators';
import type { Candle, Genome, Signal } from './types';

/** Indicator series computed once per (candles, genome) pair so backtests stay O(n). */
export interface Prepared {
  candles: Candle[];
  close: number[];
  high: number[];
  low: number[];
  vol: number[];
  volAvg: number[];
  fast: number[];
  slow: number[];
  rsi: number[];
  mid: number[];
  dev: number[];
  atr: number[];
}

export function prepare(candles: Candle[], g: Genome): Prepared {
  const close = candles.map((c) => c.c);
  const vol = candles.map((c) => c.v);
  return {
    candles,
    close,
    high: candles.map((c) => c.h),
    low: candles.map((c) => c.l),
    vol,
    volAvg: sma(vol, 20),
    fast: ema(close, g.fast),
    slow: ema(close, g.slow),
    rsi: rsi(close, g.rsiLen),
    mid: sma(close, 20),
    dev: stdev(close, 20),
    atr: atr(candles, 14),
  };
}

export function warmup(g: Genome): number {
  return Math.max(g.slow, g.lookback, 30) + 2;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Signal on the close of bar i (no look-ahead: uses data up to and including i). */
export function signalAt(p: Prepared, g: Genome, i: number): Signal {
  if (i < warmup(g)) return { dir: 0, strength: 0, reason: 'warmup' };
  const c = p.close[i];
  const a = p.atr[i] || 1e-9;

  switch (g.regime) {
    case 'trend': {
      const crossUp = p.fast[i - 1] <= p.slow[i - 1] && p.fast[i] > p.slow[i];
      const crossDn = p.fast[i - 1] >= p.slow[i - 1] && p.fast[i] < p.slow[i];
      const spread = Math.abs(p.fast[i] - p.slow[i]) / a;
      if (crossUp && c > p.slow[i]) return { dir: 1, strength: clamp01(0.5 + spread), reason: `EMA${g.fast}×${g.slow} up` };
      if (crossDn && c < p.slow[i]) return { dir: -1, strength: clamp01(0.5 + spread), reason: `EMA${g.fast}×${g.slow} down` };
      return { dir: 0, strength: 0, reason: 'no cross' };
    }
    case 'meanRevert': {
      const lo = 50 - g.rsiEdge;
      const hi = 50 + g.rsiEdge;
      const band = 2 * p.dev[i];
      const z = band > 0 ? (c - p.mid[i]) / band : 0;
      if (p.rsi[i] < lo && p.rsi[i] > p.rsi[i - 1] && z < -0.8)
        return { dir: 1, strength: clamp01((lo - p.rsi[i]) / 15 + 0.5), reason: `RSI ${p.rsi[i].toFixed(0)} turning up` };
      if (p.rsi[i] > hi && p.rsi[i] < p.rsi[i - 1] && z > 0.8)
        return { dir: -1, strength: clamp01((p.rsi[i] - hi) / 15 + 0.5), reason: `RSI ${p.rsi[i].toFixed(0)} rolling over` };
      return { dir: 0, strength: 0, reason: 'in range' };
    }
    case 'breakout': {
      const hh = highest(p.high, i, g.lookback);
      const ll = lowest(p.low, i, g.lookback);
      const volOk = p.vol[i] > p.volAvg[i] * g.volMult;
      if (c > hh && volOk) return { dir: 1, strength: clamp01(0.5 + (c - hh) / a), reason: `${g.lookback}-bar high break` };
      if (c < ll && volOk) return { dir: -1, strength: clamp01(0.5 + (ll - c) / a), reason: `${g.lookback}-bar low break` };
      return { dir: 0, strength: 0, reason: 'inside channel' };
    }
  }
}
