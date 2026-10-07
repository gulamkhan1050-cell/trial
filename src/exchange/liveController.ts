import { type Engine, WIDE_MARKETS, MEGA_MARKETS } from '../core/engine';
import { BinanceFutures, type Network } from './binance';
import { DEFAULT_LIVE, type LiveCandidate, LiveGrid, type LiveHost, type LiveSnapshot } from './liveGrid';
import type { PanicConfig } from './panic';
import type { ExchangeClient } from './types';

/**
 * Connects the running Engine (FORGE's grids, SENTRY, crash guard, decision log) to a
 * LiveGrid trading real orders, and drives it on a timer.
 */

export interface LiveSettings {
  network: Network;
  apiKey: string;
  apiSecret: string;
  maxCapital: number;
  leverage: number;
  maxCoins: number;
  dailyLossLimit: number;
  /** Reinvest: the trading budget grows with profit (and shrinks with losses). */
  compound: boolean;
  /** USDT: once today's result reaches it, stop buying until tomorrow and keep the profit. 0 = off. */
  dailyTarget: number;
  /** At the daily target: pause until tomorrow, or take the profit and restart at once. */
  afterTarget: 'pause' | 'restart';
  /** Panic-buy strategy next to the grid (its own coins and budget share); absent = grid only. */
  panic?: PanicConfig;
}

// The aggressive profile: real-week Arena runs at 5x on 15 coins made +10% to +23% a week, with 14-20% drops.
export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  network: 'demo',
  apiKey: '',
  apiSecret: '',
  maxCapital: 300,
  leverage: 3,
  maxCoins: 8,
  dailyLossLimit: 0.2,
  compound: true,
  dailyTarget: 10,
  afterTarget: 'pause',
};

/** How often the live grid syncs with the exchange. Per-coin order checks keep this well inside Binance's rate limits. */
export const LIVE_TICK_MS = 1500;

const KEY = 'swarmdesk:binance';
const AUTO = 'swarmdesk:live:auto';

/** Live trading was started and not killed: the app picks it back up by itself when reopened. */
export function shouldAutoStart(): boolean {
  try {
    return localStorage.getItem(AUTO) === '1';
  } catch {
    return false;
  }
}

function setAutoStart(on: boolean) {
  try {
    if (on) localStorage.setItem(AUTO, '1');
    else localStorage.removeItem(AUTO);
  } catch {
    /* storage unavailable */
  }
}

/** Keys are kept only in this device's browser storage and are sent only to Binance (as a signature). */
export function loadLiveSettings(): LiveSettings {
  try {
    return { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_LIVE_SETTINGS };
  }
}

