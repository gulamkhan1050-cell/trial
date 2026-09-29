import type { GridGenome } from '../core/grid';
import type { LogEntry } from '../core/types';
import { BinanceError } from './binance';
import { BOT_TAG, type ExchangeClient, type ExOrder, roundDown, roundTo, type SymbolRules } from './types';

/**
 * LIVE GRID — runs FORGE's grid designs as real resting orders on an exchange.
 *
 * The exchange is the source of truth: a level only flips from buy to take-profit when the
 * exchange reports the buy filled, and profit is only booked when the take-profit fills.
 * Every order is post-only (maker fee). Budget, leverage and coin count are capped; each
 * coin uses isolated margin, so the most a coin can lose is its own slice.
 */

export interface LiveCandidate {
  symbol: string;
  genome: GridGenome;
  score: number; // FORGE's out-of-sample profit — higher is better
}

export interface LiveHost {
  /** Coins with a FORGE champion that SENTRY currently allows, best first. */
  candidates(): LiveCandidate[];
  /** Crash guard active: flatten and don't arm. */
  stressed(): boolean;
  log(kind: LogEntry['kind'], text: string, pnl?: number): void;
}

export interface LiveConfig {
  maxCapital: number; // USDT the bot may use, whatever the wallet holds
  leverage: number;
  maxCoins: number;
  dailyLossLimit: number; // fraction of starting wallet; breach = kill switch
  makerFee: number;
  cooldownMs: number; // after a coin is stopped out
  /** Reinvest: budget = starting budget + profit so far (losses shrink it the same way). */
  compound: boolean;
}

export const DEFAULT_LIVE: LiveConfig = { maxCapital: 100, leverage: 3, maxCoins: 5, dailyLossLimit: 0.1, makerFee: 0.0002, cooldownMs: 30 * 60_000, compound: false };

interface Level {
  lvl: number;
  basePrice: number; // the buy price this level returns to
  baseQty: number;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  buyPrice?: number;
  orderId?: number;
  fails: number;
  lastFail?: number;
}

export interface LiveCoin {
  symbol: string;
  genome: GridGenome;
  rules: SymbolRules;
  center: number;
  levels: Level[];
  stopPrice: number;
  stop?: { id: number; algo: boolean };
  lastTrail: number;
}

/** Everything needed to pick a running grid back up after the app or phone restarts. */
export interface LiveSnapshot {
  v: 1;
  savedAt: number;
  startWallet: number;
  roundTrips: number;
  realized: number;
  since?: number;
  baseBudget?: number;
  coins: LiveCoin[];
  cooldown: [string, number][];
}

/** Retiring a flat coin waits this long after (re)start, so FORGE can re-judge its grids first. */
const RETIRE_GRACE_MS = 10 * 60_000;

export class LiveGrid {
  coins = new Map<string, LiveCoin>();
  running = false;
  killed = false;
  budget = 0;
  /** The budget at start, before any profit is reinvested. */
  baseBudget = 0;
  startWallet = 0;
  wallet = 0;
  available = 0;
  roundTrips = 0;
  realized = 0; // booked from our own fills (the wallet is the final truth)
  /** Profit/loss of the coins held right now (Binance's mark price); wallet change + this = true result. */
  unrealized = 0;
  /** When this run began (kept across resumes), for a per-day rate. */
  since = 0;
  lastError = '';
  /** How many coins were picked back up from a saved snapshot at start. */
  resumed = 0;
  private startedAt = 0;
  private reconcilePending = false;
  private busy = false;
  private cooldown = new Map<string, number>();
  private lastBalance = 0;
  private rules: Record<string, SymbolRules> = {};
  private setupDone = new Set<string>();
  /** Symbols with orders this bot didn't place — left alone entirely. */
  private foreign = new Set<string>();
  /** Latest prices from the exchange itself (grid levels must sit on the venue's own book). */
  private px: Record<string, number> = {};

