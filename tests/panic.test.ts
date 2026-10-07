import { describe, expect, it } from 'vitest';
import type { GridGenome } from '../src/core/grid';
import { DEFAULT_LIVE, LiveGrid, type LiveCandidate, type LiveHost } from '../src/exchange/liveGrid';
import { MockExchange } from '../src/exchange/mock';

const RULES = {
  DOGEUSDT: { symbol: 'DOGEUSDT', tickSize: 0.00001, stepSize: 1, minQty: 1, minNotional: 5 },
  XRPUSDT: { symbol: 'XRPUSDT', tickSize: 0.0001, stepSize: 0.1, minQty: 0.1, minNotional: 5 },
};
const G: GridGenome = { id: 'fix', spacing: 0.012, levels: 4, stop: 0.012 };
const PANIC = { share: 0.5, coins: 1, win: 480, k: 3.6, stop: 0.08 };

/** 480 quiet 1-minute closes around `px`, optionally ending in a sharp dip. */
function minutes(px: number, last?: number): number[] {
  const c = Array.from({ length: 480 }, (_, i) => px * (i % 2 ? 1.005 : 1));
  if (last !== undefined) c[c.length - 1] = last;
  return c;
}
/** A week of hourly closes that swing by `swing` each hour. */
function hours(px: number, swing: number): number[] {
  return Array.from({ length: 168 }, (_, i) => px * (i % 2 ? 1 + swing : 1));
}

function setup() {
  const ex = new MockExchange(RULES, 200);
  ex.setPrice('DOGEUSDT', 0.1);
  ex.setPrice('XRPUSDT', 1);
  // DOGE swung 3% an hour last week, XRP 0.5%: DOGE is the most active coin, so panic buy takes it.
  ex.candles['DOGEUSDT|1h'] = hours(0.1, 0.03);
  ex.candles['XRPUSDT|1h'] = hours(1, 0.005);
  ex.candles['DOGEUSDT|1m'] = minutes(0.1);
  ex.candles['XRPUSDT|1m'] = minutes(1);
  const logs: string[] = [];
  const cands: LiveCandidate[] = [
    { symbol: 'DOGEUSDT', genome: G, score: 0.1 },
    { symbol: 'XRPUSDT', genome: G, score: 0.05 },
  ];
  const host: LiveHost = { candidates: () => cands, stressed: () => false, log: (_k, t) => logs.push(t) };
  let now = 1_000_000;
  const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 200, leverage: 5, maxCoins: 1, panic: PANIC }, Object.keys(RULES), () => now);
  return { ex, live, logs, advance: (ms: number) => (now += ms) };
}

