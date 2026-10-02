import { DEFAULT_SETTINGS, Engine, type Settings, WIDE_MARKETS } from './engine';
import { BINANCE_PUBLIC, BinanceFeed, type FeedHandlers, type MarketFeed } from './market';
import type { Candle } from './types';

/**
 * LIVE RACE — several complete trading systems run side by side on the same live Binance prices,
 * each with its own paper account, so the one that really earns more going forward can be picked
 * for real money. One price feed is shared by every racer (fair, and light on the network).
 */

export interface RacerSpec {
  id: string;
  name: string;
  note: string;
  grid: Partial<Settings['grid']>;
}

export const RACE_BALANCE = 300; // same as the live budget
export const RACE_LOSS_LIMIT = 0.2; // a racer that loses 20% is flattened and retired

const BOOST = { slices: 8, maxSpacing: 0.006, dailyTarget: 20 };

export const RACE_SPECS: RacerSpec[] = [
  // BOOST = bigger orders (bank split 8 ways, not 15), tighter steps (≤ 0.6%) for more fills, and bank the day at +$20.
  { id: 'plain3boost', name: 'PLAIN 3× BOOST', note: 'classic grid · 2× bigger orders · steps ≤0.6% · bank $20/day', grid: { leverage: 3, classicTp: true, regime: false, ...BOOST } },
  { id: 'plain5', name: 'PLAIN 5×', note: 'classic grid, more risk', grid: { leverage: 5, classicTp: true, regime: false } },
  { id: 'smart5boost', name: 'AGGRESSIVE 5× BOOST', note: 'smart TP + regime · 2× bigger orders · steps ≤0.6% · take $24 & restart', grid: { leverage: 5, classicTp: false, regime: true, ...BOOST, dailyTarget: 24, afterTarget: 'restart' } },
  { id: 'smart3', name: 'SMART 3×', note: 'smart take-profit + regime', grid: { leverage: 3, classicTp: false, regime: true } },
];

const META = 'swarmdesk:race:meta';

interface Meta {
  running: boolean;
  startedAt: number;
  out: Record<string, string>; // racer id → why it was retired
}

/** One real feed, many subscribers: history is replayed to each, live candles are broadcast. */
export class FeedHub {
  private subs = new Set<FeedHandlers>();
  private history: Record<string, Candle[]> = {};
  private started: Promise<void> | null = null;

  constructor(
    private symbols: string[],
    private feed: MarketFeed,
  ) {}

  get name(): string {
    return this.feed.name;
  }

  private ensure(): Promise<void> {
    return (this.started ??= this.feed.start(this.symbols, {
      onHistory: (s, c) => (this.history[s] = c),
      onCandle: (s, c, closed) => {
        if (closed) {
          const h = (this.history[s] ??= []);
          if (h[h.length - 1]?.t === c.t) h[h.length - 1] = c;
          else h.push(c);
          if (h.length > 1600) h.splice(0, h.length - 1600);
        }
        for (const sub of this.subs) sub.onCandle(s, c, closed);
      },
      onStatus: (st, d) => {
        for (const sub of this.subs) sub.onStatus(st, d);
      },
    }));
  }

  child(): MarketFeed {
    let mine: FeedHandlers | null = null;
    return {
      name: this.feed.name,
      start: async (symbols, h) => {
        await this.ensure();
        for (const s of symbols) if (this.history[s]) h.onHistory(s, [...this.history[s]]);
        mine = h;
        this.subs.add(h);
        h.onStatus('live', 'race');
      },
      stop: () => {
        if (mine) this.subs.delete(mine);
      },
    };
  }

  stop() {
    this.subs.clear();
    this.feed.stop();
    this.started = null;
  }
}

export interface Racer {
  spec: RacerSpec;
  engine: Engine;
  out: string; // '' while racing
}

export class LiveRace {
  racers: Racer[] = [];
  running = false;
  startedAt = 0;
  error = '';
  private hub: FeedHub | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private meta: Meta;

