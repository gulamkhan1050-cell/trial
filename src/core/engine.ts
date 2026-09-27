import { type Candidate, scout } from '../agents/scout';
import { DEFAULT_SENTRY, type SentryConfig, sentry, type Verdict } from '../agents/sentry';
import { DEFAULT_HAWK, type HawkConfig, manage, plan, unrealized } from '../agents/hawk';
import { PaperBroker } from './broker';
import { DEFAULT_EVOLVER, type EvolverState, newEvolver, type Scored, step } from './evolver';
import { BinanceFeed, type FeedStatus, type MarketFeed, SimFeed } from './market';
import { mulberry32, uid } from './rng';
import type { AgentId, Broker, Candle, LogEntry, Position, Signal, Trade } from './types';

export type FeedMode = 'binance' | 'sim';
export type Stage = 'idle' | 'read' | 'gate' | 'veto' | 'execute' | 'hold';

export interface Settings {
  feed: FeedMode;
  simBarMs: number;
  startBalance: number;
  symbols: string[];
  sentry: SentryConfig;
  hawk: HawkConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  feed: 'binance',
  simBarMs: 1500,
  startBalance: 1000,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
  sentry: DEFAULT_SENTRY,
  hawk: DEFAULT_HAWK,
};

export interface SymbolState {
  symbol: string;
  candles: Candle[]; // closed bars
  forming: Candle | null;
  stage: Stage;
  lastSignal: Signal | null;
  evolver: EvolverState;
}

export interface AgentStatus {
  busy: boolean;
  text: string;
  at: number;
}

export interface GateView {
  symbol: string;
  signal: Signal;
  verdict: Verdict;
  at: number;
}

const HISTORY_KEEP = 800;
const EVOLVE_WINDOW = 600;

export class Engine {
  settings: Settings;
  balance = 0;
  startBalance = 0;
  positions: Position[] = [];
  trades: Trade[] = []; // newest first
  log: LogEntry[] = []; // newest first
  equity: { t: number; v: number }[] = [];
  symbols = new Map<string, SymbolState>();
  agents: Record<AgentId, AgentStatus>;
  lastGate: GateView | null = null;
  feedStatus: FeedStatus = 'connecting';
  feedDetail = '';
  feedName = '';
  running = false;
  startedAt = 0;
  dayKey = '';
  dayStartEquity = 0;
  dayPnl = 0;
  vetoes = 0;

  private feed: MarketFeed | null = null;
  private broker: Broker = new PaperBroker();
  private rand = mulberry32(Date.now() % 1e9);
  private forgeTimer: ReturnType<typeof setTimeout> | null = null;
  private forgeCursor = 0;
  private listeners = new Set<() => void>();

  constructor(settings: Settings = loadSettings()) {
    this.settings = settings;
    const idle = (text: string): AgentStatus => ({ busy: false, text, at: 0 });
    this.agents = {
      SCOUT: idle('waiting for data'),
      SENTRY: idle('standing guard'),
      HAWK: idle('no position'),
      FORGE: idle('idle'),
    };
    this.resetBook();
    this.restore();
  }

  // ------------------------------------------------------------ lifecycle

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.symbols.clear();
    for (const s of this.settings.symbols) {
      this.symbols.set(s, {
        symbol: s,
        candles: [],
        forming: null,
        stage: 'idle',
        lastSignal: null,
        evolver: newEvolver(this.rand, DEFAULT_EVOLVER),
      });
    }
    this.seedChampions();
    this.say('SCOUT', 'info', `session start · ${this.settings.symbols.length} markets · ${this.settings.feed === 'sim' ? 'simulator' : 'live data'}`);

    const handlers = {
      onHistory: (s: string, c: Candle[]) => this.onHistory(s, c),
      onCandle: (s: string, c: Candle, closed: boolean) => void this.onCandle(s, c, closed),
      onStatus: (st: FeedStatus, d: string) => {
        this.feedStatus = st;
        this.feedDetail = d;
        this.emit();
      },
    };

