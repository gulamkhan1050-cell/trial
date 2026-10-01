import { describe, expect, it } from 'vitest';
import { LiveGrid, type LiveCandidate, type LiveHost, DEFAULT_LIVE } from '../src/exchange/liveGrid';
import { MockExchange } from '../src/exchange/mock';
import type { GridGenome } from '../src/core/grid';

const RULES = {
  DOGEUSDT: { symbol: 'DOGEUSDT', tickSize: 0.00001, stepSize: 1, minQty: 1, minNotional: 5 },
  XRPUSDT: { symbol: 'XRPUSDT', tickSize: 0.0001, stepSize: 0.1, minQty: 0.1, minNotional: 5 },
  BTCUSDT: { symbol: 'BTCUSDT', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 100 },
};
const G: GridGenome = { id: 'g1', spacing: 0.01, levels: 5, stop: 0.02 };

function setup(cands: LiveCandidate[] = [{ symbol: 'DOGEUSDT', genome: G, score: 0.05 }]) {
  const ex = new MockExchange(RULES, 100);
  const logs: string[] = [];
  const state = { stressed: false, cands };
  const host: LiveHost = {
    candidates: () => state.cands,
    stressed: () => state.stressed,
    log: (_k, t) => logs.push(t),
  };
  let now = 1_000_000;
  const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 100, leverage: 3, maxCoins: 5 }, Object.keys(RULES), () => now);
  return { ex, live, logs, state, advance: (ms: number) => (now += ms) };
}