describe('Panic buy next to the grid', () => {
  it('takes the most active coin and leaves the grid the others, each with half the budget', async () => {
    const { ex, live } = setup();
    await live.start();
    await live.tick();
    expect(live.panic!.set).toEqual(['DOGEUSDT']);
    expect([...live.coins.keys()]).toEqual(['XRPUSDT']);
    // Grid: $200 × ½ × 5 / 1 coin = $500 over 4 buys.
    const buys = (await ex.openOrders('XRPUSDT')).reduce((s, o) => s + o.price * o.origQty, 0);
    expect(buys).toBeGreaterThan(480);
    expect(buys).toBeLessThan(510);
    expect(await ex.openOrders('DOGEUSDT')).toHaveLength(0);
  });

  it('buys a sharp dip at market and sells when the price is back at its average', async () => {
    const { ex, live, advance } = setup();
    await live.start();
    await live.tick();
    expect(live.panic!.pos.size).toBe(0); // quiet market: nothing to buy

    ex.candles['DOGEUSDT|1m'] = minutes(0.1, 0.095);
    ex.setPrice('DOGEUSDT', 0.095);
    advance(61_000);
    await live.tick();
    const p = live.panic!.pos.get('DOGEUSDT')!;
    expect(p).toBeDefined();
    expect(p.entry).toBeCloseTo(0.095, 6);
    // ½ of $200 × 5 on 1 coin = $500 at 0.095.
    expect(p.qty * p.entry).toBeGreaterThan(490);
    expect((await ex.position('DOGEUSDT')).qty).toBe(p.qty);

    ex.candles['DOGEUSDT|1m'] = minutes(0.1, 0.1006);
    ex.setPrice('DOGEUSDT', 0.1006);
    advance(61_000);
    const wallet = ex.wallet;
    await live.tick();
    expect(live.panic!.pos.size).toBe(0);
    expect((await ex.position('DOGEUSDT')).qty).toBe(0);
    expect(ex.wallet).toBeGreaterThan(wallet + 20); // ~5.9% on $500, less fees
    expect(live.panic!.trades).toBe(1);
  });

  it('stops out 8% under the entry without waiting for the next minute', async () => {
    const { ex, live, advance, logs } = setup();
    await live.start();
    await live.tick();
    ex.candles['DOGEUSDT|1m'] = minutes(0.1, 0.095);
    ex.setPrice('DOGEUSDT', 0.095);
    advance(61_000);
    await live.tick();
    expect(live.panic!.pos.size).toBe(1);
    ex.setPrice('DOGEUSDT', 0.087); // −8.4%; the exchange-side stop fires first in the mock
    advance(2_000);
    await live.tick();
    expect(live.panic!.pos.size).toBe(0);
    expect((await ex.position('DOGEUSDT')).qty).toBe(0);
    expect(logs.some((l) => l.includes('PANIC DOGEUSDT sold'))).toBe(true);
  });

  it('keeps its position across a restart and closes it on the kill switch', async () => {
    const { ex, live, advance } = setup();
    await live.start();
    await live.tick();
    ex.candles['DOGEUSDT|1m'] = minutes(0.1, 0.095);
    ex.setPrice('DOGEUSDT', 0.095);
    advance(61_000);
    await live.tick();
    const snap = live.snapshot();
    expect(snap.panic?.pos).toHaveLength(1);

    const again = new LiveGrid(ex, { candidates: () => [], stressed: () => false, log: () => undefined }, { ...DEFAULT_LIVE, maxCapital: 200, leverage: 5, maxCoins: 1, panic: PANIC }, Object.keys(RULES));
    await again.start(snap);
    expect(again.panic!.pos.has('DOGEUSDT')).toBe(true);
    expect((await ex.position('DOGEUSDT')).qty).toBeGreaterThan(0); // not sold by the restart
    await again.kill('test');
    expect((await ex.position('DOGEUSDT')).qty).toBe(0);
    expect(again.panic!.pos.size).toBe(0);
  });

  it('a kill from a session without panic configured still closes panic positions left in the snapshot', async () => {
    const { ex, live, advance } = setup();
    await live.start();
    await live.tick();
    ex.candles['DOGEUSDT|1m'] = minutes(0.1, 0.095);
    ex.setPrice('DOGEUSDT', 0.095);
    advance(61_000);
    await live.tick();
    const killer = new LiveGrid(ex, { candidates: () => [], stressed: () => false, log: () => undefined }, { ...DEFAULT_LIVE, maxCapital: 200, leverage: 5, maxCoins: 1 }, Object.keys(RULES));
    await killer.start(live.snapshot());
    await killer.kill('--kill');
    expect((await ex.position('DOGEUSDT')).qty).toBe(0);
  });

  it('after an upgrade, a grid holding every coin hands flat coins back so panic buy gets one', async () => {
    const { ex } = setup();
    const cands: LiveCandidate[] = [
      { symbol: 'DOGEUSDT', genome: G, score: 0.1 },
      { symbol: 'XRPUSDT', genome: G, score: 0.05 },
    ];
    const host: LiveHost = { candidates: () => cands, stressed: () => false, log: () => undefined };
    // The old profile: grid only, 2 coins.
    const old = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 200, leverage: 5, maxCoins: 2 }, Object.keys(RULES));
    await old.start();
    await old.tick();
    expect(old.coins.size).toBe(2);
    // The new profile resumes it: 1 grid coin + panic buy.
    const now = { t: Date.now() };
    const next = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 200, leverage: 5, maxCoins: 1, panic: PANIC }, Object.keys(RULES), () => now.t);
    await next.start(old.snapshot());
    await next.tick();
    expect(next.coins.size).toBe(1);
    expect(next.panic!.set).toHaveLength(1);
    expect(next.coins.has(next.panic!.set[0])).toBe(false);
  });
});