  constructor(
    readonly ex: ExchangeClient,
    private host: LiveHost,
    readonly cfg: LiveConfig,
    private universe: string[],
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * `resume` continues an earlier session: its coins, resting orders and positions are kept (not
   * sold), and its stats carry on. Without it, anything the bot left behind is cleaned up.
   */
  async start(resume?: LiveSnapshot | null) {
    const b = await this.ex.balance();
    this.startWallet = b.wallet;
    this.wallet = b.wallet;
    this.available = b.available;
    // A resumed session already has margin tied up in its own orders and positions.
    this.budget = Math.min(this.cfg.maxCapital, resume?.coins.length ? b.wallet : b.available);
    if (this.budget < 10) throw new Error(`only $${b.available.toFixed(2)} available in the futures wallet`);
    this.baseBudget = resume?.baseBudget ?? this.budget;
    this.rules = await this.ex.rules(this.universe);
    if (resume) this.restore(resume);
    await this.ex.ensureOneWay().catch(async (e) => {
      // Our own leftovers can block the switch: clean them first, then retry once.
      await this.cleanLeftovers();
      await this.ex.ensureOneWay().catch(() => {
        throw e;
      });
    });
    await this.cleanLeftovers();
    this.running = true;
    this.killed = false;
    this.lastBalance = this.now();
    this.startedAt = this.now();
    this.since ||= this.now();
    this.host.log('info', `LIVE ${this.ex.name}: wallet $${b.wallet.toFixed(2)} · budget $${this.budget.toFixed(2)} · ${this.cfg.leverage}× · up to ${this.cfg.maxCoins} coins`);
    if (this.resumed) this.host.log('info', `LIVE resumed ${this.resumed} coin(s) from the last session — their orders and positions were kept`);
  }

  /** Count from zero from now on (orders and positions are untouched): total, per-day, round trips, loss limit. */
  resetStats() {
    this.startWallet = this.wallet + this.unrealized;
    this.baseBudget = this.budget;
    this.roundTrips = 0;
    this.realized = 0;
    this.since = this.now();
    this.host.log('info', `LIVE count reset to zero · equity $${this.startWallet.toFixed(2)}`);
  }

  snapshot(): LiveSnapshot {
    return {
      v: 1,
      savedAt: this.now(),
      startWallet: this.startWallet,
      roundTrips: this.roundTrips,
      realized: this.realized,
      since: this.since,
      baseBudget: this.baseBudget,
      coins: [...this.coins.values()],
      cooldown: [...this.cooldown],
    };
  }

  private restore(s: LiveSnapshot) {
    if (s.v !== 1) return;
    this.startWallet = s.startWallet || this.startWallet;
    this.roundTrips = s.roundTrips ?? 0;
    this.realized = s.realized ?? 0;
    this.since = s.since ?? s.savedAt ?? 0;
    this.cooldown = new Map(s.cooldown ?? []);
    for (const c of s.coins ?? []) {
      if (!this.rules[c.symbol] || !c.levels?.length) continue;
      this.coins.set(c.symbol, { ...c, rules: this.rules[c.symbol], levels: c.levels.map((l) => ({ ...l })) });
      this.setupDone.add(c.symbol);
    }
    this.resumed = this.coins.size;
    this.reconcilePending = this.resumed > 0;
  }

  /**
   * After a resume, check each coin against its real position: if the exchange-side stop fired
   * (or someone closed it) while the app was off, the take-profits have nothing left to sell.
   */
  private async reconcile() {
    for (const c of [...this.coins.values()]) {
      const held = inventory(c);
      if (held <= 0) continue;
      let pos = await this.ex.position(c.symbol);
      if (pos.qty < held * 0.5) {
        // A take-profit may simply have filled since the sync: re-check the orders before judging.
        await this.sync(c, new Set((await this.ex.openOrders(c.symbol)).map((o) => o.orderId)));
        pos = await this.ex.position(c.symbol);
      }
      if (pos.qty < inventory(c) * 0.5) {
        this.host.log('warn', `LIVE ${c.symbol}: position was closed while the app was off — re-arming it fresh`);
        await this.flatten(c, 'closed while offline (flat)');
      }
    }
  }

  /**
   * Orders tagged by this bot but not tracked by this session (app restarted, Start pressed twice) are
   * cancelled and their positions closed; symbols with orders someone else placed are skipped.
   */
  private async cleanLeftovers() {
    const open = await this.ex.openOrders();
    const ours = new Set(open.filter((o) => o.clientOrderId?.startsWith(BOT_TAG) && !this.coins.has(o.symbol)).map((o) => o.symbol));
    for (const sym of ours) {
      await this.ex.cancelAll(sym);
      await this.ex.marketClose(sym);
      this.host.log('info', `LIVE ${sym}: cleaned up orders left by an earlier session`);
    }
    for (const o of open) {
      if (o.clientOrderId?.startsWith(BOT_TAG) || this.foreign.has(o.symbol)) continue;
      this.foreign.add(o.symbol);
      this.host.log('warn', `LIVE ${o.symbol}: has orders you placed yourself — the bot won't trade it`);
    }
  }

  /** Per-coin notional (margin × leverage). */
  slice(): number {
    return (this.budget * this.cfg.leverage) / this.cfg.maxCoins;
  }

  /** How many grid levels a coin can afford given its exchange minimum order size. */
  levelsFor(symbol: string, genome: GridGenome): number {
    const r = this.rules[symbol];
    if (!r) return 0;
    return Math.min(genome.levels, Math.floor(this.slice() / (r.minNotional * 1.15)));
  }

  /** One sync round: reconcile orders, handle fills, manage risk, arm new coins. Safe to call on a timer. */
  async tick() {
    if (!this.running || this.killed || this.busy) return;
    this.busy = true;
    try {
      if (this.now() - this.lastBalance > 30_000) {
        const b = await this.ex.balance();
        this.wallet = b.wallet;
        this.available = b.available;
        this.lastBalance = this.now();
        let open = 0;
        for (const c of this.coins.values()) if (inventory(c) > 0) open += (await this.ex.position(c.symbol)).unrealized;
        this.unrealized = open;
        if (this.cfg.compound) {
          // New ladders are sized from the grown (or shrunk) budget; running ones keep their size.
          const equity = this.wallet + open;
          this.budget = Math.max(10, Math.min(this.baseBudget + (equity - this.startWallet), equity));
        }
        // Judge the loss limit on equity (wallet + held coins), so a deep dip counts before it is sold.
        if (this.wallet + open < this.startWallet * (1 - this.cfg.dailyLossLimit)) {
          this.busy = false;
          await this.kill(`loss limit: equity $${(this.wallet + open).toFixed(2)} vs start $${this.startWallet.toFixed(2)}`);
          return;
        }
      }
      this.px = await this.ex.prices();
      // One cheap per-coin query each instead of the all-symbols one, so the loop can run every ~1.5 s.
      const lists = await Promise.all([...this.coins.keys()].map((sym) => this.ex.openOrders(sym)));
      const open = new Set(lists.flat().map((o) => o.orderId));
      for (const c of this.coins.values()) await this.sync(c, open);
      if (this.reconcilePending) {
        await this.reconcile();
        this.reconcilePending = false;
      }

      const stressed = this.host.stressed();
      const candidates = this.host.candidates();
      for (const c of [...this.coins.values()]) {
        const px = this.px[c.symbol];
        if (!px) continue;
        const holding = inventory(c) > 0;
        if (stressed) {
          await this.flatten(c, holding ? 'crash guard' : 'crash guard (flat)');
          continue;
        }
        if (holding && px <= c.stopPrice) {
          await this.flatten(c, `stop ${c.stopPrice}`);
          this.cooldown.set(c.symbol, this.now() + this.cfg.cooldownMs);
          continue;
        }
        const champ = candidates.find((x) => x.symbol === c.symbol);
        if (!holding && !champ && this.now() - this.startedAt > RETIRE_GRACE_MS) {
          await this.flatten(c, 'FORGE retired its grid (flat)');
          continue;
        }
        // Trail the ladder up when flat and price has left it behind (at most every 20 s).
        if (!holding && px > c.center * (1 + c.genome.spacing) && this.now() - c.lastTrail > 20_000) {
          await this.ex.cancelAll(c.symbol);
          this.lay(c, champ?.genome ?? c.genome, px);
          c.lastTrail = this.now();
        }
      }

      if (!stressed) await this.allocate(candidates);
      for (const c of this.coins.values()) await this.place(c);
      for (const c of this.coins.values()) await this.protect(c);
      this.lastError = '';
    } catch (e) {
      this.lastError = (e as Error).message;
      this.host.log('warn', `LIVE error: ${this.lastError}`);
    } finally {
      this.busy = false;
    }
  }

  private async allocate(candidates: LiveCandidate[]) {
    for (const cand of candidates) {
      if (this.coins.size >= this.cfg.maxCoins) break;
      if (this.coins.has(cand.symbol) || this.foreign.has(cand.symbol)) continue;
      if ((this.cooldown.get(cand.symbol) ?? 0) > this.now()) continue;
      if (this.levelsFor(cand.symbol, cand.genome) < 1) continue; // exchange minimum too big for our slice
      const px = this.px[cand.symbol];
      if (!px) continue;
      if (!this.setupDone.has(cand.symbol)) {
        try {
          await this.ex.setup(cand.symbol, this.cfg.leverage);
          this.setupDone.add(cand.symbol);
        } catch (e) {
          // One coin failing setup must not stall the rest: skip it for a while.
          this.cooldown.set(cand.symbol, this.now() + this.cfg.cooldownMs);
          this.host.log('warn', `LIVE ${cand.symbol}: setup failed (${(e as Error).message}) — skipping it for 30 min`);
          continue;
        }
      }
      const c: LiveCoin = { symbol: cand.symbol, genome: cand.genome, rules: this.rules[cand.symbol], center: px, levels: [], stopPrice: 0, lastTrail: this.now() };
      this.lay(c, cand.genome, px);
      if (!c.levels.length) continue;
      this.coins.set(c.symbol, c);
      this.host.log(
        'pass',
        `✓ LIVE ${c.symbol}: ${c.levels.length} buys every ${(c.genome.spacing * 100).toFixed(2)}% under ${px} · $${this.slice().toFixed(0)} at ${this.cfg.leverage}×`,
      );
    }
  }

  /** Build the buy ladder under `px` (orders are placed by place()). */
  private lay(c: LiveCoin, genome: GridGenome, px: number) {
    const r = c.rules;
    c.genome = genome;
    c.center = px;
    const n = Math.max(1, this.levelsFor(c.symbol, genome));
    const perLevel = this.slice() / n;
    c.levels = [];
    for (let k = 1; k <= n; k++) {
      const price = roundTo(px * (1 - k * genome.spacing), r.tickSize);
      let qty = roundDown(perLevel / price, r.stepSize);
      if (qty * price < r.minNotional) qty = roundTo(Math.ceil((r.minNotional * 1.01) / price / r.stepSize) * r.stepSize, r.stepSize);
      if (qty < r.minQty || price <= 0) continue;
      c.levels.push({ lvl: k, basePrice: price, baseQty: qty, side: 'buy', price, qty, fails: 0 });
    }
    const lowest = c.levels.length ? c.levels[c.levels.length - 1].basePrice : px;
    c.stopPrice = roundTo(lowest * (1 - genome.stop), r.tickSize);
  }

  /** Reconcile each level's order with the exchange; flip levels on fills. */
  private async sync(c: LiveCoin, open: Set<number>) {
    for (const l of c.levels) {
      if (l.orderId === undefined || open.has(l.orderId)) continue;
      let o: ExOrder;
      try {
        o = await this.ex.order(c.symbol, l.orderId);
      } catch {
        l.orderId = undefined;
        continue;
      }
      if (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED') continue; // raced the snapshot
      const filled = o.executedQty;
      const px = o.avgPrice || o.price;
      l.orderId = undefined;
      if (filled <= 0) continue; // canceled / expired untouched: place() re-places it
      if (l.side === 'buy') {
        l.side = 'sell';
        l.buyPrice = px;
        l.qty = filled;
        l.price = roundTo(px * (1 + c.genome.spacing), c.rules.tickSize);
        this.host.log('entry', `LIVE BUY ${c.symbol} ${filled} @ ${px}`);
      } else {
        const buy = l.buyPrice ?? l.basePrice;
        const pnl = (px - buy) * filled - this.cfg.makerFee * (px + buy) * filled;
        this.realized += pnl;
        this.roundTrips++;
        this.host.log('exit', `LIVE SELL ${c.symbol} ${filled} @ ${px} (bought ${buy})`, pnl);
        if (filled < l.qty - 1e-12) {
          l.qty = roundTo(l.qty - filled, c.rules.stepSize); // rest still to sell
        } else {
          l.side = 'buy';
          l.price = l.basePrice;
          l.qty = l.baseQty;
          l.buyPrice = undefined;
        }
      }
    }
  }

  /** Place any level that has no live order, respecting post-only (never cross the book). */
  private async place(c: LiveCoin) {
    const px = this.px[c.symbol];
    if (!px) return;
    for (const l of c.levels) {
      if (l.orderId !== undefined) continue;
      // After repeated real rejections, back off for 5 minutes — but never give up on a level for good
      // (a take-profit that is never re-placed would leave coins bought and unsold).
      if (l.fails >= 5 && this.now() - (l.lastFail ?? 0) < 5 * 60_000) continue;
      let price = l.price;
      if (l.side === 'buy' && price >= px * (1 - 0.0002)) continue; // market is at/below the level: wait
      if (l.side === 'sell') price = Math.max(price, roundTo(px * 1.0003, c.rules.tickSize)); // TP already passed: sell just above market
      try {
        const o = await this.ex.limitMaker(c.symbol, l.side === 'buy' ? 'BUY' : 'SELL', l.qty, price, l.side === 'sell');
        if (o.status === 'EXPIRED' || o.status === 'REJECTED') continue; // would have crossed; retry next tick
        l.orderId = o.orderId;
        l.fails = 0;
      } catch (e) {
        // -5022: post-only would have crossed because the price moved in the meantime. Normal in a
        // fast market — just try again next tick, don't count it as a failure or log it.
        if (e instanceof BinanceError && e.code === -5022) continue;
        l.fails++;
        l.lastFail = this.now();
        this.host.log('warn', `LIVE ${c.symbol} ${l.side} L${l.lvl} rejected: ${(e as Error).message}`);
      }
    }
  }

  /** Keep an exchange-side stop while holding (protects even if this app stops); best effort. */
  private async protect(c: LiveCoin) {
    const holding = inventory(c) > 0;
    try {
      if (holding && !c.stop) c.stop = await this.ex.stopClose(c.symbol, c.stopPrice);
      if (!holding && c.stop) {
        await this.ex.cancelStop(c.symbol, c.stop);
        c.stop = undefined;
      }
    } catch (e) {
      if (!c.stop) this.host.log('warn', `LIVE ${c.symbol}: exchange-side stop unavailable (${(e as Error).message}) — app-side stop still active`);
    }
  }

  /** Cancel everything for a coin and close its position at market. */
  async flatten(c: LiveCoin, reason: string) {
    const pos = await this.ex.position(c.symbol);
    await this.ex.cancelAll(c.symbol);
    if (c.stop) await this.ex.cancelStop(c.symbol, c.stop).catch(() => undefined);
    if (pos.qty !== 0) {
      await this.ex.marketClose(c.symbol);
      this.host.log('veto', `✕ LIVE ${c.symbol} closed (${reason})`, pos.unrealized);
    } else if (!reason.includes('flat')) this.host.log('info', `LIVE ${c.symbol} stood down (${reason})`);
    this.coins.delete(c.symbol);
  }

  /** Kill switch: flatten every coin and stop trading until restarted. */
  async kill(reason: string) {
    this.killed = true;
    this.running = false;
    // Also sweep any of this bot's orders the session isn't tracking (earlier sessions).
    await this.cleanLeftovers().catch(() => undefined);
    for (const c of [...this.coins.values()]) {
      try {
        await this.flatten(c, reason);
      } catch (e) {
        this.host.log('warn', `LIVE kill ${c.symbol} failed: ${(e as Error).message} — check Binance manually`);
      }
    }
    this.host.log('veto', `■ LIVE trading stopped: ${reason}`);
  }
}

function inventory(c: LiveCoin): number {
  return c.levels.filter((l) => l.side === 'sell').reduce((s, l) => s + l.qty, 0);
}
