import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, Engine } from '../src/core/engine';
import { SimFeed } from '../src/core/market';
import type { Candle } from '../src/core/types';

/** Serve Binance-shaped kline pages built from simulator candles, honouring endTime paging. */
async function fakeBinance(bars: number) {
  const bySymbol: Record<string, Candle[]> = {};
  for (const [i, s] of ['BTCUSDT', 'ETHUSDT'].entries()) {
    await new SimFeed(1000, 11 + i, bars).start([s], { onHistory: (_s, c) => (bySymbol[s] = c), onCandle() {}, onStatus() {} });
  }
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const all = bySymbol[u.searchParams.get('symbol')!];
    const end = Number(u.searchParams.get('endTime') ?? Infinity);
    const rows = all.filter((k) => k.t <= end).slice(-1000);
    return new Response(JSON.stringify(rows.map((k) => [k.t, `${k.o}`, `${k.h}`, `${k.l}`, `${k.c}`, '0', k.t + 59999, `${k.v}`])));
  });
  return { calls, bySymbol };
}

describe('Replay feed', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pages history, replays it fast and trades on the replayed clock', async () => {
    vi.useFakeTimers();
    const { calls, bySymbol } = await fakeBinance(2500);
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'replay', simBarMs: 400, symbols: ['BTCUSDT', 'ETHUSDT'] });
    await engine.start();
    expect(engine.feedName).toBe('Replay');
    expect(engine.feedStatus).toBe('replay');
    expect(calls.some((c) => c.includes('endTime='))).toBe(true);

    await vi.advanceTimersByTimeAsync(400 * 600); // 600 replayed bars
    engine.stop();

    const btc = engine.symbols.get('BTCUSDT')!;
    // Replayed bars are the real (fake-served) bars, in order, without gaps.
    const src = bySymbol.BTCUSDT;
    const last = btc.candles[btc.candles.length - 1];
    const idx = src.findIndex((k) => k.t === last.t);
    expect(idx).toBeGreaterThan(0);
    expect(last).toEqual(src[idx]);
    // Trade timestamps follow the replayed market clock, not the wall clock.
    for (const t of engine.trades) expect(t.closedAt).toBeLessThanOrEqual(last.t + 60_000);
    expect(engine.forgeTotals().gen).toBeGreaterThan(5);
  }, 60_000);

  it('falls back to the simulator when Binance is unreachable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response('blocked', { status: 403 }));
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'replay', symbols: ['BTCUSDT'] });
    await engine.start();
    expect(engine.feedName).toBe('Simulator');
    engine.stop();
  });
});

describe('restarting while a replay is still downloading', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never lets the abandoned download drive the book', async () => {
    vi.useFakeTimers();
    const { bySymbol } = await fakeBinance(2600);
    const inner = globalThis.fetch;
    // Slow network: each page takes 2s, so the restart lands mid-download.
    vi.stubGlobal('fetch', async (url: string) => {
      await new Promise((r) => setTimeout(r, 2000));
      return inner(url);
    });
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'replay', simBarMs: 400, symbols: ['BTCUSDT'] });
    void engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    engine.updateSettings({ strategy: 'grid' });
    await vi.advanceTimersByTimeAsync(20_000); // downloads finish for both sessions
    const before = engine.symbols.get('BTCUSDT')!.candles.length;
    await vi.advanceTimersByTimeAsync(400 * 50);
    const after = engine.symbols.get('BTCUSDT')!.candles.length;
    engine.stop();
    // One feed → ~50 new bars. Two feeds would interleave and add duplicates or double speed.
    expect(after - before).toBeGreaterThanOrEqual(48);
    expect(after - before).toBeLessThanOrEqual(51);
    const ts = engine.symbols.get('BTCUSDT')!.candles.map((k) => k.t);
    expect(ts.every((t, i) => i === 0 || t > ts[i - 1])).toBe(true);
    expect(bySymbol.BTCUSDT.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('switching presets mid-session', () => {
  afterEach(() => vi.useRealTimers());

  it('does not carry positions from one simulated market into the next', async () => {
    vi.useFakeTimers();
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', simBarMs: 400, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] });
    await engine.start();
    // Run until the directional agents hold at least one position.
    for (let i = 0; i < 300 && engine.positions.length === 0; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(engine.positions.length).toBeGreaterThan(0);
    engine.updateSettings({ strategy: 'grid' });
    await vi.advanceTimersByTimeAsync(5_000);
    // A fresh book: the old positions were not closed against the new market's synthetic prices.
    expect(engine.positions).toHaveLength(0);
    expect(engine.trades.filter((t) => !t.reason.startsWith('grid'))).toHaveLength(0);
    expect(engine.dayPnl).toBeGreaterThan(-engine.startBalance * 0.05);
    engine.stop();
  }, 60_000);
});