export function saveLiveSettings(s: LiveSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Where a running grid is saved, per network and API key, so a restart picks it back up. */
function snapshotKey(s: LiveSettings) {
  return `swarmdesk:live:${s.network}:${s.apiKey.slice(0, 8)}`;
}

function loadSnapshot(s: LiveSettings): LiveSnapshot | null {
  try {
    return JSON.parse(localStorage.getItem(snapshotKey(s)) ?? 'null');
  } catch {
    return null;
  }
}

function saveSnapshot(s: LiveSettings, snap: LiveSnapshot | null) {
  try {
    if (snap) localStorage.setItem(snapshotKey(s), JSON.stringify(snap));
    else localStorage.removeItem(snapshotKey(s));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Vetoes that come from the paper simulation's own money (its daily loss limit, its cooldown after a paper stop,
 * its banked target), not from the market. With the fixed grid they must not stop the real bot: it has its own
 * loss limit, cooldown and take-profit. Market vetoes (crash guard, a coin selling off, a downtrend) still apply.
 */
export function paperOnly(why: string): boolean {
  return /daily loss limit|cooldown|daily target/.test(why);
}

export type LiveStatus = 'off' | 'starting' | 'running' | 'killed' | 'error';

export class LiveController {
  live: LiveGrid | null = null;
  status: LiveStatus = 'off';
  message = '';
  network: Network = 'testnet';
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: LiveSettings | null = null;

  constructor(
    private engine: Engine,
    private makeClient: (s: LiveSettings) => ExchangeClient = (s) => new BinanceFutures(s.apiKey, s.apiSecret, s.network),
  ) {}

  /** Grid coins FORGE currently rates and SENTRY allows, best out-of-sample profit first. */
  host(): LiveHost {
    const e = this.engine;
    return {
      // Coins FORGE rates and SENTRY allows, never one in a downtrend; rising coins first, then best score.
      candidates: (): LiveCandidate[] =>
        [...e.grids.values()]
          .filter((g) => g.forge.champion && (g.bot?.armed || !g.why || (e.settings.grid.fixed && paperOnly(g.why))) && !(e.settings.grid.regime && g.regime?.regime === 'down'))
          .map((g) => ({ symbol: g.symbol, genome: g.forge.champion!.genome, score: g.forge.champion!.test.profit, regime: g.regime?.regime }))
          .sort((a, b) => Number(b.regime === 'up') - Number(a.regime === 'up') || b.score - a.score),
      breadth: () => (e.settings.grid.regime ? e.marketBreadth() : 1),
      stressed: () => e.isStressed(),
      log: (kind, text, pnl) => e.logExternal(kind, text, pnl),
    };
  }

  /** Check the keys and read the futures wallet without trading. */
  async check(s: LiveSettings): Promise<{ wallet: number; available: number }> {
    return this.makeClient(s).balance();
  }

  async start(s: LiveSettings) {
    if (this.status === 'running' || this.status === 'starting') return;
    if (!this.engine.gridMode()) throw new Error('Live trading runs the grid strategy — pick a Live grid preset first');
    if (this.engine.settings.feed !== 'binance') throw new Error('Live trading needs the Binance live feed (★ Live grid preset), not replay or simulator');
    this.status = 'starting';
    this.message = '';
    this.network = s.network;
    this.engine.notify();
    try {
      const universe = [...new Set([...this.engine.settings.symbols, ...WIDE_MARKETS, ...MEGA_MARKETS])];
      this.live = new LiveGrid(
        this.makeClient(s),
        this.host(),
        { ...DEFAULT_LIVE, maxCapital: s.maxCapital, leverage: s.leverage, maxCoins: s.maxCoins, dailyLossLimit: s.dailyLossLimit, compound: s.compound, dailyTarget: s.dailyTarget, afterTarget: s.afterTarget, panic: s.panic, makerFee: this.engine.settings.grid.maker },
        universe,
      );
      await this.live.start(loadSnapshot(s));
      this.current = s;
      this.status = 'running';
      setAutoStart(true);
      this.timer = setInterval(async () => {
        if (!this.live) return;
        await this.live.tick();
        if (this.live.killed) {
          this.status = 'killed';
          this.stopTimer();
          saveSnapshot(s, null);
          setAutoStart(false); // the loss limit fired: don't resume by itself
        } else saveSnapshot(s, this.live.snapshot());
        this.message = this.live.lastError;
        this.engine.notify();
      }, LIVE_TICK_MS);
      void this.live.tick().then(() => this.engine.notify());
    } catch (e) {
      this.status = 'error';
      this.message = (e as Error).message;
      this.live = null;
    }
    this.engine.notify();
  }

  /** Kill switch: cancel every order, close every position, stop trading. */
  async kill(reason = 'kill switch pressed') {
    this.stopTimer();
    if (this.live) await this.live.kill(reason);
    if (this.current) saveSnapshot(this.current, null);
    setAutoStart(false);
    this.status = 'killed';
    this.engine.notify();
  }

  /** Start counting profit from zero now; trading carries on untouched. */
  resetStats() {
    if (!this.live || !this.current) return;
    this.live.resetStats();
    saveSnapshot(this.current, this.live.snapshot());
    this.engine.notify();
  }

  /** Stop driving the bot but leave its orders and positions on the exchange (resumed next start). */
  pause() {
    this.stopTimer();
    if (this.live && this.current && !this.live.killed) saveSnapshot(this.current, this.live.snapshot());
    this.status = 'off';
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
