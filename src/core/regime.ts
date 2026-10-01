import type { Candle } from './types';

/**
 * REGIME — reads what a coin is doing before a grid is laid on it. A long-only grid earns in ranges
 * and on dips that bounce; it loses when it buys all the way down a trend. So:
 *   DOWN  (falling 4 h trend, or a sell-off on a volume surge) → no new ladder
 *   CHOP  (range-bound)                                         → normal grid
 *   UP    (rising trend)                                         → grid first in line
 */

export type Regime = 'up' | 'chop' | 'down';

export interface RegimeRead {
  regime: Regime;
  trend: number; // price change over the slow window (fraction)
  slope: number; // fast EMA vs slow EMA (fraction)
  vol: number; // average bar range over the last hour (fraction of price)
  volume: number; // last hour's volume ÷ the window's hourly average
  why: string;
}

export interface RegimeConfig {
  slow: number; // bars for the trend (240 = 4 h of 1m bars)
  fast: number; // fast EMA bars
  band: number; // |trend| above this is a trend, not chop
}

export const DEFAULT_REGIME: RegimeConfig = { slow: 240, fast: 30, band: 0.015 };

function ema(values: number[], n: number): number {
  const k = 2 / (n + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function readRegime(c: Candle[], cfg: RegimeConfig = DEFAULT_REGIME): RegimeRead {
  const n = c.length;
  if (n < cfg.slow + 1) return { regime: 'chop', trend: 0, slope: 0, vol: 0, volume: 1, why: 'warming up' };
  const last = c[n - 1].c;
  const window = c.slice(n - 1 - cfg.slow);
  const closes = window.map((k) => k.c);
  const trend = last / closes[0] - 1;
  const slope = ema(closes, cfg.fast) / ema(closes, cfg.slow / 2) - 1;
  const hour = c.slice(n - 60);
  const vol = hour.reduce((s, k) => s + (k.h - k.l) / k.c, 0) / hour.length;
  const hourVolume = hour.reduce((s, k) => s + k.v, 0);
  const avgVolume = (window.reduce((s, k) => s + k.v, 0) / window.length) * 60;
  const volume = avgVolume > 0 ? hourVolume / avgVolume : 1;
  const lastHour = last / hour[0].o - 1;

  if (trend < -cfg.band && slope < 0) return { regime: 'down', trend, slope, vol, volume, why: `down ${(trend * 100).toFixed(1)}% in 4 h` };
  // Panic: a sharp hour on heavy volume turns DOWN early, before the 4 h trend shows it.
  if (lastHour < -cfg.band / 2 && volume > 2) return { regime: 'down', trend, slope, vol, volume, why: `sell-off on ${volume.toFixed(1)}× volume` };
  if (trend > cfg.band && slope > 0) return { regime: 'up', trend, slope, vol, volume, why: `up ${(trend * 100).toFixed(1)}% in 4 h` };
  return { regime: 'chop', trend, slope, vol, volume, why: 'ranging' };
}

/** Share of coins that are not in a downtrend — the market's mood. */
export function breadth(reads: RegimeRead[]): number {
  if (!reads.length) return 1;
  return reads.filter((r) => r.regime !== 'down').length / reads.length;
}
