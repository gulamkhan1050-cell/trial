import { gauss, mulberry32 } from './rng';
import type { Candle } from './types';

export type FeedStatus = 'connecting' | 'live' | 'sim' | 'error';

export interface FeedHandlers {
  /** Full history for a symbol (bootstrap). */
  onHistory(symbol: string, candles: Candle[]): void;
  /** Update of the forming candle; `closed` marks the final update of that bar. */
  onCandle(symbol: string, candle: Candle, closed: boolean): void;
  onStatus(status: FeedStatus, detail: string): void;
}

export interface MarketFeed {
  readonly name: string;
  start(symbols: string[], h: FeedHandlers): Promise<void>;
  stop(): void;
}

// ---------------------------------------------------------------- Binance (public market data)

export interface BinanceFeedOptions {
  rest: string;
  ws: string;
  interval: string; // e.g. '1m'
  history: number;
}

export const BINANCE_PUBLIC: BinanceFeedOptions = {
  // Market-data-only mirrors: no API key needed, and they carry permissive CORS headers.
  rest: 'https://data-api.binance.vision',
  ws: 'wss://data-stream.binance.vision',
  interval: '1m',
  history: 600,
};

type RawKline = [number, string, string, string, string, string, number, string];

export class BinanceFeed implements MarketFeed {
  readonly name = 'Binance';
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry = 0;

  constructor(private opt: BinanceFeedOptions = BINANCE_PUBLIC) {}

  async start(symbols: string[], h: FeedHandlers): Promise<void> {
    this.stopped = false;
    h.onStatus('connecting', `${this.opt.rest}`);
    await Promise.all(
      symbols.map(async (s) => {
        const url = `${this.opt.rest}/api/v3/klines?symbol=${s}&interval=${this.opt.interval}&limit=${this.opt.history}`;
        const res = await fetchWithTimeout(url, 10000);
        if (!res.ok) throw new Error(`${s}: HTTP ${res.status}`);
        const rows = (await res.json()) as RawKline[];
        // Last row is the still-forming candle; history is closed bars only.
        h.onHistory(s, rows.slice(0, -1).map(parseKline));
      }),
    );
    this.connect(symbols, h);
  }

  private connect(symbols: string[], h: FeedHandlers) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@kline_${this.opt.interval}`).join('/');
    const ws = new WebSocket(`${this.opt.ws}/stream?streams=${streams}`);
    this.socket = ws;
    ws.onopen = () => {
      this.retry = 0;
      h.onStatus('live', 'streaming');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const k = msg?.data?.k;
      if (!k) return;
      h.onCandle(k.s, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q }, !!k.x);
    };
    ws.onclose = () => {
      if (this.stopped) return;
      h.onStatus('connecting', 'reconnecting');
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => !this.stopped && this.connect(symbols, h), wait);
    };
    ws.onerror = () => ws.close();
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }
}

function parseKline(r: RawKline): Candle {
  return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Simulator (offline / turbo mode)

const SIM_BASE: Record<string, number> = {
  BTCUSDT: 65000,
  ETHUSDT: 3200,
  SOLUSDT: 150,
  BNBUSDT: 580,
  XRPUSDT: 0.6,
  DOGEUSDT: 0.12,
};

/**
 * Regime-switching random walk: alternates trending and choppy phases so every
 * strategy family has something to find. Not a forecast of anything — a sandbox.
 */
export class SimFeed implements MarketFeed {
  readonly name = 'Simulator';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private barMs = 2000,
    private seed = Date.now() % 1e9,
    private history = 600,
  ) {}

  async start(symbols: string[], h: FeedHandlers): Promise<void> {
    const models = symbols.map((s, i) => new SimModel(s, SIM_BASE[s] ?? 100, this.seed + i * 7919));
    const now = Date.now();
    const barSpan = 60_000;
    for (const m of models) {
      const hist: Candle[] = [];
      for (let i = this.history; i > 0; i--) hist.push(m.bar(now - i * barSpan));
      h.onHistory(m.symbol, hist);
    }
    h.onStatus('sim', `1 bar / ${(this.barMs / 1000).toFixed(1)}s`);

    const ticksPerBar = 4;
    let tick = 0;
    let barTime = now;
    let forming = models.map((m) => m.open(barTime));
    this.timer = setInterval(() => {
      tick++;
      const closed = tick % ticksPerBar === 0;
      models.forEach((m, i) => {
        forming[i] = m.tick(forming[i], 1 / ticksPerBar);
        h.onCandle(m.symbol, { ...forming[i] }, closed);
      });
      if (closed) {
        barTime += barSpan;
        forming = models.map((m) => m.open(barTime));
      }
    }, this.barMs / ticksPerBar);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

class SimModel {
  private rand: () => number;
  private price: number;
  private drift = 0;
  private vol = 0.0015;
  private regimeLeft = 0;

  constructor(
    readonly symbol: string,
    base: number,
    seed: number,
  ) {
    this.rand = mulberry32(seed);
    this.price = base * (0.9 + this.rand() * 0.2);
  }

  private maybeSwitch() {
    if (this.regimeLeft-- > 0) return;
    this.regimeLeft = 40 + Math.floor(this.rand() * 160);
    const r = this.rand();
    if (r < 0.35) this.drift = 0;
    else this.drift = (this.rand() < 0.5 ? -1 : 1) * (0.0002 + this.rand() * 0.0006);
    this.vol = 0.0008 + this.rand() * 0.002;
  }

  open(t: number): Candle {
    this.maybeSwitch();
    return { t, o: this.price, h: this.price, l: this.price, c: this.price, v: 0 };
  }

  tick(c: Candle, frac: number): Candle {
    const ret = this.drift * frac + gauss(this.rand) * this.vol * Math.sqrt(frac);
    this.price *= Math.exp(ret);
    const wick = Math.abs(gauss(this.rand)) * this.vol * 0.3 * this.price;
    // Quote volume in USDT, independent of price level.
    const v = (40_000 + this.rand() * 160_000) * frac * (1 + Math.abs(ret) / (this.vol * Math.sqrt(frac)));
    return {
      t: c.t,
      o: c.o,
      h: Math.max(c.h, this.price + wick),
      l: Math.min(c.l, this.price - wick),
      c: this.price,
      v: c.v + v,
    };
  }

  bar(t: number): Candle {
    let c = this.open(t);
    for (let i = 0; i < 4; i++) c = this.tick(c, 0.25);
    return c;
  }
}
