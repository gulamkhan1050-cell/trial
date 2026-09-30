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

describe('crash guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loses less than an unguarded grid when every market dumps together', async () => {
    const { gridVariants } = await import('../src/core/arena');
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const n = 1200 + 1440 + 1;
    const t0 = Date.UTC(2026, 0, 1);
    // Range-bound chop (grids thrive), then at bar 1900 a 6% market-wide dump over 30 bars.
    const series = (phase: number) =>
      Array.from({ length: n }, (_, i) => {
        const drop = i < 1900 ? 1 : i < 1930 ? 1 - 0.06 * ((i - 1900) / 30) : 0.94;
        const px = (i: number) => 100 * (1 + 0.006 * Math.sin(i / 7 + phase) + 0.003 * Math.sin(i / 2.3 + phase * 2)) * drop;
        const o = px(i - 1);
        const c = px(i);
        return [t0 + i * 60_000, `${o}`, `${Math.max(o, c) * 1.0005}`, `${Math.min(o, c) * 0.9995}`, `${c}`, '0', 0, '500000'] as const;
      });
    const data: Record<string, ReturnType<typeof series>> = { BTCUSDT: series(0), ETHUSDT: series(1), SOLUSDT: series(2) };
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      const end = Number(u.searchParams.get('endTime') ?? Infinity);
      return new Response(JSON.stringify(data[u.searchParams.get('symbol')!].filter((k) => k[0] <= end).slice(-1000)));
    });
    const all = gridVariants(DEFAULT_SETTINGS);
    const pick = (name: string) => all.find((c) => c.name === name)!;
    const out = await runArena({
      symbols,
      days: 1,
      source: 'real',
      base: DEFAULT_SETTINGS,
      contestants: [pick('NEW · 5× smart, no guard'), pick('NEW · 5× smart take-profit')],
    });
    const [noGuard, guard] = out.results;
    expect(guard.trades).toBeGreaterThan(20); // it did trade the chop
    expect(guard.final).toBeGreaterThan(noGuard.final);
    expect(guard.maxDrawdown).toBeLessThan(noGuard.maxDrawdown);
  }, 180_000);
});

describe('Arena robustness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('skips a coin Binance no longer lists instead of abandoning real data', async () => {
    const { SimFeed } = await import('../src/core/market');
    let c: import('../src/core/types').Candle[] = [];
    await new SimFeed(1000, 5, 2700, 0.3).start(['BTCUSDT'], { onHistory: (_x, h) => (c = h), onCandle() {}, onStatus() {} });
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get('symbol') === 'GONEUSDT') return new Response('{"code":-1121,"msg":"Invalid symbol."}', { status: 400 });
      const end = Number(u.searchParams.get('endTime') ?? Infinity);
      return new Response(JSON.stringify(c.filter((k) => k.t <= end).slice(-1000).map((k) => [k.t, `${k.o}`, `${k.h}`, `${k.l}`, `${k.c}`, '0', 0, `${k.v}`])));
    });
    const out = await runArena({ symbols: ['BTCUSDT', 'GONEUSDT', 'ETHUSDT'], days: 1, source: 'real', base: DEFAULT_SETTINGS, contestants: ARENA_CONTESTANTS });
    expect(out.source).toBe('real');
    expect(out.note).toMatch(/2 coins/);
    expect(out.note).toMatch(/skipped GONE/);
  }, 120_000);

  it('gives the same result for the same data', async () => {
    const run = () => runArena({ symbols: ['BTCUSDT', 'ETHUSDT'], days: 1, source: 'sim', base: DEFAULT_SETTINGS, contestants: ARENA_CONTESTANTS });
    const [a, b] = [await run(), await run()];
    expect(a.results.map((r) => r.final)).toEqual(b.results.map((r) => r.final));
  }, 120_000);
});

describe('FORGE mode', () => {
  it('thorough mode runs a separate FORGE per grid contestant and says so', async () => {
    const { gridVariants } = await import('../src/core/arena');
    const [, g1, g3] = gridVariants(DEFAULT_SETTINGS);
    const fast = await runArena({ symbols: ['BTCUSDT', 'ETHUSDT'], days: 1, source: 'sim', base: DEFAULT_SETTINGS, contestants: [g1, g3] });
    const thorough = await runArena({ symbols: ['BTCUSDT', 'ETHUSDT'], days: 1, source: 'sim', base: DEFAULT_SETTINGS, contestants: [g1, g3], forgeMode: 'thorough' });
    expect(fast.note).toMatch(/fast FORGE/);
    expect(thorough.note).toMatch(/thorough FORGE/);
    // Shared FORGE: 1× and 3× trade the same ladders, so their trade counts track each other closely.
    // Separate FORGEs evolve independently, so the results differ from fast mode.
    expect(thorough.results.map((r) => r.final)).not.toEqual(fast.results.map((r) => r.final));
  }, 180_000);
});
