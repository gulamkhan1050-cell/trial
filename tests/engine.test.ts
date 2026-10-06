import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, Engine } from '../src/core/engine';

describe('Engine on the simulator', () => {
  afterEach(() => vi.useRealTimers());

  it('boots, evolves champions and keeps the book consistent', async () => {
    vi.useFakeTimers();
    const engine = new Engine({ ...DEFAULT_SETTINGS, strategy: 'agents', feed: 'sim', simBarMs: 400, symbols: ['BTCUSDT', 'ETHUSDT'] });
    await engine.start();
    await vi.advanceTimersByTimeAsync(120_000); // ~300 simulated bars
    engine.stop();

    const f = engine.forgeTotals();
    expect(f.gen).toBeGreaterThan(5);
    expect(f.tested).toBeGreaterThan(0);
    expect(engine.log.length).toBeGreaterThan(0);
    // Balance = start + sum of closed trade PnL + entry fees of positions still open.
    const closed = engine.trades.reduce((s, t) => s + t.pnl, 0);
    const openFees = engine.positions.reduce((s, p) => s + p.entry * p.qty * 0.0004, 0);
    expect(engine.balance).toBeCloseTo(engine.startBalance + closed - openFees, 6);
    expect(engine.positions.length).toBeLessThanOrEqual(DEFAULT_SETTINGS.sentry.maxOpen);
  }, 60_000);
});

describe('saved settings', () => {
  it('moves settings saved before the Arena results to the grid defaults, keeping the user fees', async () => {
    const { loadSettings } = await import('../src/core/engine');
    const store: Record<string, string> = {
      'swarmdesk:settings': JSON.stringify({ strategy: 'agents', grid: { maker: 0.0001, taker: 0.0004, leverage: 1, crashGuard: true } }),
    };
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) });
    const s = loadSettings();
    vi.unstubAllGlobals();
    expect(s.strategy).toBe('grid');
    expect(s.grid).toMatchObject({ leverage: 3, crashGuard: true, crashDrop: 0.025, maker: 0.0001, taker: 0.0004 });
    expect(s.symbols).toHaveLength(15);
  });
});

describe('Engine.resetCounters', () => {
  it('zeroes the paper scores without stopping or re-seeding anything', () => {
    const e = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', symbols: ['BTCUSDT'] }, 1);
    e.trades.push({ symbol: 'BTCUSDT', dir: 1, entry: 1, exit: 2, qty: 1, pnl: 5, openedAt: 0, closedAt: 1, reason: 'x' } as never);
    e.balance += 5;
    e.resetCounters();
    expect(e.trades).toHaveLength(0);
    expect(e.totalEquity() - e.startBalance).toBe(0);
  });
});

describe('daily target (bank the day)', () => {
  it('stops laying new ladders once today is up by the target', () => {
    const e = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', symbols: ['BTCUSDT'], grid: { ...DEFAULT_SETTINGS.grid, dailyTarget: 20 } }, 1);
    e.dayStartEquity = e.totalEquity();
    expect(e.dayBanked()).toBe(false);
    e.balance += 25;
    expect(e.dayBanked()).toBe(true);
    const off = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', symbols: ['BTCUSDT'] }, 1);
    off.balance += 500;
    expect(off.dayBanked()).toBe(false);
  });
});