describe('LiveGrid on a mock exchange', () => {
  it('arms a coin with post-only buys sized to the budget and exchange minimums', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    const coin = live.coins.get('DOGEUSDT')!;
    expect(coin.levels).toHaveLength(5);
    expect(ex.calls).toContain('setup DOGEUSDT 3x');
    const open = await ex.openOrders();
    expect(open).toHaveLength(5);
    // $100 × 3 / 5 coins = $60 per coin, 5 levels ≈ $12 each, all ≥ the $5 minimum.
    for (const o of open) {
      expect(o.side).toBe('BUY');
      expect(o.price).toBeLessThan(0.1);
      expect(o.price * o.origQty).toBeGreaterThanOrEqual(5);
      expect(o.price * o.origQty).toBeLessThanOrEqual(12.5);
    }
  });

  it('flips a filled buy into a take-profit and books the round trip when it sells', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    const walletBefore = ex.wallet;
    ex.setPrice('DOGEUSDT', 0.0985); // trades through L1 at 0.099
    await live.tick();
    const l1 = live.coins.get('DOGEUSDT')!.levels[0];
    expect(l1.side).toBe('sell');
    expect(l1.price).toBeCloseTo(0.09999, 5);
    expect((await ex.openOrders()).some((o) => o.side === 'SELL')).toBe(true);
    ex.setPrice('DOGEUSDT', 0.1); // take-profit fills
    await live.tick();
    expect(live.roundTrips).toBe(1);
    expect(live.realized).toBeGreaterThan(0);
    expect(l1.side).toBe('buy');
    expect(ex.wallet).toBeGreaterThan(walletBefore);
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
  });

  it('never places a buy at or above the market (post-only would be rejected)', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985);
    await live.tick(); // L1 bought; L2 (0.098) still below market
    const buys = (await ex.openOrders()).filter((o) => o.side === 'BUY');
    for (const o of buys) expect(o.price).toBeLessThan(0.0985);
  });

  it('stops out below the ladder: closes the position, cancels orders, cools the coin down', async () => {
    const { ex, live, advance } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0935); // fills all 5 buys (lowest 0.095), stop at 0.0931
    await live.tick();
    expect(ex.positions.DOGEUSDT.qty).toBeGreaterThan(0);
    ex.setPrice('DOGEUSDT', 0.093);
    await live.tick();
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
    expect(live.coins.has('DOGEUSDT')).toBe(false);
    expect(await ex.openOrders()).toHaveLength(0);
    // Cooldown: not re-armed on the next tick…
    await live.tick();
    expect(live.coins.has('DOGEUSDT')).toBe(false);
    // …but eligible again after it expires.
    advance(DEFAULT_LIVE.cooldownMs + 1);
    await live.tick();
    expect(live.coins.has('DOGEUSDT')).toBe(true);
  });

  it('keeps an exchange-side stop while holding and removes it when flat', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985);
    await live.tick();
    expect(ex.stops.size).toBe(1);
    ex.setPrice('DOGEUSDT', 0.1);
    await live.tick();
    expect(ex.stops.size).toBe(0);
  });

  it('skips coins whose exchange minimum is larger than the per-coin slice', async () => {
    const { ex, live } = setup([
      { symbol: 'BTCUSDT', genome: G, score: 0.1 },
      { symbol: 'XRPUSDT', genome: G, score: 0.05 },
    ]);
    ex.setPrice('BTCUSDT', 60000);
    ex.setPrice('XRPUSDT', 0.6);
    await live.start();
    await live.tick();
    expect(live.coins.has('BTCUSDT')).toBe(false); // $100 minimum vs $60 slice
    expect(live.coins.has('XRPUSDT')).toBe(true);
  });

  it('flattens everything when the crash guard is active', async () => {
    const { ex, live, state } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985);
    await live.tick();
    state.stressed = true;
    await live.tick();
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
    expect(live.coins.size).toBe(0);
    expect(await ex.openOrders()).toHaveLength(0);
  });

  it('kill switch closes all positions and stops trading', async () => {
    const { ex, live, logs } = setup([
      { symbol: 'DOGEUSDT', genome: G, score: 0.1 },
      { symbol: 'XRPUSDT', genome: G, score: 0.05 },
    ]);
    ex.setPrice('DOGEUSDT', 0.1);
    ex.setPrice('XRPUSDT', 0.6);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985);
    ex.setPrice('XRPUSDT', 0.593);
    await live.tick();
    await live.kill('user pressed kill');
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
    expect(ex.positions.XRPUSDT.qty).toBe(0);
    expect(await ex.openOrders()).toHaveLength(0);
    expect(live.running).toBe(false);
    await live.tick(); // no-op once killed
    expect(await ex.openOrders()).toHaveLength(0);
    expect(logs.some((l) => l.includes('LIVE trading stopped'))).toBe(true);
  });

  it('respects the capital cap even when the wallet holds more', async () => {
    const { ex, live } = setup();
    ex.wallet = 5000;
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    expect(live.budget).toBe(100);
  });

  it('trips the loss limit into the kill switch', async () => {
    const { ex, live, advance } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.wallet -= 20; // lost 20% of the $100 budget (limit 10%)
    advance(31_000);
    await live.tick();
    expect(live.killed).toBe(true);
    expect(await ex.openOrders()).toHaveLength(0);
  });
});