  constructor(
    private base: () => Settings = () => DEFAULT_SETTINGS,
    private makeFeed: () => MarketFeed = () => new BinanceFeed({ ...BINANCE_PUBLIC, interval: '1m' }),
    private specs: RacerSpec[] = RACE_SPECS,
    private onChange: () => void = () => undefined,
  ) {
    this.meta = load<Meta>(META) ?? { running: false, startedAt: 0, out: {} };
    this.startedAt = this.meta.startedAt;
  }

  /** The race was running when the app closed: pick it back up. */
  get wasRunning(): boolean {
    return this.meta.running;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.error = '';
    const b = this.base();
    const symbols = WIDE_MARKETS;
    this.hub = new FeedHub(symbols, this.makeFeed());
    this.racers = this.specs.map((spec, i) => ({
      spec,
      out: this.meta.out[spec.id] ?? '',
      engine: new Engine(
        {
          ...b,
          feed: 'binance',
          strategy: 'grid',
          interval: '1m',
          symbols,
          startBalance: RACE_BALANCE,
          grid: { ...b.grid, crashGuard: true, crashDrop: 0.025, crashBars: 30, crashShare: 0.67, ...spec.grid },
        },
        20261001 + i * 7919,
        `race:${spec.id}:`,
      ),
    }));
    for (const r of this.racers) r.engine.onChange(this.onChange);
    const feedName = this.hub.name;
    try {
      for (const r of this.racers) if (!r.out) await r.engine.start(this.hub.child());
    } catch (e) {
      this.error = (e as Error).message;
    }
    // An engine falls back to its own simulator when the real feed fails: that would race on made-up,
    // different prices, so stop instead.
    if (this.racers.some((r) => !r.out && r.engine.feedName !== feedName)) {
      this.error = 'Binance prices unreachable — race paused, press Start to retry';
      this.stop();
      return;
    }
    this.startedAt ||= Date.now();
    this.save(true);
    this.timer = setInterval(() => void this.check(), 30_000);
    this.onChange();
  }

  /** Retire a racer that hit its loss limit (flatten at market) and persist every book. */
  async check() {
    for (const r of this.racers) {
      if (r.out) continue;
      const e = r.engine;
      if (e.totalEquity() < e.startBalance * (1 - RACE_LOSS_LIMIT)) {
        await e.closeAll();
        e.stop();
        r.out = `retired: lost ${Math.round(RACE_LOSS_LIMIT * 100)}%`;
        this.meta.out[r.spec.id] = r.out;
      } else e.save();
    }
    this.save(true);
    this.onChange();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.racers) r.engine.stop(); // stop() saves each book
    this.hub?.stop();
    this.hub = null;
    this.running = false;
    this.save(false);
    this.onChange();
  }

  /** Wipe every racer's book and start the clock again from zero. */
  reset() {
    const was = this.running;
    if (was) this.stop();
    for (const spec of this.specs) {
      for (const k of ['book', 'champions']) remove(`swarmdesk:race:${spec.id}:${k}:binance`);
    }
    this.meta = { running: false, startedAt: 0, out: {} };
    this.startedAt = 0;
    this.racers = [];
    this.save(false);
    if (was) void this.start();
    this.onChange();
  }

  /** Leaderboard rows, best total result first. */
  standings() {
    return this.racers
      .map((r) => {
        const e = r.engine;
        const equity = e.totalEquity();
        let peak = e.startBalance;
        let maxDd = 0;
        for (const p of [...e.equity, { v: equity }]) {
          peak = Math.max(peak, p.v);
          maxDd = Math.max(maxDd, 1 - p.v / peak);
        }
        return {
          racer: r,
          equity,
          pnl: equity - e.startBalance,
          today: equity - (e.dayStartEquity || e.startBalance),
          trips: e.gridTotals().roundTrips,
          winRate: e.tradeCount ? e.winCount / e.tradeCount : 0,
          maxDd,
          holding: e.gridTotals().holding,
          armed: e.gridTotals().armed,
        };
      })
      .sort((a, b) => b.pnl - a.pnl);
  }

  private save(running: boolean) {
    this.meta.running = running;
    this.meta.startedAt = this.startedAt;
    try {
      localStorage.setItem(META, JSON.stringify(this.meta));
    } catch {
      /* storage unavailable */
    }
  }
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
