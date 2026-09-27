import { type Candidate, scout } from '../agents/scout';
import { DEFAULT_SENTRY, type SentryConfig, sentry, type Verdict } from '../agents/sentry';
import { DEFAULT_HAWK, type HawkConfig, manage, plan, unrealized } from '../agents/hawk';
import { PaperBroker } from './broker';
import { DEFAULT_EVOLVER, type EvolverState, newEvolver, type Scored, step } from './evolver';
import { BINANCE_PUBLIC, BinanceFeed, type FeedStatus, type Interval, INTERVALS, type MarketFeed, ReplayFeed, SimFeed } from './market';
import { DEFAULT_GRID_FEES, type GridFill, type GridForge, GridBot, type GridState, gridSafe, newGridForge, stepGridForge } from './grid';
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
  grid: { symbol: string; maker: number; taker: number };
  sentry: SentryConfig;
  hawk: HawkConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  feed: 'replay',
  interval: '1m',
  simBarMs: 1500,
  startBalance: 1000,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
  sentry: DEFAULT_SENTRY,
  hawk: DEFAULT_HAWK,
  strategy: 'agents',
  grid: { symbol: 'BTCUSDT', ...DEFAULT_GRID_FEES },
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
  gridForge: GridForge;
  gridBot: GridBot | null = null;
  gridRoundTrips = 0;
  private gridLast = 0;
  private gridWait = 0;
  private gridOrphanBars = 0;
  private gridBars = 0;
  private gridTrails = 0;

  private feed: MarketFeed | null = null;
  private clock = 0;
  private session = 0;
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
    this.gridForge = newGridForge(this.rand);
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
    this.clock = 0;
    this.gridLast = 0;
    this.gridWait = 0;
    this.gridOrphanBars = 0;
    this.gridForge = newGridForge(this.rand);
    if (this.gridMode() && !this.settings.symbols.includes(this.settings.grid.symbol))
      this.settings = { ...this.settings, symbols: [this.settings.grid.symbol, ...this.settings.symbols] };
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
      onCandle: (s: string, c: Candle, closed: boolean) => void (live() && this.onCandle(s, c, closed)),
      onStatus: (st: FeedStatus, d: string) => {
        if (!live()) return;
        this.feedStatus = st;
        this.feedDetail = d;
        this.emit();
      },
    };

    this.feed =
      this.settings.feed === 'sim'
        ? new SimFeed(this.settings.simBarMs)
        : this.settings.feed === 'replay'
          ? new ReplayFeed(this.settings.simBarMs)
          : new BinanceFeed({ ...BINANCE_PUBLIC, interval: this.settings.interval });
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
    this.lastGate = null;
    this.gridBot = null;
    this.gridRoundTrips = 0;
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
    const grid = this.gridBot ? this.gridBot.unrealized(this.price(this.settings.grid.symbol) || this.gridBot.center) : 0;
    return grid + this.positions.reduce((sum, p) => sum + unrealized(p, this.price(p.symbol) || p.entry), 0);
  }

  gridMode(): boolean {
    return this.settings.strategy === 'grid';
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
    if (closed) this.clock = Math.max(this.clock, candle.t + 60_000);

    // HAWK watches every tick for stops/targets using the latest traded price.
    const pos = this.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const tick: Candle = { ...candle, h: candle.c, l: candle.c };
      const exit = manage(pos, tick);
      if (exit) await this.close(pos, exit.price, exit.reason);
    }

    const gridSym = this.gridMode() && symbol === this.settings.grid.symbol;
    if (gridSym) this.gridTick(candle.c);

    if (closed) {
      const last = s.candles[s.candles.length - 1];
      if (last && last.t === candle.t) s.candles[s.candles.length - 1] = candle;
      else s.candles.push(candle);
      if (s.candles.length > HISTORY_KEEP) s.candles.splice(0, s.candles.length - HISTORY_KEEP);
      if (gridSym) this.gridBarClose(s);
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
    if (this.gridBot?.armed) {
      const px = this.price(this.settings.grid.symbol);
      const inv = this.gridBot.inventory();
      if (inv.qty > 0) this.onGridFill(this.gridBot.liquidate(px), 'manual close');
      this.gridBot.disarm();
      this.gridWait = 30;
    }
    this.emit();
  }

  // ------------------------------------------------------------ FORGE (evolution)

  private scheduleForge(ms: number) {
    if (!this.running) return;
    this.forgeTimer = setTimeout(() => this.forgeTick(), ms);
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

  private gridTick(price: number) {
    const bot = this.gridBot;
    if (bot?.armed && this.gridLast) {
      const center = bot.center;
      for (const f of bot.move(this.gridLast, price)) this.onGridFill(f);
      if (bot.center !== center && bot.armed) this.gridTrails++;
    }
    this.gridLast = price;
  }

  private onGridFill(f: GridFill, reason?: string) {
    const sym = this.settings.grid.symbol;
    this.balance += f.cash;
    this.dayPnl += f.cash;
    if (f.kind === 'buy') {
      this.agents.HAWK = { busy: true, text: `grid buy ${short(sym)} @ ${fmtPrice(f.price)}`, at: Date.now() };
      this.say('HAWK', 'entry', `GRID BUY ${sym} ${f.qty.toPrecision(3)} @ ${fmtPrice(f.price)}`);
      return;
    }
    const rt = f.roundTrip!;
    const now = this.marketNow();
    this.gridRoundTrips++;
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
      this.gridWait = 30;
      this.agents.SENTRY = { busy: true, text: `grid stopped — cooling down`, at: Date.now() };
      this.say('SENTRY', 'veto', `✕ ${sym} broke below the grid — inventory liquidated, 30-bar cooldown`, rt.pnl);
    } else {
      this.agents.HAWK = { busy: true, text: `grid sell ${short(sym)} ${rt.pnl >= 0 ? '+' : ''}${rt.pnl.toFixed(2)}`, at: Date.now() };
      this.say('HAWK', 'exit', `GRID SELL ${sym} @ ${fmtPrice(rt.sell)} (bought ${fmtPrice(rt.buy)})`, rt.pnl);
    }
    this.markEquity();
  }

  private gridBarClose(s: SymbolState) {
    this.rollDay();
    s.stage = this.gridBot?.armed ? 'hold' : 'idle';
    this.agents.SCOUT = { busy: true, text: `reading ${short(s.symbol)} range`, at: Date.now() };
    if (this.gridWait > 0) this.gridWait--;
    const champ = this.gridForge.champion;
    const bot = this.gridBot;
    const price = s.candles[s.candles.length - 1].c;
    const flat = !bot || bot.inventory().qty === 0;

    // FORGE retired the strategy: keep working the ladder for a grace period (a retirement is
    // often noise at the pass/fail edge), then stand down once nothing is held.
    this.gridOrphanBars = champ ? 0 : this.gridOrphanBars + 1;
    if (bot?.armed && !champ && flat && this.gridOrphanBars >= GRID_GRACE) {
      bot.disarm();
      this.say('SENTRY', 'veto', `✕ ${s.symbol} grid stood down — no grid has passed out-of-sample for ${GRID_GRACE} bars`);
    }
    // Swap in a better genome only while holding nothing.
    if (bot?.armed && champ && champ.genome.id !== bot.genome.id && flat) {
      bot.genome = champ.genome;
      bot.arm(price, bot.capital);
      this.say('HAWK', 'info', `grid re-laid with new genome · step ${(champ.genome.spacing * 100).toFixed(2)}% × ${champ.genome.levels}`);
    }
    if (bot?.armed) {
      // Heartbeat: while a ladder waits for price to come down to it, say so every 20 bars.
      if (++this.gridBars % 20 === 0) {
        const buys = bot.orders.filter((o) => o.side === 'buy');
        const next = buys.length ? Math.max(...buys.map((o) => o.price)) : 0;
        const held = bot.orders.length - buys.length;
        this.say(
          'HAWK',
          'info',
          `GRID watching ${s.symbol} @ ${fmtPrice(price)} · ${held}/${bot.genome.levels} filled` +
            (next ? ` · next buy ${fmtPrice(next)} (${(((next - price) / price) * 100).toFixed(2)}%)` : '') +
            (this.gridTrails ? ` · trailed up ${this.gridTrails}× as price rose` : ''),
        );
        this.gridTrails = 0;
      }
      const inv = bot.inventory();
      this.agents.HAWK = { busy: true, text: `${bot.orders.filter((o) => o.side === 'sell').length}/${bot.genome.levels} filled`, at: Date.now() };
      if (inv.qty > 0) s.stage = 'hold';
      return;
    }

    // Not armed: SENTRY decides whether the market is safe to lay a grid.
    s.stage = 'gate';
    let why = '';
    if (!champ) why = 'no grid survived FORGE yet';
    else if (this.gridWait > 0) why = `cooldown ${this.gridWait} bars after stop`;
    else if (this.dayPnl <= -this.settings.sentry.dailyLossLimit * this.dayStartEquity) why = 'daily loss limit hit';
    else if (!gridSafe(s.candles, s.candles.length - 1, champ.genome)) why = 'selling off too hard for a grid';
    if (why) {
      s.stage = 'veto';
      this.agents.SENTRY = { busy: true, text: why, at: Date.now() };
      return;
    }
    const g = champ!.genome;
    this.gridBot = bot ?? new GridBot(g, this.gridFees());
    this.gridBot.genome = g;
    this.gridBot.fees = this.gridFees();
    this.gridBot.arm(price, this.totalEquity());
    s.stage = 'execute';
    this.agents.SENTRY = { busy: true, text: 'range ok — grid armed', at: Date.now() };
    this.say(
      'SENTRY',
      'pass',
      `✓ ${s.symbol} range ok — grid armed: ${g.levels} buys every ${(g.spacing * 100).toFixed(2)}% under ${fmtPrice(price)}, stop ${(g.stop * 100).toFixed(1)}% below`,
    );
  }

  gridFees() {
    return { maker: this.settings.grid.maker, taker: this.settings.grid.taker };
  }

  private gridForgeTick() {
    const s = this.symbols.get(this.settings.grid.symbol);
    if (!s || s.candles.length < 300) return this.scheduleForge(500);
    const before = this.gridForge.champion?.genome.id;
    const t0 = performance.now();
    this.agents.FORGE = { busy: true, text: `grid gen ${this.gridForge.generation + 1}`, at: Date.now() };
    this.gridForge = stepGridForge(this.gridForge, s.candles.slice(-GRID_WINDOW), this.gridFees(), this.rand);
    const f = this.gridForge;
    const c = f.champion;
    if (c && c.genome.id !== before) {
      this.say(
        'FORGE',
        'evolve',
        `${s.symbol} grid champion: step ${(c.genome.spacing * 100).toFixed(2)}% × ${c.genome.levels} · OOS ${(c.test.profit * 100).toFixed(2)}% · ${c.test.roundTrips} round trips`,
      );
    } else if (!c && before) {
      this.say('FORGE', 'warn', `${s.symbol} grid champion failed re-validation — retired`);
    } else if (!c && f.generation % 10 === 0) {
      this.say('FORGE', 'warn', `${s.symbol} grid gen ${f.generation}: no grid beats fees out-of-sample yet — waiting`);
    }
    // After warm-up, re-judge every ~10s: often enough to adapt, slow enough not to churn on noise.
    this.scheduleForge(f.generation < 12 ? Math.max(30, performance.now() - t0) : 10_000);
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
      grid: this.gridBot?.snapshot() ?? null,
      gridRoundTrips: this.gridRoundTrips,
    });
  }

  private restore() {
    if (this.settings.feed !== 'binance') return;
    const d = load<Partial<Engine> & { grid?: GridState | null }>(this.storeKey());
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
      gridRoundTrips: d.gridRoundTrips ?? 0,
      gridBot: d.grid ? GridBot.restore(d.grid, this.gridFees()) : null,
    });
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
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    grid: { ...DEFAULT_SETTINGS.grid, ...s?.grid },
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

const short = (s: string) => s.replace('USDT', '');

function fmtQty(x: number): string {
  return x >= 1 ? x.toFixed(3) : x.toPrecision(3);
}
