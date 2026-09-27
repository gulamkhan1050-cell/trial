import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMMArena } from '../src/core/mmArena';
import { mulberry32 } from '../src/core/rng';

describe('1-second market-maker arena', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pages real 1s history, tunes per coin and reports one result per fee level', async () => {
    const rand = mulberry32(4);
    const t0 = Date.UTC(2026, 0, 1);
    let mid = 100;
    const rows = Array.from({ length: 3700 }, (_, i) => {
      const o = mid;
      mid *= 1 + (rand() - 0.5) * 0.0002;
      const h = Math.max(o, mid) * (1 + 0.0006 * rand());
      const l = Math.min(o, mid) * (1 - 0.0006 * rand());
      return [t0 + i * 1000, `${o}`, `${h}`, `${l}`, `${mid}`, '0', 0, '10000'];
    });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const end = Number(new URL(url).searchParams.get('endTime') ?? Infinity);
      return new Response(JSON.stringify(rows.filter((r) => (r[0] as number) <= end).slice(-1000)));
    });
    const makerFees = [-0.00005, 0, 0.0002];
    const out = await runMMArena({ symbols: ['BTCUSDT'], hours: 1, source: 'real', makerFees, takerFee: 0.0005, fillProb: 0.5, capital: 1000 });
    expect(out.source).toBe('real');
    expect(urls.every((u) => u.includes('interval=1s'))).toBe(true);
    expect(urls.length).toBeGreaterThanOrEqual(4); // 3600 bars → 4 pages
    expect(out.results.map((r) => r.maker)).toEqual(makerFees);
    for (const r of out.results) {
      expect(r.fills).toBeGreaterThan(0);
      expect(r.params.BTCUSDT.halfSpread).toBeGreaterThan(0);
    }
    // On this data the rebate run beats the 0.02% run (each fee level is tuned separately, so
    // this is an outcome of the data, not a guarantee).
    expect(out.results[0].final).toBeGreaterThanOrEqual(out.results[2].final - 1e-9);
  }, 60_000);

  it('falls back to offline 1s data when Binance is unreachable', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 451 }));
    const out = await runMMArena({ symbols: ['BTCUSDT'], hours: 1, source: 'real', makerFees: [0], takerFee: 0.0005, fillProb: 0.5, capital: 1000 });
    expect(out.source).toBe('sim');
    expect(out.results).toHaveLength(1);
  }, 60_000);
});
