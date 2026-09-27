import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, Engine, type GridSlot } from '../src/core/engine';
import { newGridForge } from '../src/core/grid';
import { mulberry32 } from '../src/core/rng';
import { LiveController, DEFAULT_LIVE_SETTINGS } from '../src/exchange/liveController';
import { MockExchange } from '../src/exchange/mock';

const RULES = { DOGEUSDT: { symbol: 'DOGEUSDT', tickSize: 0.00001, stepSize: 1, minQty: 1, minNotional: 5 } };

function engineWithChampion(patch = {}) {
  const e = new Engine({ ...DEFAULT_SETTINGS, feed: 'binance', strategy: 'grid', symbols: ['DOGEUSDT'], ...patch }, 1);
  const forge = newGridForge(mulberry32(1));
  const genome = { id: 'g', spacing: 0.01, levels: 5, stop: 0.02 };
  const result = { profit: 0.02, roundTrips: 10, stops: 0, maxDrawdown: 0.01, fitness: 0.01 };
  forge.champion = { genome, train: result, test: result };
  const slot: GridSlot = { symbol: 'DOGEUSDT', forge, bot: null, roundTrips: 0, last: 0, wait: 0, orphan: 0, trails: 0, why: '' };
  e.grids.set('DOGEUSDT', slot);
  return e;
}

describe('LiveController', () => {
  afterEach(() => vi.useRealTimers());

  it('refuses to start outside the live grid setup', async () => {
    const ex = new MockExchange(RULES, 100);
    const replay = new LiveController(engineWithChampion({ feed: 'replay' }), () => ex);
    await expect(replay.start(DEFAULT_LIVE_SETTINGS)).rejects.toThrow(/Binance live feed/);
    const agents = new LiveController(engineWithChampion({ strategy: 'agents' }), () => ex);
    await expect(agents.start(DEFAULT_LIVE_SETTINGS)).rejects.toThrow(/grid strategy/);
  });

  it("trades FORGE's champion on the exchange, and the kill switch flattens it", async () => {
    vi.useFakeTimers();
    const ex = new MockExchange(RULES, 100);
    ex.setPrice('DOGEUSDT', 0.1);
    const engine = engineWithChampion();
    const ctl = new LiveController(engine, () => ex);
    await ctl.start(DEFAULT_LIVE_SETTINGS);
    expect(ctl.status).toBe('running');
    await vi.advanceTimersByTimeAsync(3100);
    expect(ctl.live!.coins.has('DOGEUSDT')).toBe(true);
    expect((await ex.openOrders()).length).toBe(5);
    ex.setPrice('DOGEUSDT', 0.0985);
    await vi.advanceTimersByTimeAsync(3100);
    expect(ex.positions.DOGEUSDT.qty).toBeGreaterThan(0);
    expect(engine.log.some((l) => l.text.startsWith('LIVE BUY DOGEUSDT'))).toBe(true);

    await ctl.kill();
    expect(ctl.status).toBe('killed');
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
    expect(await ex.openOrders()).toHaveLength(0);
    // The timer is stopped: nothing is re-armed afterwards.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await ex.openOrders()).toHaveLength(0);
  });

  it('only offers coins SENTRY allows, best first', () => {
    const engine = engineWithChampion();
    engine.grids.get('DOGEUSDT')!.why = 'selling off too hard for a grid';
    const ctl = new LiveController(engine, () => new MockExchange(RULES));
    expect(ctl.host().candidates()).toHaveLength(0);
    engine.grids.get('DOGEUSDT')!.why = '';
    expect(ctl.host().candidates().map((c) => c.symbol)).toEqual(['DOGEUSDT']);
  });
});
