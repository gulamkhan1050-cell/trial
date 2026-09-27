import { type Candidate, scout } from '../agents/scout';
import { DEFAULT_SENTRY, type SentryConfig, sentry, type Verdict } from '../agents/sentry';
import { DEFAULT_HAWK, type HawkConfig, manage, plan, unrealized } from '../agents/hawk';
import { PaperBroker } from './broker';
import { DEFAULT_EVOLVER, type EvolverState, newEvolver, type Scored, step } from './evolver';
import { BINANCE_PUBLIC, BinanceFeed, type FeedStatus, type Interval, INTERVALS, type MarketFeed, ReplayFeed, SimFeed } from './market';
import { DEFAULT_GRID_FEES, type GridFill, type GridForge, GridBot, type GridState, gridSafe, newGridForge, stepGridForge } from './grid';

export interface GridSlot {
  symbol: string;
  forge: GridForge;
  bot: GridBot | null;
  roundTrips: number;
  last: number; // last price seen, for walking fills between ticks
  wait: number; // bars of cooldown left after a stop
  orphan: number; // bars since FORGE last had a champion
  trails: number; // ladder moves up since the last heartbeat
  why: string; // SENTRY's reason for not arming, if any
}

function newSlot(symbol: string, rand: () => number): GridSlot {
  return { symbol, forge: newGridForge(rand), bot: null, roundTrips: 0, last: 0, wait: 0, orphan: 0, trails: 0, why: '' };
}
import { mulberry32, uid } from './rng';
import type { AgentId, Broker, Candle, LogEntry, Position, Signal, Trade } from './types';

export type FeedMode = 'binance' | 'replay' | 'sim';

export const FEED_LABEL: Record<FeedMode, string> = { binance: 'live data', replay: 'replay of real history', sim: 'simulator' };
export type Stage = 'idle' | 'read' | 'gate' | 'veto' | 'execute' | 'hold';

export interface Settings {
  feed: FeedMode;
  interval: Interval; // live candle length
  simBarMs: number;
  startBalance: number;
  symbols: string[];
  strategy: 'agents' | 'grid'; // directional agents, or the GRID micro-trading engine
  // A grid runs on every market in `symbols`. crashGuard flattens all grids when most markets dump together.
  grid: {
    maker: number;
    taker: number;
    leverage: number;
    crashGuard: boolean;
    crashDrop: number; // a market counts as dumping if it fell this fraction…
    crashBars: number; // …over this many bars
    crashShare: number; // guard fires when at least this share of markets are dumping
  };
  sentry: SentryConfig;
  hawk: HawkConfig;
}

