import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARENA_CONTESTANTS, runArena, WARMUP_BARS } from '../src/core/arena';
import { DEFAULT_SETTINGS } from '../src/core/engine';

describe('Arena', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('replays the same bars through both strategies with separate books', async () => {
    vi.stubGlobal('fetch', async () => new Response('blocked', { status: 403 })); // forces offline data
    const stages = new Set<string>();
    const out = await runArena({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      days: 1,
      source: 'real',
      base: DEFAULT_SETTINGS,
      contestants: ARENA_CONTESTANTS,
      onProgress: (p) => stages.add(p.stage),
    });
    expect(out.source).toBe('sim'); // fell back when Binance was unreachable
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r.start).toBe(DEFAULT_SETTINGS.startBalance);
      expect(Number.isFinite(r.final)).toBe(true);
      // One equity sample every 30 bars over a day, plus the final bar.
      expect(r.equity.length).toBeGreaterThanOrEqual(1440 / 30);
      expect(r.maxDrawdown).toBeGreaterThanOrEqual(0);
    }
    // Directional and grid engines trade differently on the same data.
    expect(out.results[0].trades).not.toBe(out.results[1].trades);
    expect([...stages]).toEqual(expect.arrayContaining(['warmup', 'run', 'done']));
    expect(WARMUP_BARS).toBeGreaterThan(0);
  }, 120_000);

  it('downloads real history across pages and uses it', async () => {
    const { SimFeed } = await import('../src/core/market');
    const src: Record<string, import('../src/core/types').Candle[]> = {};
    for (const s of ['BTCUSDT', 'ETHUSDT']) await new SimFeed(1000, s.length, 3000, 0.3).start([s], { onHistory: (_x, c) => (src[s] = c), onCandle() {}, onStatus() {} });
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      const u = new URL(url);
      const end = Number(u.searchParams.get('endTime') ?? Infinity);
      const rows = src[u.searchParams.get('symbol')!].filter((k) => k.t <= end).slice(-1000);
      return new Response(JSON.stringify(rows.map((k) => [k.t, `${k.o}`, `${k.h}`, `${k.l}`, `${k.c}`, '0', 0, `${k.v}`])));
    });
    const out = await runArena({ symbols: ['BTCUSDT', 'ETHUSDT'], days: 1, source: 'real', base: DEFAULT_SETTINGS, contestants: ARENA_CONTESTANTS });
    expect(out.source).toBe('real');
    expect(out.note).toMatch(/real Binance/);
    expect(calls).toBeGreaterThanOrEqual(2 * 3); // 2640 bars per symbol → 3 pages each
    // The final equity sample lands on the last real bar.
    expect(out.results[0].equity.at(-1)!.t).toBe(src.BTCUSDT.at(-2)!.t);
  }, 120_000);
});