describe('LiveGrid housekeeping', () => {
  it("cleans up a previous session's orders on start, then trades normally", async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    expect(await ex.openOrders()).toHaveLength(5);
    // App restarted: a brand-new session on the same account.
    const again = setup();
    const live2 = new LiveGrid(ex, { candidates: () => again.state.cands, stressed: () => false, log: () => undefined }, { ...DEFAULT_LIVE }, ['DOGEUSDT']);
    await live2.start();
    expect(await ex.openOrders()).toHaveLength(0); // old ladder cancelled
    await live2.tick();
    expect(await ex.openOrders()).toHaveLength(5); // new ladder placed, no -4067 loop
  });

  it("never touches a coin that has orders the user placed by hand", async () => {
    const { ex, live, logs } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    ex.manualOrder('DOGEUSDT', 'BUY', 100, 0.09);
    await live.start();
    await live.tick();
    expect(live.coins.has('DOGEUSDT')).toBe(false);
    expect((await ex.openOrders()).map((o) => o.clientOrderId)).toEqual(['web_manual']);
    expect(logs.some((l) => l.includes("won't trade it"))).toBe(true);
    await live.kill('test');
    expect(await ex.openOrders()).toHaveLength(1); // kill leaves the user's own order alone
  });

  it('skips a coin whose setup fails instead of stalling every sync', async () => {
    const { ex, live, logs } = setup([
      { symbol: 'DOGEUSDT', genome: G, score: 0.1 },
      { symbol: 'XRPUSDT', genome: G, score: 0.05 },
    ]);
    const orig = ex.setup.bind(ex);
    ex.setup = async (s: string, lev: number) => {
      if (s === 'DOGEUSDT') throw new Error('Binance -4067: Position side cannot be changed if there exists open orders.');
      return orig(s, lev);
    };
    ex.setPrice('DOGEUSDT', 0.1);
    ex.setPrice('XRPUSDT', 0.6);
    await live.start();
    await live.tick();
    expect(live.coins.has('DOGEUSDT')).toBe(false);
    expect(live.coins.has('XRPUSDT')).toBe(true);
    expect(logs.filter((l) => l.includes('setup failed')).length).toBe(1);
    await live.tick(); // cooled down: not retried every tick
    expect(logs.filter((l) => l.includes('setup failed')).length).toBe(1);
  });

  it('switches Hedge Mode to one-way, or explains how when it cannot', async () => {
    const a = setup();
    a.ex.hedgeMode = true;
    a.ex.setPrice('DOGEUSDT', 0.1);
    await a.live.start();
    expect(a.ex.hedgeMode).toBe(false);

    const b = setup();
    b.ex.hedgeMode = true;
    b.ex.manualOrder('XRPUSDT', 'BUY', 10, 0.5);
    await expect(b.live.start()).rejects.toThrow(/Position side/);
  });
});

describe('post-only rejections (-5022)', () => {
  it('keeps retrying a take-profit rejected as would-cross, without counting failures or logging', async () => {
    const { ex, live, logs } = setup();
    ex.postOnlyThrows = true;
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    // Make every sell attempt cross: the mock rejects with -5022 like Binance does.
    const orig = ex.limitMaker.bind(ex);
    let sellAttempts = 0;
    ex.limitMaker = async (s, side, q, p, ro) => {
      if (side === 'SELL') {
        sellAttempts++;
        const { BinanceError } = await import('../src/exchange/binance');
        throw new BinanceError(-5022, 'Post Only order will be rejected');
      }
      return orig(s, side, q, p, ro);
    };
    ex.setPrice('DOGEUSDT', 0.0985); // L1 buy fills
    await live.tick();
    const l1 = live.coins.get('DOGEUSDT')!.levels[0];
    expect(l1.side).toBe('sell');
    for (let i = 0; i < 8; i++) await live.tick();
    expect(sellAttempts).toBeGreaterThanOrEqual(8); // never gave up on the take-profit
    expect(l1.fails).toBe(0);
    expect(logs.some((l) => l.includes('rejected'))).toBe(false);
    // Once the market allows it, the take-profit goes on the book.
    ex.limitMaker = orig;
    ex.postOnlyThrows = false;
    await live.tick();
    expect((await ex.openOrders()).some((o) => o.side === 'SELL')).toBe(true);
  });

  it('backs off after repeated real rejections but retries later', async () => {
    const { ex, live, advance } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    const orig = ex.limitMaker.bind(ex);
    let attempts = 0;
    ex.limitMaker = async () => {
      attempts++;
      throw new Error('Binance -2019: Margin is insufficient.');
    };
    for (let i = 0; i < 10; i++) await live.tick();
    const perLevel = attempts / live.coins.get('DOGEUSDT')!.levels.length;
    expect(perLevel).toBe(5); // stopped hammering after 5 failures per level
    ex.limitMaker = orig;
    advance(5 * 60_000 + 1);
    await live.tick();
    expect((await ex.openOrders()).length).toBe(5); // retried after the back-off
  });
});

