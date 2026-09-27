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
    expect(engine.gridForge.generation).toBeGreaterThan(5);
    // Never trade a grid FORGE crowned with a losing out-of-sample result.
    for (const l of engine.log.filter((x) => x.text.includes('grid champion:'))) expect(l.text).not.toMatch(/OOS -/);
    // Balance = start + closed round trips − buy fees of inventory still held.
    const closed = engine.trades.reduce((s, t) => s + t.pnl, 0);
    const inv = engine.gridBot?.inventory() ?? { qty: 0, cost: 0 };
    expect(engine.balance).toBeCloseTo(engine.startBalance + closed - inv.cost * engine.settings.grid.maker, 6);
  }, 60_000);
});