export const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
export const WIDE_MARKETS = [...MAJORS, 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT', 'SUIUSDT', 'LTCUSDT', 'DOTUSDT', 'NEARUSDT', 'BCHUSDT'];
/** 30 liquid USDT pairs. Any that Binance no longer lists are skipped at download time. */
export const MEGA_MARKETS = [
  ...WIDE_MARKETS,
  'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'FILUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT',
  'AAVEUSDT', 'XLMUSDT', 'HBARUSDT', 'ICPUSDT', 'PEPEUSDT', 'SHIBUSDT', 'WLDUSDT',
];

/** Bumped when defaults change for evidence-based reasons; older saved settings are migrated once. */
const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  feed: 'replay',
  interval: '1m',
  simBarMs: 1500,
  startBalance: 1000,
  // Real 7-day Arena runs: grids on 15 coins made 4-23% (by leverage) where 6 majors made 0-4%.
  symbols: WIDE_MARKETS,
  sentry: DEFAULT_SENTRY,
  hawk: DEFAULT_HAWK,
  strategy: 'grid',
  // Real-week Arena runs: the 3x grid was the best risk/return; a 1%/15-bar guard fired on ordinary
  // volatility and cost money, while the loose 2.5%/30-bar guard cost ~0.4% and trimmed drawdown.
  grid: { ...DEFAULT_GRID_FEES, leverage: 3, crashGuard: true, crashDrop: 0.025, crashBars: 30, crashShare: 0.67 },
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

const HISTORY_KEEP = 1600;
const EVOLVE_WINDOW = 600;
/** Grids need longer samples: round trips are small and noisy, so judge on up to a day of 1m bars. */
const GRID_WINDOW = 1440;
/** Bars the crash guard pauses all grids for after it fires. */
const CRASH_PAUSE = 60;
/** Bars a running grid keeps its genome after FORGE retires it, before standing down. */
const GRID_GRACE = 60;

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
  /** Lifetime counts (the trade list itself is capped). */
  tradeCount = 0;
  winCount = 0;
  /** One grid per market: its own FORGE population, ladder and SENTRY state. */
  grids = new Map<string, GridSlot>();
  private gridBars = 0;
  /** Bars left in a market-wide pause after the crash guard fired. */
  private stressWait = 0;

  private feed: MarketFeed | null = null;
  private clock = 0;
  /** Set by the Arena: FORGE runs only when forgeOnce() is called, not on a timer. */
  manualForge = false;
  private session = 0;
  private broker: Broker = new PaperBroker();
  private rand: () => number;
  private forgeTimer: ReturnType<typeof setTimeout> | null = null;
  private forgeCursor = 0;
  private listeners = new Set<() => void>();

  /** `seed` makes FORGE's random search repeatable (the Arena and tests pass one). */
  constructor(settings: Settings = loadSettings(), seed = Date.now() % 1e9) {
    this.rand = mulberry32(seed);
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

  /** `feedOverride` lets the Arena supply history itself and push bars with ingest(). */
  async start(feedOverride?: MarketFeed) {
    if (this.running) return;
    // Simulated and replayed prices don't continue from one run to the next, so positions
    // carried over would be marked against a different market. Every such run starts a fresh book.
    if (this.settings.feed !== 'binance') this.resetBook();
    this.running = true;
    this.startedAt = Date.now();
    this.clock = 0;
    // Keep restored ladders (live mode) but give every market a fresh FORGE population.
    const kept = this.grids;
    this.grids = new Map();
    for (const sym of this.settings.symbols) {
      this.grids.set(sym, { ...newSlot(sym, this.rand), bot: kept.get(sym)?.bot ?? null, roundTrips: kept.get(sym)?.roundTrips ?? 0 });
    }
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
    this.say('SCOUT', 'info', `session start · ${this.settings.symbols.length} markets · ${FEED_LABEL[this.settings.feed]}`);

    // Events from a feed that belongs to an earlier session (e.g. a download that finished
    // after the user restarted) are dropped, so two feeds can never drive the book at once.
    const session = ++this.session;
    const live = () => session === this.session;
    const handlers = {
      onHistory: (s: string, c: Candle[]) => live() && this.onHistory(s, c),
      onCandle: (s: string, c: Candle, closed: boolean) => void (live() && this.ingest(s, c, closed)),
      onStatus: (st: FeedStatus, d: string) => {
        if (!live()) return;
        this.feedStatus = st;
        this.feedDetail = d;
        this.emit();
      },
    };

    this.feed = feedOverride ??
      (this.settings.feed === 'sim'
        ? new SimFeed(this.settings.simBarMs)
        : this.settings.feed === 'replay'
          ? new ReplayFeed(this.settings.simBarMs)
          : new BinanceFeed({ ...BINANCE_PUBLIC, interval: this.settings.interval }));
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
    if (!live()) return;
    this.scheduleForge(50);
    this.emit();
  }

  stop() {
    this.running = false;
    this.session++;
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
    // Leaving a live book's strategy or markets: flatten at today's real prices first, so no
    // position or grid inventory is left behind unmanaged. (Sim/replay books restart fresh anyway.)
    const reshapes = (patch.strategy !== undefined && patch.strategy !== this.settings.strategy) || patch.symbols !== undefined;
    if (reshapes && this.settings.feed === 'binance' && this.running && this.hasExposure()) {
      void this.closeAll().then(() => this.applySettings(patch));
      return;
    }
    this.applySettings(patch);
  }

  hasExposure(): boolean {
    return this.positions.length > 0 || [...this.grids.values()].some((g) => (g.bot?.inventory().qty ?? 0) > 0);
  }

  private applySettings(patch: Partial<Settings>) {
    const feedChanged = patch.feed !== undefined && patch.feed !== this.settings.feed;
    const intervalChanged = patch.interval !== undefined && patch.interval !== this.settings.interval;
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    if (feedChanged || intervalChanged || patch.simBarMs !== undefined || patch.symbols !== undefined || patch.strategy !== undefined || patch.grid !== undefined) {
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
    this.tradeCount = 0;
    this.winCount = 0;
    this.lastGate = null;
    this.grids = new Map();
    this.stressWait = 0;
    this.rollDay();
  }

  // ------------------------------------------------------------ derived numbers

  /** Wall-clock length of one bar on the running feed. */
  barMs(): number {
    return this.accelerated() ? 60_000 : INTERVALS[this.settings.interval];
  }

  /** Simulator and replay run faster than real time on 1m bars. */
  accelerated(): boolean {
    return this.feedName !== 'Binance';
  }

  /** Market clock: wall time when live, the replayed/simulated bar time otherwise. */
  marketNow(): number {
    return this.accelerated() && this.clock ? this.clock : Date.now();
  }

  /** Label for the candle length the agents are reading. */
  barLabel(): string {
    return this.feedName === 'Simulator' ? '1m (sim)' : this.feedName === 'Replay' ? '1m (replay)' : this.settings.interval;
  }

  price(symbol: string): number {
    const s = this.symbols.get(symbol);
    return s?.forming?.c ?? s?.candles[s.candles.length - 1]?.c ?? 0;
  }

  openPnl(): number {
    let grid = 0;
    for (const g of this.grids.values()) if (g.bot) grid += g.bot.unrealized(this.price(g.symbol) || g.bot.center);
    return grid + this.positions.reduce((sum, p) => sum + unrealized(p, this.price(p.symbol) || p.entry), 0);
  }

  gridMode(): boolean {
    return this.settings.strategy === 'grid';
  }

  /** True while the crash guard's market-wide pause is running. */
  isStressed(): boolean {
    return this.stressWait > 0;
  }

  /** Let an outside component (the live trading controller) write to the decision log. */
  logExternal(kind: LogEntry['kind'], text: string, pnl?: number) {
    this.say('HAWK', kind, text, pnl);
    this.emit();
  }

  /** Ask the UI to refresh. */
  notify() {
    this.emit();
  }

  gridTotals() {
    let roundTrips = 0;
    let armed = 0;
    let holding = 0;
    let inventory = 0;
    for (const g of this.grids.values()) {
      roundTrips += g.roundTrips;
      if (g.bot?.armed) armed++;
      const inv = g.bot?.inventory();
      if (inv && inv.qty > 0) {
        holding++;
        inventory += inv.cost;
      }
    }
    return { roundTrips, armed, holding, inventory, markets: this.grids.size };
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

  /** Apply one candle update (forming tick or closed bar). Feeds call this; the Arena awaits it directly. */
  async ingest(symbol: string, candle: Candle, closed: boolean) {
    const s = this.symbols.get(symbol);
    if (!s || !this.running) return;
    s.forming = closed ? null : candle;
    if (closed) this.clock = Math.max(this.clock, candle.t + 60_000);

    // HAWK watches every tick for stops/targets using the latest traded price.
    const pos = this.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const tick: Candle = { ...candle, h: candle.c, l: candle.c };
      const exit = manage(pos, tick);
      if (exit) await this.close(pos, exit.price, exit.reason);
    }

    const slot = this.gridMode() ? this.grids.get(symbol) : undefined;
    if (slot) this.gridTick(slot, candle.c);

    if (closed) {
      const last = s.candles[s.candles.length - 1];
      if (last && last.t === candle.t) s.candles[s.candles.length - 1] = candle;
      else s.candles.push(candle);
      if (s.candles.length > HISTORY_KEEP) s.candles.splice(0, s.candles.length - HISTORY_KEEP);
      if (slot) this.gridBarClose(slot, s);
      else if (!this.gridMode()) await this.onBarClose(s);
      if (symbol === this.settings.symbols[0]) this.markEquity(2000);
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
      now: this.marketNow(),
      barMs: this.barMs(),
      barMinutes: this.barMs() / 60_000,
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
      openedAt: this.marketNow(),
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
      closedAt: this.marketNow(),
      reason,
    };
    this.trades.unshift(trade);
    this.countTrade(trade.pnl);
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
    for (const g of this.grids.values()) {
      if (!g.bot?.armed) continue;
      if (g.bot.inventory().qty > 0) this.onGridFill(g, g.bot.liquidate(this.price(g.symbol)), 'manual close');
      g.bot.disarm();
      g.wait = 30;
    }
    this.emit();
  }

  // ------------------------------------------------------------ FORGE (evolution)

  private scheduleForge(ms: number) {
    if (!this.running || this.manualForge) return;
    this.forgeTimer = setTimeout(() => this.forgeTick(), ms);
  }

  /** One FORGE generation for the next market in the rotation (used by the Arena). */
  forgeOnce() {
    this.forgeTick();
  }

  private forgeTick() {
    if (!this.running) return;
    if (this.gridMode()) return this.gridForgeTick();
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
      } else if (!champ && s.evolver.generation % 10 === 0) {
        // Say why nothing is trading instead of staying silent.
        const last = s.evolver.history[s.evolver.history.length - 1];
        this.say(
          'FORGE',
          'warn',
          `${s.symbol} gen ${s.evolver.generation}: no strategy beats fees out-of-sample yet (${last?.passedGate ?? 0}/${last?.backtested ?? 0} passed) — benched`,
        );
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

  // ------------------------------------------------------------ GRID (micro-trading)

  private gridTick(g: GridSlot, price: number) {
    const bot = g.bot;
    if (bot?.armed && g.last) {
      const center = bot.center;
      for (const f of bot.move(g.last, price)) this.onGridFill(g, f);
      if (bot.center !== center && bot.armed) g.trails++;
    }
    g.last = price;
  }

  private onGridFill(g: GridSlot, f: GridFill, reason?: string) {
    const sym = g.symbol;
    this.balance += f.cash;
    this.dayPnl += f.cash;
    if (f.kind === 'buy') {
      this.agents.HAWK = { busy: true, text: `grid buy ${short(sym)} @ ${fmtPrice(f.price)}`, at: Date.now() };
      this.say('HAWK', 'entry', `GRID BUY ${sym} ${fmtQty(f.qty)} @ ${fmtPrice(f.price)}`);
      return;
    }
    const rt = f.roundTrip!;
    const now = this.marketNow();
    g.roundTrips++;
    this.countTrade(rt.pnl);
    this.trades.unshift({
      id: uid('t'),
      symbol: sym,
      dir: 1,
      qty: f.qty,
      entry: rt.buy,
      exit: rt.sell,
      pnl: rt.pnl,
      fees: f.fee + rt.buy * f.qty * this.settings.grid.maker,
      openedAt: now,
      closedAt: now,
      reason: reason ?? (f.kind === 'stop' ? 'grid stop' : 'grid take-profit'),
    });
    this.trades.length = Math.min(this.trades.length, 300);
    if (f.kind === 'stop') {
      g.wait = 30;
      this.agents.SENTRY = { busy: true, text: `${short(sym)} grid stopped — cooling down`, at: Date.now() };
      this.say('SENTRY', 'veto', `✕ ${sym} broke below the grid — inventory liquidated, 30-bar cooldown`, rt.pnl);
    } else {
      this.agents.HAWK = { busy: true, text: `grid sell ${short(sym)} ${rt.pnl >= 0 ? '+' : ''}${rt.pnl.toFixed(2)}`, at: Date.now() };
      this.say('HAWK', 'exit', `GRID SELL ${sym} @ ${fmtPrice(rt.sell)} (bought ${fmtPrice(rt.buy)})`, rt.pnl);
    }
    this.markEquity(1000);
  }

  private gridBarClose(g: GridSlot, s: SymbolState) {
    this.rollDay();
    if (s.symbol === this.settings.symbols[0]) {
      this.gridHeartbeat();
      this.crashGuard();
    }
    if (g.wait > 0) g.wait--;
    const champ = g.forge.champion;
    const bot = g.bot;
    const price = s.candles[s.candles.length - 1].c;
    const flat = !bot || bot.inventory().qty === 0;
    this.agents.SCOUT = { busy: true, text: `reading ${short(s.symbol)} range`, at: Date.now() };

    // FORGE retired the strategy: keep working the ladder for a grace period (a retirement is
    // often noise at the pass/fail edge), then stand down once nothing is held.
    g.orphan = champ ? 0 : g.orphan + 1;
    if (bot?.armed && !champ && flat && g.orphan >= GRID_GRACE) {
      bot.disarm();
      this.say('SENTRY', 'veto', `✕ ${s.symbol} grid stood down — no grid has passed out-of-sample for ${GRID_GRACE} bars`);
    }
    // Swap in a better genome only while holding nothing.
    if (bot?.armed && champ && champ.genome.id !== bot.genome.id && flat) {
      bot.genome = champ.genome;
      bot.arm(price, bot.capital);
    }
    if (bot?.armed) {
      s.stage = flat ? 'idle' : 'hold';
      return;
    }

    // Not armed: SENTRY decides whether this market is safe to lay a grid.
    let why = '';
    if (!champ) why = 'no grid survived FORGE yet';
    else if (this.stressWait > 0) why = `crash guard: market-wide sell-off, paused ${this.stressWait} more bars`;
    else if (g.wait > 0) why = `cooldown ${g.wait} bars after stop`;
    else if (this.dayPnl <= -this.settings.sentry.dailyLossLimit * this.dayStartEquity) why = 'daily loss limit hit';
    else if (!gridSafe(s.candles, s.candles.length - 1, champ.genome)) why = 'selling off too hard for a grid';
    g.why = why;
    if (why) {
      s.stage = champ ? 'veto' : 'idle';
      return;
    }
    const genome = champ!.genome;
    // Each market gets an equal slice of the bank, times the grid leverage (perp-style margin).
    const capital = (this.totalEquity() * Math.max(1, this.settings.grid.leverage)) / Math.max(1, this.grids.size);
    g.bot = bot ?? new GridBot(genome, this.gridFees());
    g.bot.genome = genome;
    g.bot.fees = this.gridFees();
    g.bot.arm(price, capital);
    s.stage = 'execute';
    this.agents.SENTRY = { busy: true, text: `${short(s.symbol)} range ok — grid armed`, at: Date.now() };
    this.say(
      'SENTRY',
      'pass',
      `✓ ${s.symbol} grid armed: ${genome.levels} buys every ${(genome.spacing * 100).toFixed(2)}% under ${fmtPrice(price)} · $${capital.toFixed(0)}`,
    );
  }

  /**
   * Grids on correlated coins all get stopped out together in a market-wide dump. When most
   * markets fall more than CRASH_DROP over CRASH_BARS, sell every grid's inventory now (before the
   * deeper per-grid stops) and pause laying ladders for CRASH_PAUSE bars.
   */
  private crashGuard() {
    if (this.stressWait > 0) this.stressWait--;
    if (!this.settings.grid.crashGuard || this.stressWait > 0) return;
    const { crashDrop, crashBars, crashShare } = this.settings.grid;
    let down = 0;
    let n = 0;
    for (const sym of this.grids.keys()) {
      const c = this.symbols.get(sym)?.candles;
      if (!c || c.length <= crashBars) continue;
      n++;
      if (c[c.length - 1].c / c[c.length - 1 - crashBars].c - 1 <= -crashDrop) down++;
    }
    if (n < 2 || down / n < crashShare) return;
    this.stressWait = CRASH_PAUSE;
    let saved = 0;
    for (const g of this.grids.values()) {
      if (!g.bot?.armed) continue;
      if (g.bot.inventory().qty > 0) {
        this.onGridFill(g, g.bot.liquidate(this.price(g.symbol)), 'grid crash guard');
        saved++;
      } else g.bot.disarm();
    }
    this.say(
      'SENTRY',
      'veto',
      `✕ crash guard: ${down}/${n} markets down >${(crashDrop * 100).toFixed(1)}% in ${crashBars} bars — ${saved} grids flattened, all paused ${CRASH_PAUSE} bars`,
    );
  }

  /** One line every 20 bars so a quiet desk still shows it's alive. */
  private gridHeartbeat() {
    if (++this.gridBars % 20 !== 0) return;
    const t = this.gridTotals();
    let trails = 0;
    for (const g of this.grids.values()) {
      trails += g.trails;
      g.trails = 0;
    }
    const benched = [...this.grids.values()].filter((g) => !g.bot?.armed).length;
    this.say(
      'HAWK',
      'info',
      `GRID ${t.armed}/${t.markets} ladders armed · ${t.holding} holding $${t.inventory.toFixed(0)} · ${t.roundTrips} round trips` +
        (benched ? ` · ${benched} waiting` : '') +
        (trails ? ` · trailed up ${trails}× as prices rose` : ''),
    );
  }

  private countTrade(pnl: number) {
    this.tradeCount++;
    if (pnl > 0) this.winCount++;
  }

  gridFees() {
    return { maker: this.settings.grid.maker, taker: this.settings.grid.taker };
  }

  private gridForgeTick() {
    const ready = [...this.grids.values()].filter((g) => (this.symbols.get(g.symbol)?.candles.length ?? 0) >= 300);
    if (!ready.length) return this.scheduleForge(500);
    const g = ready[this.forgeCursor++ % ready.length];
    const candles = this.symbols.get(g.symbol)!.candles;
    const before = g.forge.champion?.genome.id;
    const t0 = performance.now();
    this.agents.FORGE = { busy: true, text: `grid gen ${g.forge.generation + 1} · ${short(g.symbol)}`, at: Date.now() };
    g.forge = stepGridForge(g.forge, candles.slice(-GRID_WINDOW), this.gridFees(), this.rand);
    const f = g.forge;
    const c = f.champion;
    if (c && c.genome.id !== before) {
      this.say(
        'FORGE',
        'evolve',
        `${g.symbol} grid champion: step ${(c.genome.spacing * 100).toFixed(2)}% × ${c.genome.levels} · OOS ${(c.test.profit * 100).toFixed(2)}% · ${c.test.roundTrips} round trips`,
      );
    } else if (!c && before) {
      this.say('FORGE', 'warn', `${g.symbol} grid champion failed re-validation — retired`);
    }
    // Warm every market up quickly; afterwards re-judge each one about every 10s.
    const warming = ready.some((x) => x.forge.generation < 12);
    this.scheduleForge(warming ? Math.max(20, performance.now() - t0) : Math.max(300, 10_000 / ready.length));
    this.emit();
  }

  // ------------------------------------------------------------ bookkeeping

  private say(agent: AgentId, kind: LogEntry['kind'], text: string, pnl?: number) {
    this.log.unshift({ t: Date.now(), agent, kind, text, pnl });
    this.log.length = Math.min(this.log.length, 250);
  }

  /** Record an equity point; `minGapMs` thins out points on very fast (1s) bars so the chart keeps some history. */
  private markEquity(minGapMs = 0) {
    const last = this.equity[this.equity.length - 1];
    if (last && Date.now() - last.t < minGapMs) return;
    this.equity.push({ t: Date.now(), v: this.totalEquity() });
    if (this.equity.length > 600) this.equity.splice(0, this.equity.length - 600);
  }

  private rollDay() {
    // Market clock, so replays and the Arena roll days with the data, not the wall clock.
    const key = new Date(this.marketNow()).toDateString();
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
    if (this.settings.feed !== 'binance') return;
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
      grids: Object.fromEntries([...this.grids.values()].filter((g) => g.bot).map((g) => [g.symbol, { bot: g.bot!.snapshot(), roundTrips: g.roundTrips }])),
    });
  }

  private restore() {
    if (this.settings.feed !== 'binance') return;
    const d = load<Partial<Omit<Engine, 'grids'>> & { grids?: Record<string, { bot: GridState; roundTrips: number }> }>(this.storeKey());
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
    this.grids = new Map(
      Object.entries(d.grids ?? {}).map(([sym, x]) => [sym, { ...newSlot(sym, this.rand), bot: GridBot.restore(x.bot, this.gridFees()), roundTrips: x.roundTrips }]),
    );
  }

  private saveChampions() {
    const champs: Record<string, Scored> = {};
    for (const s of this.symbols.values()) if (s.evolver.champion) champs[s.symbol] = s.evolver.champion;
    store(`swarmdesk:champions:${this.settings.feed}`, champs);
  }

  /** Resume with last session's champions in the gene pool (they must re-pass the gate). */
  private seedChampions() {
    if (this.settings.feed !== 'binance') return;
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
  // Settings saved under older defaults move to the current evidence-based ones once
  // (grid, 15 coins, 3x, loose guard), keeping only the user's own fees.
  const saved = s as (Partial<Settings> & { version?: number }) | null;
  if (saved && (saved.version ?? 1) < SETTINGS_VERSION) {
    saved.strategy = DEFAULT_SETTINGS.strategy;
    saved.symbols = DEFAULT_SETTINGS.symbols;
    saved.grid = { ...DEFAULT_SETTINGS.grid, maker: saved.grid?.maker ?? DEFAULT_SETTINGS.grid.maker, taker: saved.grid?.taker ?? DEFAULT_SETTINGS.grid.taker };
  }
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    grid: { ...DEFAULT_SETTINGS.grid, ...s?.grid },
    sentry: { ...DEFAULT_SENTRY, ...s?.sentry },
    hawk: { ...DEFAULT_HAWK, ...s?.hawk },
  };
}

export function saveSettings(s: Settings) {
  store('swarmdesk:settings', { ...s, version: SETTINGS_VERSION });
}

export function fmtPrice(x: number): string {
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (x >= 1) return x.toFixed(3);
  return x.toPrecision(4);
}

const short = (s: string) => s.replace('USDT', '');

function fmtQty(x: number): string {
  return x >= 1 ? x.toFixed(3) : x.toPrecision(3);
}
