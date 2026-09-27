import { type Engine, WIDE_MARKETS, MEGA_MARKETS } from '../core/engine';
import { BinanceFutures, type Network } from './binance';
import { DEFAULT_LIVE, type LiveCandidate, LiveGrid, type LiveHost } from './liveGrid';
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
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  network: 'demo',
  apiKey: '',
  apiSecret: '',
  maxCapital: 100,
  leverage: 3,
  maxCoins: 5,
  dailyLossLimit: 0.1,
};

const KEY = 'swarmdesk:binance';

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

export type LiveStatus = 'off' | 'starting' | 'running' | 'killed' | 'error';

export class LiveController {
  live: LiveGrid | null = null;
  status: LiveStatus = 'off';
  message = '';
  network: Network = 'testnet';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private engine: Engine,
    private makeClient: (s: LiveSettings) => ExchangeClient = (s) => new BinanceFutures(s.apiKey, s.apiSecret, s.network),
  ) {}

  /** Grid coins FORGE currently rates and SENTRY allows, best out-of-sample profit first. */
  host(): LiveHost {
    const e = this.engine;
    return {
      candidates: (): LiveCandidate[] =>
        [...e.grids.values()]
          .filter((g) => g.forge.champion && (g.bot?.armed || !g.why))
          .map((g) => ({ symbol: g.symbol, genome: g.forge.champion!.genome, score: g.forge.champion!.test.profit }))
          .sort((a, b) => b.score - a.score),
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
        { ...DEFAULT_LIVE, maxCapital: s.maxCapital, leverage: s.leverage, maxCoins: s.maxCoins, dailyLossLimit: s.dailyLossLimit, makerFee: this.engine.settings.grid.maker },
        universe,
      );
      await this.live.start();
      this.status = 'running';
      this.timer = setInterval(async () => {
        if (!this.live) return;
        await this.live.tick();
        if (this.live.killed) {
          this.status = 'killed';
          this.stopTimer();
        }
        this.message = this.live.lastError;
        this.engine.notify();
      }, 3000);
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
    this.status = 'killed';
    this.engine.notify();
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
