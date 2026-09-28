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

  it('picks the running grid back up after a restart instead of selling it', async () => {
    vi.useFakeTimers();
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    try {
      const ex = new MockExchange(RULES, 100);
      ex.setPrice('DOGEUSDT', 0.1);
      const s = { ...DEFAULT_LIVE_SETTINGS, apiKey: 'abcdefgh123' };
      const first = new LiveController(engineWithChampion(), () => ex);
      await first.start(s);
      await vi.advanceTimersByTimeAsync(3100);
      ex.setPrice('DOGEUSDT', 0.0985);
      await vi.advanceTimersByTimeAsync(3100); // bought L1
      const held = ex.positions.DOGEUSDT.qty;
      first.pause(); // app closed / phone restarted

      const second = new LiveController(engineWithChampion(), () => ex);
      await second.start(s);
      expect(second.live!.resumed).toBe(1);
      expect(ex.calls.some((c) => c.startsWith('CLOSE'))).toBe(false);
      expect(ex.positions.DOGEUSDT.qty).toBe(held);
      ex.setPrice('DOGEUSDT', 0.1);
      await vi.advanceTimersByTimeAsync(3100);
      expect(second.live!.roundTrips).toBe(1);

      await second.kill();
      expect(mem.size).toBe(0); // nothing left to resume after KILL
    } finally {
      vi.unstubAllGlobals();
    }
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
