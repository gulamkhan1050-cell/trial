import { describe, expect, it } from 'vitest';
import { runMM, tuneMM } from '../src/core/mm';
import { SimFeed } from '../src/core/market';
import { mulberry32 } from '../src/core/rng';
import type { Candle } from '../src/core/types';

const P = { halfSpread: 0.0005, skew: 1, maxInv: 4, size: 0.1 };
const opt = { fillProb: 1, stop: 0.5, pauseBars: 0, seed: 1 };

function chop(n: number, wick = 0.0008): Candle[] {
  // Bid/ask bounce: each second wicks through both quotes while the mid barely drifts.
  let mid = 100;
  const rand = mulberry32(9);
  return Array.from({ length: n }, (_, i) => {
    const o = mid;
    mid *= 1 + (rand() - 0.5) * 0.0001;
    return { t: i * 1000, o, h: Math.max(o, mid) * (1 + wick * rand()), l: Math.min(o, mid) * (1 - wick * rand()), c: mid, v: 1e5 };
  });
}

describe('market maker', () => {
  it('captures the spread in a two-way market, and fees decide the result', () => {
    const free = runMM(chop(5000), P, { maker: 0, taker: 0 }, 1000, opt);
    expect(free.fills).toBeGreaterThan(500);
    expect(free.final).toBeGreaterThan(free.start);
    const rebate = runMM(chop(5000), P, { maker: -0.0001, taker: 0.0005 }, 1000, opt);
    expect(rebate.final).toBeGreaterThan(free.final);
    const costly = runMM(chop(5000), P, { maker: 0.002, taker: 0.004 }, 1000, opt);
    expect(costly.final).toBeLessThan(costly.start); // fee > half-spread: every fill loses
  });

  it('needs price to trade through a quote, and fill probability thins fills', () => {
    const flat = Array.from({ length: 1000 }, (_, i) => ({ t: i * 1000, o: 100, h: 100, l: 100, c: 100, v: 1 }));
    expect(runMM(flat, P, { maker: 0, taker: 0 }, 1000, opt).fills).toBe(0);
    const all = runMM(chop(3000), P, { maker: 0, taker: 0 }, 1000, opt).fills;
    const half = runMM(chop(3000), P, { maker: 0, taker: 0 }, 1000, { ...opt, fillProb: 0.5 }).fills;
    expect(half).toBeLessThan(all * 0.8);
  });

  it('loses to adverse selection when price moves further per second than the spread', () => {
    // A smooth swing: every second's move is larger than the half-spread, so the maker keeps
    // buying just before lower prices and selling just before higher ones.
    const swing = Array.from({ length: 5000 }, (_, i) => {
      const px = (j: number) => 100 * (1 + 0.002 * Math.sin(j / 3));
      const o = px(i - 1);
      const c = px(i);
      return { t: i * 1000, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 };
    });
    const r = runMM(swing, P, { maker: 0, taker: 0 }, 1000, opt);
    expect(r.final).toBeLessThan(r.start);
  });

  it('caps inventory and stops out in a one-way crash', () => {
    const crash = Array.from({ length: 600 }, (_, i) => {
      const o = 100 * (1 - 0.001 * (i - 1));
      const c = 100 * (1 - 0.001 * i);
      return { t: i * 1000, o, h: o, l: c, c, v: 1 };
    });
    const r = runMM(crash, { ...P, maxInv: 3 }, { maker: 0, taker: 0.0005 }, 1000, { fillProb: 1, stop: 0.01, pauseBars: 100, seed: 1 });
    expect(r.stops).toBeGreaterThan(0);
    expect(r.maxDrawdown).toBeLessThan(0.05);
  });

  it('tunes on a training slice', async () => {
    let c: Candle[] = [];
    await new SimFeed(1000, 3, 4000, 0.13).start(['BTCUSDT'], { onHistory: (_s, x) => (c = x), onCandle() {}, onStatus() {} });
    const best = tuneMM(c, { maker: 0, taker: 0.0005 });
    expect(Number.isFinite(best.score)).toBe(true);
  });
});