describe('LiveGrid compounding and speed', () => {
  it('reinvests profit into new ladders and shrinks them after losses', async () => {
    const ex = new MockExchange(RULES, 100);
    let now = 1_000_000;
    const host: LiveHost = { candidates: () => [{ symbol: 'DOGEUSDT', genome: G, score: 0.05 }], stressed: () => false, log: () => undefined };
    const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 100, leverage: 3, maxCoins: 5, compound: true }, Object.keys(RULES), () => now);
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    expect(live.budget).toBe(100);
    ex.wallet += 40; // profit booked
    now += 31_000;
    await live.tick();
    expect(live.budget).toBeCloseTo(140, 6);
    expect(live.slice()).toBeCloseTo((140 * 3) / 5, 6); // new ladders are bigger
    ex.wallet -= 70; // then a loss
    now += 31_000;
    await live.tick();
    expect(live.budget).toBeCloseTo(70, 6);
  });

  it('keeps a fixed budget when compounding is off', async () => {
    const { ex, live, advance } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    ex.wallet += 40;
    advance(31_000);
    await live.tick();
    expect(live.budget).toBe(100);
  });

  it('checks open orders per coin, never with the expensive all-symbols query', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    ex.calls.length = 0;
    for (let i = 0; i < 3; i++) await live.tick();
    const checks = ex.calls.filter((c) => c.startsWith('OPEN-ORDERS'));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c === 'OPEN-ORDERS DOGEUSDT')).toBe(true);
  });
});

describe('LiveGrid resume after a restart', () => {
  /** A second session on the same exchange, as after the phone or app restarts. */
  function restart(ex: MockExchange, cands: LiveCandidate[] = []) {
    const logs: string[] = [];
    const host: LiveHost = { candidates: () => cands, stressed: () => false, log: (_k, t) => logs.push(t) };
    let now = 2_000_000;
    const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 100, leverage: 3, maxCoins: 5 }, Object.keys(RULES), () => now);
    return { live, logs, advance: (ms: number) => (now += ms) };
  }

  it('keeps the orders and the bought coins, and books the take-profit that fills afterwards', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985); // L1 bought, its take-profit rests at ~0.09999
    await live.tick();
    const snap = JSON.parse(JSON.stringify(live.snapshot())); // through storage and back
    const posBefore = ex.positions.DOGEUSDT.qty;
    const ordersBefore = (await ex.openOrders()).map((o) => o.orderId).sort();

    // Restart before FORGE has re-judged anything (no candidates yet).
    const r = restart(ex);
    await r.live.start(snap);
    expect(r.live.resumed).toBe(1);
    expect(ex.calls.filter((c) => c.startsWith('CLOSE'))).toHaveLength(0); // nothing sold at market
    expect(ex.positions.DOGEUSDT.qty).toBe(posBefore);
    await r.live.tick();
    expect((await ex.openOrders()).map((o) => o.orderId).sort()).toEqual(ordersBefore); // same orders, none re-placed
    expect(r.live.startWallet).toBe(live.startWallet); // "since start" carries on

    ex.setPrice('DOGEUSDT', 0.1); // the take-profit placed by the old session fills
    await r.live.tick();
    expect(r.live.roundTrips).toBe(1);
    expect(r.live.realized).toBeGreaterThan(0);
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
    // Flat and FORGE has nothing for it: retired only after the grace period.
    expect(r.live.coins.has('DOGEUSDT')).toBe(true);
    r.advance(10 * 60_000 + 1);
    await r.live.tick();
    expect(r.live.coins.has('DOGEUSDT')).toBe(false);
  });

  it('re-arms a coin whose exchange-side stop fired while the app was off', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985);
    await live.tick(); // holding L1, exchange stop placed
    const snap = JSON.parse(JSON.stringify(live.snapshot()));
    ex.setPrice('DOGEUSDT', 0.09); // app is off: the exchange stop closes the position
    expect(ex.positions.DOGEUSDT.qty).toBe(0);
    ex.setPrice('DOGEUSDT', 0.1);

    const r = restart(ex, [{ symbol: 'DOGEUSDT', genome: G, score: 0.05 }]);
    await r.live.start(snap);
    await r.live.tick();
    expect(r.logs.some((l) => l.includes('closed while the app was off'))).toBe(true);
    await r.live.tick();
    const open = await ex.openOrders();
    expect(open.every((o) => o.side === 'BUY')).toBe(true); // no orphan take-profits
    expect(open).toHaveLength(5); // fresh ladder under the current price
  });
});

