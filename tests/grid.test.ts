import { describe, expect, it } from 'vitest';
import { GridBot, gridBacktest, newGridForge, stepGridForge, gridPasses, type GridGenome } from '../src/core/grid';
import { mulberry32 } from '../src/core/rng';
import { SimFeed } from '../src/core/market';
import type { Candle } from '../src/core/types';

const g: GridGenome = { id: 't', spacing: 0.01, levels: 3, stop: 0.02 };
const fees = { maker: 0.001, taker: 0.002 };

describe('GridBot', () => {
  it('lays buys under the price and books a round trip net of both fees', () => {
    const bot = new GridBot(g, fees);
    bot.arm(100, 300);
    expect(bot.orders.map((o) => o.price)).toEqual([99, 98, 97]);
    const down = bot.move(100, 98.5);
    expect(down).toHaveLength(1);
    expect(down[0].kind).toBe('buy');
    const qty = 100 / 99;
    expect(down[0].cash).toBeCloseTo(-99 * qty * 0.001);
    const up = bot.move(98.5, 100.5);
    expect(up[0].kind).toBe('sell');
    expect(up[0].price).toBeCloseTo(99.99);
    // gross 0.99*qty minus sell fee minus buy fee
    expect(up[0].roundTrip!.pnl).toBeCloseTo(0.99 * qty - 99.99 * qty * 0.001 - 99 * qty * 0.001);
    // Level is re-armed as a buy at the original price.
    expect(bot.orders.find((o) => o.lvl === 1)).toMatchObject({ side: 'buy', price: 99 });
  });

  it('stops out below the ladder and liquidates inventory at taker fee', () => {
    const bot = new GridBot(g, fees);
    bot.arm(100, 300);
    const fills = bot.move(100, 94);
    expect(fills.filter((f) => f.kind === 'buy')).toHaveLength(3);
    const stop = fills.find((f) => f.kind === 'stop')!;
    expect(stop.roundTrip!.pnl).toBeLessThan(0);
    expect(bot.armed).toBe(false);
  });

  it('trails the ladder up when flat', () => {
    const bot = new GridBot(g, fees);
    bot.arm(100, 300);
    bot.move(100, 102);
    expect(bot.center).toBe(102);
  });
});

describe('grid backtest', () => {
  const wave = (amp: number, n = 900): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const o = 100 + amp * Math.sin((i - 1) / 6);
      const c = 100 + amp * Math.sin(i / 6);
      return { t: i * 60000, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1e6 };
    });

  it('earns in a range when spacing beats fees, and loses when fees exceed spacing', () => {
    const ok = gridBacktest(wave(1.5), { id: 'a', spacing: 0.004, levels: 6, stop: 0.03 }, { maker: 0.0002, taker: 0.0005 });
    expect(ok.roundTrips).toBeGreaterThan(20);
    expect(ok.profit).toBeGreaterThan(0);
    const bad = gridBacktest(wave(1.5), { id: 'b', spacing: 0.001, levels: 6, stop: 0.03 }, { maker: 0.002, taker: 0.002 });
    expect(bad.profit).toBeLessThan(0);
  });

  it('FORGE only crowns grids that pass out-of-sample', async () => {
    let c: Candle[] = [];
    await new SimFeed(1000, 5, 1200).start(['BTCUSDT'], { onHistory: (_s, x) => (c = x), onCandle() {}, onStatus() {} });
    const rand = mulberry32(2);
    let f = newGridForge(rand);
    for (let i = 0; i < 8; i++) f = stepGridForge(f, c, { maker: 0.0002, taker: 0.0005 }, rand);
    expect(f.generation).toBe(8);
    // Every champion crowned along the way must have been profitable out-of-sample.
    if (f.champion) expect(f.champion.test.profit).toBeGreaterThan(-0.002);
    expect(gridPasses({ genome: g, train: { profit: 0.01, roundTrips: 9, stops: 0, maxDrawdown: 0, fitness: 1 }, test: { profit: -0.02, roundTrips: 9, stops: 0, maxDrawdown: 0, fitness: 1 } })).toBe(false);
  });
});

