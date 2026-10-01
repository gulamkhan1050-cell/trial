import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveRace, RACE_SPECS } from '../src/core/race';
import { SimFeed } from '../src/core/market';
import { DEFAULT_SETTINGS } from '../src/core/engine';

function memoryStorage() {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  return mem;
}

describe('Live race', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs every racer on one shared feed with its own $300 book, and retires a racer at its loss limit', async () => {
    const mem = memoryStorage();
    let feeds = 0;
    const race = new LiveRace(() => DEFAULT_SETTINGS, () => (feeds++, new SimFeed(5, 42, 1300)));
    await race.start();
    expect(feeds).toBe(1); // one feed for all racers
    expect(race.racers).toHaveLength(RACE_SPECS.length);
    await new Promise((r) => setTimeout(r, 400));
    const prices = race.racers.map((r) => r.engine.price('BTCUSDT'));
    expect(new Set(prices).size).toBe(1); // everyone sees the same price
    for (const r of race.racers) expect(r.engine.startBalance).toBe(300);
    expect(race.standings()).toHaveLength(RACE_SPECS.length);

    // Knock the first racer below its 20% loss limit.
    race.racers[0].engine.balance -= 100;
    await race.check();
    expect(race.racers[0].out).toMatch(/retired/);
    expect(race.racers[1].out).toBe('');
    race.stop();
    // Each racer's book is saved under its own key, never the main app's.
    expect([...mem.keys()].some((k) => k.startsWith('swarmdesk:race:plain3:book'))).toBe(true);
    expect(mem.has('swarmdesk:book:binance')).toBe(false);

    race.reset();
    expect(race.racers).toHaveLength(0);
    expect([...mem.keys()].some((k) => k.startsWith('swarmdesk:race:plain3:book'))).toBe(false);
  }, 30_000);
});