describe('LiveGrid count reset', () => {
  it('starts total, round trips and per-day from zero without touching orders', async () => {
    const { ex, live } = setup();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985);
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.1);
    await live.tick();
    expect(live.roundTrips).toBe(1);
    const orders = (await ex.openOrders()).map((o) => o.orderId).sort();
    live.resetStats();
    expect(live.roundTrips).toBe(0);
    expect(live.realized).toBe(0);
    expect(live.wallet - live.startWallet + live.unrealized).toBeCloseTo(0, 9);
    expect((await ex.openOrders()).map((o) => o.orderId).sort()).toEqual(orders);
  });
});

describe('LiveGrid daily target and loss limit', () => {
  it('banks the day: once the target is hit, resting buys are cancelled and only take-profits run', async () => {
    const ex = new MockExchange(RULES, 100);
    let now = Date.UTC(2026, 9, 1, 8);
    const host: LiveHost = { candidates: () => [{ symbol: 'DOGEUSDT', genome: G, score: 0.05 }], stressed: () => false, log: () => undefined };
    const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 100, leverage: 3, maxCoins: 5, dailyTarget: 2 }, Object.keys(RULES), () => now);
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.setPrice('DOGEUSDT', 0.0985); // L1 bought → take-profit resting
    now += 31_000;
    await live.tick();
    expect(live.locked).toBe(false);
    ex.wallet += 3; // the day is up $3 (target $2)
    now += 31_000;
    await live.tick();
    expect(live.locked).toBe(true);
    await live.tick();
    const open = await ex.openOrders();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o) => o.side === 'SELL')).toBe(true); // buys gone, the take-profit stays
    // Next UTC day: unlocked, buying again.
    now += 24 * 3_600_000;
    await live.tick();
    expect(live.locked).toBe(false);
    await live.tick();
    expect((await ex.openOrders()).some((o) => o.side === 'BUY')).toBe(true);
  });

  it('measures the loss limit against the trading budget, not a big wallet', async () => {
    const ex = new MockExchange(RULES, 5000); // demo wallet $5,000, bot budget $100
    let now = 1_000_000;
    const host: LiveHost = { candidates: () => [{ symbol: 'DOGEUSDT', genome: G, score: 0.05 }], stressed: () => false, log: () => undefined };
    const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 100, dailyLossLimit: 0.1 }, Object.keys(RULES), () => now);
    ex.setPrice('DOGEUSDT', 0.1);
    await live.start();
    await live.tick();
    ex.wallet -= 15; // $15 down = 15% of the $100 budget (only 0.3% of the wallet)
    now += 31_000;
    await live.tick();
    expect(live.killed).toBe(true);
  });
});

describe('LiveGrid market regime', () => {
  it('never arms a coin in a downtrend, and runs half the coins when most of the market is falling', async () => {
    const ex = new MockExchange(RULES, 100);
    ex.setPrice('DOGEUSDT', 0.1);
    ex.setPrice('XRPUSDT', 2);
    let mood = 1;
    const host: LiveHost = {
      candidates: () => [
        { symbol: 'DOGEUSDT', genome: G, score: 0.05, regime: 'down' },
        { symbol: 'XRPUSDT', genome: G, score: 0.01, regime: 'up' },
      ],
      stressed: () => false,
      log: () => undefined,
      breadth: () => mood,
    };
    const live = new LiveGrid(ex, host, { ...DEFAULT_LIVE, maxCapital: 100, maxCoins: 4 }, Object.keys(RULES));
    await live.start();
    await live.tick();
    expect([...live.coins.keys()]).toEqual(['XRPUSDT']); // DOGE skipped despite the better score
    expect(live.coinLimit()).toBe(4);
    mood = 0.3;
    expect(live.coinLimit()).toBe(2);
  });
});