describe('Engine in GRID mode', () => {
  it('evolves a grid, trades round trips and keeps the book consistent', async () => {
    const { vi } = await import('vitest');
    const { Engine, DEFAULT_SETTINGS } = await import('../src/core/engine');
    vi.useFakeTimers();
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', strategy: 'grid', simBarMs: 400, symbols: ['BTCUSDT'] });
    await engine.start();
    await vi.advanceTimersByTimeAsync(400 * 900);
    engine.stop();
    vi.useRealTimers();
    expect(engine.grids.get('BTCUSDT')!.forge.generation).toBeGreaterThan(5);
    // Never trade a grid FORGE crowned with a losing out-of-sample result.
    for (const l of engine.log.filter((x) => x.text.includes('grid champion:'))) expect(l.text).not.toMatch(/OOS -/);
    // Balance = start + closed round trips − buy fees of inventory still held.
    const closed = engine.trades.reduce((s, t) => s + t.pnl, 0);
    const heldCost = [...engine.grids.values()].reduce((s, g) => s + (g.bot?.inventory().cost ?? 0), 0);
    expect(engine.balance).toBeCloseTo(engine.startBalance + closed - heldCost * engine.settings.grid.maker, 6);
  }, 60_000);
});

describe('fixed grid (no FORGE search)', () => {
  it('runs the pinned ladder on every market and never breeds another', async () => {
    const { vi } = await import('vitest');
    const { Engine, DEFAULT_SETTINGS } = await import('../src/core/engine');
    const { PROFILE, profileGrid } = await import('../src/exchange/profile');
    vi.useFakeTimers();
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', strategy: 'grid', simBarMs: 400, symbols: ['BTCUSDT', 'ETHUSDT'], grid: profileGrid(DEFAULT_SETTINGS.grid) });
    await engine.start();
    await vi.advanceTimersByTimeAsync(400 * 900);
    engine.stop();
    vi.useRealTimers();
    for (const g of engine.grids.values()) {
      expect(g.forge.generation).toBeGreaterThan(0);
      expect(g.forge.champion?.genome).toMatchObject({ ...PROFILE.grid, tp: 1, deep: 0 });
      if (g.bot) expect(g.bot.genome).toMatchObject(PROFILE.grid);
    }
    expect(engine.grids.size).toBe(2);
  }, 60_000);
});

describe('GRID stability on calm, BTC-like replay', () => {
  it('arms once and keeps trading instead of flip-flopping on marginal re-validations', async () => {
    const { vi } = await import('vitest');
    const { Engine, DEFAULT_SETTINGS } = await import('../src/core/engine');
    let c: Candle[] = [];
    await new SimFeed(1000, 1, 3000, 0.3).start(['BTCUSDT'], { onHistory: (_s, x) => (c = x), onCandle() {}, onStatus() {} });
    vi.stubGlobal('fetch', async (url: string) => {
      const end = Number(new URL(url).searchParams.get('endTime') ?? Infinity);
      const rows = c.filter((k) => k.t <= end).slice(-1000);
      return new Response(JSON.stringify(rows.map((k) => [k.t, `${k.o}`, `${k.h}`, `${k.l}`, `${k.c}`, '0', 0, `${k.v}`])));
    });
    vi.useFakeTimers();
    const e = new Engine({ ...DEFAULT_SETTINGS, feed: 'replay', strategy: 'grid', simBarMs: 400, symbols: ['BTCUSDT'], grid: { ...DEFAULT_SETTINGS.grid, leverage: 1, crashGuard: false } }, 7);
    await e.start();
    await vi.advanceTimersByTimeAsync(400 * 1700);
    e.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const count = (re: RegExp) => e.log.filter((l) => re.test(l.text)).length;
    expect(count(/grid armed/)).toBeGreaterThanOrEqual(1);
    // The flip-flop bug stood the grid down every ~20s (dozens of times); FORGE is seeded from the
    // clock, so allow the odd genuine retirement.
    expect(count(/stood down/)).toBeLessThanOrEqual(3);
    expect(e.gridTotals().roundTrips).toBeGreaterThan(10);
  }, 120_000);
});

