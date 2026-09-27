import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, Engine } from '../src/core/engine';

describe('Engine on the simulator', () => {
  afterEach(() => vi.useRealTimers());

  it('boots, evolves champions and keeps the book consistent', async () => {
    vi.useFakeTimers();
    const engine = new Engine({ ...DEFAULT_SETTINGS, feed: 'sim', simBarMs: 400, symbols: ['BTCUSDT', 'ETHUSDT'] });
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