    this.feed = this.settings.feed === 'sim' ? new SimFeed(this.settings.simBarMs) : new BinanceFeed();
    this.feedName = this.feed.name;
    try {
      await this.feed.start(this.settings.symbols, handlers);
    } catch (err) {
      this.say('SCOUT', 'warn', `Binance unreachable (${(err as Error).message}) — switching to simulator`);
      this.feed.stop();
      this.feed = new SimFeed(this.settings.simBarMs);
      this.feedName = this.feed.name;
      await this.feed.start(this.settings.symbols, handlers);
    }
    this.scheduleForge(50);
    this.emit();
  }

  stop() {
    this.running = false;
    this.feed?.stop();
    this.feed = null;
    if (this.forgeTimer) clearTimeout(this.forgeTimer);
    this.forgeTimer = null;
    this.save();
    this.emit();
  }

  /** Wipe the paper book (balance, positions, trades, log) and keep settings. */
  reset() {
    const wasRunning = this.running;
    this.stop();
    this.resetBook();
    this.save();
    if (wasRunning) void this.start();
    this.emit();
  }

  updateSettings(patch: Partial<Settings>) {
    const feedChanged = patch.feed !== undefined && patch.feed !== this.settings.feed;
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    if (feedChanged || patch.simBarMs !== undefined || patch.symbols !== undefined) {
      const wasRunning = this.running;
      this.stop();
      if (feedChanged) {
        this.resetBook();
        this.restore();
      }
      if (wasRunning) void this.start();
    }
    this.emit();
  }

  private resetBook() {
    this.startBalance = this.settings.startBalance;
    this.balance = this.settings.startBalance;
    this.positions = [];
    this.trades = [];
    this.log = [];
    this.equity = [{ t: Date.now(), v: this.balance }];
    this.dayKey = '';
    this.vetoes = 0;
    this.lastGate = null;
    this.rollDay();
  }

  // ------------------------------------------------------------ derived numbers

  price(symbol: string): number {
    const s = this.symbols.get(symbol);
    return s?.forming?.c ?? s?.candles[s.candles.length - 1]?.c ?? 0;
  }

  openPnl(): number {
    return this.positions.reduce((sum, p) => sum + unrealized(p, this.price(p.symbol) || p.entry), 0);
  }

  totalEquity(): number {
    return this.balance + this.openPnl();
  }

  winRate(): number {
    if (!this.trades.length) return 0;
    return this.trades.filter((t) => t.pnl > 0).length / this.trades.length;
  }

  forgeTotals() {
    let gen = 0;
    let tested = 0;
    let killed = 0;
    let live = 0;
    for (const s of this.symbols.values()) {
      gen = Math.max(gen, s.evolver.generation);
      tested += s.evolver.tested;
      killed += s.evolver.killed;
      if (s.evolver.champion) live++;
    }
    return { gen, tested, killed, live, killRate: tested ? killed / tested : 0 };
  }

  // ------------------------------------------------------------ market events

  private onHistory(symbol: string, candles: Candle[]) {
    const s = this.symbols.get(symbol);
    if (!s) return;
    s.candles = candles.slice(-HISTORY_KEEP);
    this.agents.SCOUT = { busy: true, text: `loaded ${candles.length} bars ${symbol}`, at: Date.now() };
    this.emit();
  }

  private async onCandle(symbol: string, candle: Candle, closed: boolean) {
    const s = this.symbols.get(symbol);
    if (!s || !this.running) return;
    s.forming = closed ? null : candle;

    // HAWK watches every tick for stops/targets using the latest traded price.
    const pos = this.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const tick: Candle = { ...candle, h: candle.c, l: candle.c };
      const exit = manage(pos, tick);
      if (exit) await this.close(pos, exit.price, exit.reason);
    }

    if (closed) {
      const last = s.candles[s.candles.length - 1];
      if (last && last.t === candle.t) s.candles[s.candles.length - 1] = candle;
      else s.candles.push(candle);
      if (s.candles.length > HISTORY_KEEP) s.candles.splice(0, s.candles.length - HISTORY_KEEP);
      await this.onBarClose(s);
      if (symbol === this.settings.symbols[0]) this.markEquity();
    }
    this.emit();
  }

  private async onBarClose(s: SymbolState) {
    this.rollDay();
    const champion = s.evolver.champion;
    s.stage = 'read';
    this.agents.SCOUT = { busy: true, text: `reading ${s.symbol}`, at: Date.now() };

    const cand = scout(s.symbol, s.candles, champion);
    s.lastSignal = cand?.signal ?? null;
    if (!cand) {
      s.stage = this.positions.some((p) => p.symbol === s.symbol) ? 'hold' : champion ? 'idle' : 'veto';
      return;
    }
    this.say('SCOUT', 'info', `${s.symbol} ${cand.signal.dir === 1 ? 'LONG' : 'SHORT'} setup · ${cand.signal.reason}`);

    s.stage = 'gate';
    const verdict = sentry(cand, {
      positions: this.positions,
      recentTrades: this.trades,
      dayStartEquity: this.dayStartEquity,
      dayPnl: this.dayPnl,
      now: Date.now(),
      barMs: this.feedName === 'Simulator' ? this.settings.simBarMs : 60_000,
    }, this.settings.sentry);
    this.lastGate = { symbol: s.symbol, signal: cand.signal, verdict, at: Date.now() };
    const passed = verdict.checks.filter((c) => c.pass).length;
    this.agents.SENTRY = { busy: true, text: `${s.symbol} ${passed}/3 checks`, at: Date.now() };

    if (!verdict.pass) {
      s.stage = 'veto';
      this.vetoes++;
      const why = verdict.blockedBy ?? verdict.checks.filter((c) => !c.pass).map((c) => `${c.name.toLowerCase()} (${c.detail})`).join(', ');
      this.say('SENTRY', 'veto', `✕ ${s.symbol} blocked — ${why}`);
      return;
    }
    this.say('SENTRY', 'pass', `✓ ${s.symbol} 3/3 checks`);
    s.stage = 'execute';
    await this.open(cand);
  }

  // ------------------------------------------------------------ execution

  private async open(c: Candidate) {
    const order = plan(c, this.totalEquity(), this.settings.hawk);
    if (!order) {
      this.say('HAWK', 'info', `${c.symbol} pass — Kelly says no edge to size`);
      return;
    }
    const side = order.position.dir === 1 ? 'buy' : 'sell';
    const fill = await this.broker.market(c.symbol, side, order.position.qty, c.price);
    const entry = fill.price;
    const p: Position = {
      ...order.position,
      entry,
      stop: entry - order.position.dir * order.stopDist,
      take: entry + order.position.dir * order.takeDist,
      best: entry,
    };
    this.balance -= fill.fee;
    this.dayPnl -= fill.fee;
    this.positions.push(p);
    const sym = this.symbols.get(c.symbol);
    if (sym) sym.stage = 'hold';
    this.agents.HAWK = { busy: true, text: `${p.dir === 1 ? 'long' : 'short'} ${c.symbol}`, at: Date.now() };
    this.say(
      'HAWK',
      'entry',
      `ENTRY ${c.symbol} ${p.dir === 1 ? 'LONG' : 'SHORT'} ${fmtQty(p.qty)} @ ${fmtPrice(entry)} · risk ${(order.riskFraction * 100).toFixed(2)}% of bank`,
    );
    this.save();
  }

  private async close(p: Position, price: number, reason: string) {
    const side = p.dir === 1 ? 'sell' : 'buy';
    const fill = await this.broker.market(p.symbol, side, p.qty, price);
    const gross = (fill.price - p.entry) * p.qty * p.dir;
    const entryFee = p.entry * p.qty * 0.0004;
    const pnl = gross - fill.fee;
    this.balance += pnl;
    this.dayPnl += pnl;
    this.positions = this.positions.filter((x) => x.id !== p.id);
    const trade: Trade = {
      id: uid('t'),
      symbol: p.symbol,
      dir: p.dir,
      qty: p.qty,
      entry: p.entry,
      exit: fill.price,
      pnl: pnl - entryFee, // report round-trip result; entry fee was already charged at open
      fees: fill.fee + entryFee,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      reason,
    };
    this.trades.unshift(trade);
    this.trades.length = Math.min(this.trades.length, 300);
    const sym = this.symbols.get(p.symbol);
    if (sym) sym.stage = 'idle';
    this.agents.HAWK = { busy: this.positions.length > 0, text: `${reason} ${p.symbol}`, at: Date.now() };
    this.say('HAWK', 'exit', `EXIT ${p.symbol} ${reason} @ ${fmtPrice(fill.price)}`, trade.pnl);
    this.markEquity();
    this.save();
  }

  /** Manual flatten from the UI. */
  async closeAll() {
    for (const p of [...this.positions]) await this.close(p, this.price(p.symbol) || p.entry, 'manual close');
    this.emit();
  }

  // ------------------------------------------------------------ FORGE (evolution)

  private scheduleForge(ms: number) {
    if (!this.running) return;
    this.forgeTimer = setTimeout(() => this.forgeTick(), ms);
  }

  private forgeTick() {
    if (!this.running) return;
    const list = [...this.symbols.values()].filter((s) => s.candles.length >= 300);
    if (list.length) {
      const s = list[this.forgeCursor++ % list.length];
      const before = s.evolver.champion?.genome.id;
      const t0 = performance.now();
      this.agents.FORGE = { busy: true, text: `gen ${s.evolver.generation + 1} · ${s.symbol}`, at: Date.now() };
      s.evolver = step(s.evolver, s.candles.slice(-EVOLVE_WINDOW), this.rand, DEFAULT_EVOLVER);
      const ms = performance.now() - t0;
      const champ = s.evolver.champion;
      if (champ && champ.genome.id !== before) {
        this.say(
          'FORGE',
          'evolve',
          `${s.symbol} new champion ${champ.genome.regime} · OOS ${(champ.test.totalReturn * 100).toFixed(2)}% · ${champ.test.trades.length} trades`,
        );
      } else if (!champ && before) {
        this.say('FORGE', 'warn', `${s.symbol} champion failed re-validation — retired, symbol benched`);
      }
      this.saveChampions();
      // Warm-up phase evolves fast; afterwards FORGE idles between generations to save battery.
      const warm = s.evolver.generation < 10;
      this.scheduleForge(warm ? Math.max(30, ms) : 2500);
      this.emit();
      return;
    }
    this.scheduleForge(500);
  }

  // ------------------------------------------------------------ bookkeeping

  private say(agent: AgentId, kind: LogEntry['kind'], text: string, pnl?: number) {
    this.log.unshift({ t: Date.now(), agent, kind, text, pnl });
    this.log.length = Math.min(this.log.length, 250);
  }

  private markEquity() {
    this.equity.push({ t: Date.now(), v: this.totalEquity() });
    if (this.equity.length > 600) this.equity.splice(0, this.equity.length - 600);
  }

  private rollDay() {
    const key = new Date().toDateString();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayStartEquity = this.totalEquity();
      this.dayPnl = 0;
    }
  }

  private storeKey(): string {
    return `swarmdesk:book:${this.settings.feed}`;
  }

  save() {
    // The simulator is a sandbox with synthetic prices; its book is not worth resuming.
    if (this.settings.feed === 'sim') return;
    store(this.storeKey(), {
      balance: this.balance,
      startBalance: this.startBalance,
      positions: this.positions,
      trades: this.trades.slice(0, 200),
      log: this.log.slice(0, 120),
      equity: this.equity.slice(-400),
      dayKey: this.dayKey,
      dayStartEquity: this.dayStartEquity,
      dayPnl: this.dayPnl,
    });
  }

  private restore() {
    if (this.settings.feed === 'sim') return;
    const d = load<Partial<Engine>>(this.storeKey());
    if (!d || typeof d.balance !== 'number') return;
    Object.assign(this, {
      balance: d.balance,
      startBalance: d.startBalance ?? this.startBalance,
      positions: d.positions ?? [],
      trades: d.trades ?? [],
      log: d.log ?? [],
      equity: d.equity?.length ? d.equity : this.equity,
      dayKey: d.dayKey ?? '',
      dayStartEquity: d.dayStartEquity ?? this.balance,
      dayPnl: d.dayPnl ?? 0,
    });
  }

  private saveChampions() {
    const champs: Record<string, Scored> = {};
    for (const s of this.symbols.values()) if (s.evolver.champion) champs[s.symbol] = s.evolver.champion;
    store(`swarmdesk:champions:${this.settings.feed}`, champs);
  }

  /** Resume with last session's champions in the gene pool (they must re-pass the gate). */
  private seedChampions() {
    if (this.settings.feed === 'sim') return;
    const champs = load<Record<string, Scored>>(`swarmdesk:champions:${this.settings.feed}`);
    if (!champs) return;
    for (const [sym, c] of Object.entries(champs)) {
      const s = this.symbols.get(sym);
      if (s && c?.genome) s.evolver.population[0] = c.genome;
    }
  }
}

// ------------------------------------------------------------ storage helpers

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — run without persistence */
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

export function loadSettings(): Settings {
  const s = load<Partial<Settings>>('swarmdesk:settings');
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    sentry: { ...DEFAULT_SENTRY, ...s?.sentry },
    hawk: { ...DEFAULT_HAWK, ...s?.hawk },
  };
}

export function saveSettings(s: Settings) {
  store('swarmdesk:settings', s);
}

export function fmtPrice(x: number): string {
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (x >= 1) return x.toFixed(3);
  return x.toPrecision(4);
}

function fmtQty(x: number): string {
  return x >= 1 ? x.toFixed(3) : x.toPrecision(3);
}