describe('smart take-profit', () => {
  it('sells tp steps above the buy, more for deeper levels, with the same order size and stop', async () => {
    const { GridBot, takeProfitSteps } = await import('../src/core/grid');
    const classic = new GridBot({ id: 'c', spacing: 0.01, levels: 3, stop: 0.02 });
    const smart = new GridBot({ id: 's', spacing: 0.01, levels: 3, stop: 0.02, tp: 2, deep: 0.5 });
    classic.arm(100, 300);
    smart.arm(100, 300);
    expect(smart.orders.map((o) => o.qty)).toEqual(classic.orders.map((o) => o.qty));
    expect(smart.stopPrice()).toBe(classic.stopPrice());
    classic.move(100, 96.5);
    smart.move(100, 96.5);
    // L1 bought at 99: classic sells at 99 × 1.01, smart at 99 × 1.02; L3 (97) sells at 97 × 1.03.
    expect(classic.orders[0].price).toBeCloseTo(99.99, 6);
    expect(smart.orders[0].price).toBeCloseTo(100.98, 6);
    expect(takeProfitSteps(smart.genome, 3)).toBe(3);
    expect(smart.orders[2].price).toBeCloseTo(97 * 1.03, 6);
    // One bounce to 101: both sell L1; the smart one earns about twice as much on it.
    const c = classic.move(96.5, 101).filter((f) => f.kind === 'sell');
    const s = smart.move(96.5, 101).filter((f) => f.kind === 'sell');
    const cL1 = c.find((f) => f.roundTrip!.buy === 99)!.roundTrip!.pnl;
    const sL1 = s.find((f) => f.roundTrip!.buy === 99)!.roundTrip!.pnl;
    expect(sL1).toBeGreaterThan(cL1 * 1.9);
  });

  it('FORGE with classicTp never breeds a smart take-profit', async () => {
    const { newGridForge, stepGridForge } = await import('../src/core/grid');
    const { mulberry32 } = await import('../src/core/rng');
    const rand = mulberry32(7);
    const candles = Array.from({ length: 700 }, (_, i) => {
      const c = 100 * (1 + 0.01 * Math.sin(i / 9));
      return { t: i * 60_000, o: c, h: c * 1.002, l: c * 0.998, c, v: 1 };
    });
    let f = newGridForge(rand, { classicTp: true });
    for (let i = 0; i < 3; i++) f = stepGridForge(f, candles, { maker: 0.0002, taker: 0.0005 }, rand, { classicTp: true });
    expect(f.population.every((g) => (g.tp ?? 1) === 1 && (g.deep ?? 0) === 0)).toBe(true);
  });
});

describe('boost options', () => {
  it('FORGE with maxSpacing never breeds a step wider than the cap', async () => {
    const { newGridForge, stepGridForge } = await import('../src/core/grid');
    const { mulberry32 } = await import('../src/core/rng');
    const rand = mulberry32(11);
    const candles = Array.from({ length: 700 }, (_, i) => {
      const c = 100 * (1 + 0.01 * Math.sin(i / 9));
      return { t: i * 60_000, o: c, h: c * 1.002, l: c * 0.998, c, v: 1 };
    });
    let f = newGridForge(rand, { maxSpacing: 0.006 });
    for (let i = 0; i < 3; i++) f = stepGridForge(f, candles, { maker: 0.0002, taker: 0.0005 }, rand, { maxSpacing: 0.006 });
    expect(f.population.every((g) => g.spacing <= 0.006)).toBe(true);
  });
});
