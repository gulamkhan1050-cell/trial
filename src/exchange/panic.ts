import type { LogEntry } from '../core/types';
import { type ExchangeClient, roundDown, roundTo, type SymbolRules } from './types';

/**
 * PANIC BUY — the second strategy next to the grid, on its own coins (Binance keeps one position per coin,
 * so the two can't share one). Every minute, for each of its coins: if the last finished 1-minute close is
 * `k` standard deviations under its `win`-minute average, buy at market; sell at market once the close is
 * back at the average, or if the price falls `stop` under the entry. Once a week it re-picks its coins: the
 * ones that moved most over the last 7 days (sum of hourly moves), so it trades where the sharp dips are.
 *
 * Tested in bot/combo.ts on 16 real weeks with $1000: grid 1.2% on the other 8 coins + this at 5x on the 7 most
 * active made +$36 a week (worst week -$30, 13 of 16 green) vs +$20 (worst -$78) for the grid alone.
 */

export interface PanicConfig {
  /** Share of the trading budget this strategy uses (the grid gets the rest). */
  share: number;
  /** How many coins it trades at once. */
  coins: number;
  /** Average / deviation window, minutes. */
  win: number;
  /** Buy this many standard deviations under the average. */
  k: number;
  /** Stop: sell if the price falls this fraction under the entry. */
  stop: number;
}

export const DEFAULT_PANIC: PanicConfig = { share: 0.5, coins: 7, win: 480, k: 3.6, stop: 0.08 };

export interface PanicPos {
  symbol: string;
  qty: number;
  entry: number;
  stop?: { id: number; algo: boolean };
}

export interface PanicState {
  set: string[];
  pickedAt: number;
  pos: PanicPos[];
}

const WEEK_MS = 7 * 86_400_000;
const EVAL_MS = 60_000;

export class PanicSleeve {
  /** Coins this strategy watches this week. */
  set: string[] = [];
  pickedAt = 0;
  pos = new Map<string, PanicPos>();
  trades = 0;
  /** Latest read per coin (for the screen): average, buy line, last close. */
  read: Record<string, { mean: number; line: number; close: number }> = {};
  private lastEval = 0;
  private setupDone = new Set<string>();

  constructor(
    private ex: ExchangeClient,
    readonly cfg: PanicConfig,
    private leverage: number,
    private log: (kind: LogEntry['kind'], text: string, pnl?: number) => void,
    private now: () => number,
  ) {}

  /** Coins the grid must leave alone: this week's set and anything still held. */
  owns(symbol: string): boolean {
    return this.set.includes(symbol) || this.pos.has(symbol);
  }

  /** Notional per position: its share of the budget × leverage, split over its coins. */
  slice(budget: number): number {
    return (budget * this.cfg.share * this.leverage) / this.cfg.coins;
  }

  unrealized(px: Record<string, number>): number {
    let u = 0;
    for (const p of this.pos.values()) u += p.qty * ((px[p.symbol] ?? p.entry) - p.entry);
    return u;
  }

  snapshot(): PanicState {
    return { set: [...this.set], pickedAt: this.pickedAt, pos: [...this.pos.values()].map((p) => ({ ...p })) };
  }

  restore(s: PanicState | undefined) {
    if (!s) return;
    this.set = [...(s.set ?? [])];
    this.pickedAt = s.pickedAt ?? 0;
    for (const p of s.pos ?? []) this.pos.set(p.symbol, { ...p });
  }

  /** After a resume: drop positions that were closed while the app was off (its exchange stop fired). */
  async reconcile() {
    for (const p of [...this.pos.values()]) {
      const real = await this.ex.position(p.symbol);
      if (real.qty < p.qty * 0.5) {
        this.log('warn', `PANIC ${p.symbol}: position was closed while the app was off`);
        if (p.stop) await this.ex.cancelStop(p.symbol, p.stop).catch(() => undefined);
        this.pos.delete(p.symbol);
      }
    }
  }

  /**
   * Weekly pick: rank `candidates` by how much they moved over the last 7 days and keep the top ones the
   * budget can trade (exchange minimum) and the grid isn't holding.
   */
  async pick(candidates: string[], busy: Set<string>, rules: Record<string, SymbolRules>, budget: number) {
    const per = this.slice(budget);
    const scored: { s: string; move: number }[] = [];
    for (const s of candidates) {
      const r = rules[s];
      if (!r || busy.has(s) || per < r.minNotional * 1.1) continue;
      try {
        const c = await this.ex.closes(s, '1h', 168);
        if (c.length < 24) continue;
        let move = 0;
        for (let i = 1; i < c.length; i++) move += Math.abs(c[i] / c[i - 1] - 1);
        scored.push({ s, move });
      } catch {
        /* one coin's history failing just leaves it out this week */
      }
    }
    if (!scored.length) return;
    scored.sort((a, b) => b.move - a.move);
    this.set = scored.slice(0, this.cfg.coins).map((x) => x.s);
    this.pickedAt = this.now();
    this.log('info', `PANIC coins this week (most active): ${this.set.map((s) => s.replace('USDT', '')).join(', ')} · $${per.toFixed(0)} a position`);
  }

  /** Re-pick once a week (or when it has no coins). Called before the grid allocates, so panic chooses first. */
  async maybePick(candidates: string[], gridHeld: Set<string>, rules: Record<string, SymbolRules>, budget: number) {
    const age = this.now() - this.pickedAt;
    // Short of coins (the grid still held some when it picked, e.g. right after an upgrade): try again hourly.
    if (!this.set.length || age > WEEK_MS || (this.set.length < this.cfg.coins && age > 3_600_000)) await this.pick(candidates, gridHeld, rules, budget);
  }

  /** One round: stops on every call, buy/sell signals once a minute. */
  async tick(o: { px: Record<string, number>; budget: number; rules: Record<string, SymbolRules>; locked: boolean }) {
    for (const p of [...this.pos.values()]) {
      const px = o.px[p.symbol];
      if (px && px <= p.entry * (1 - this.cfg.stop)) await this.close(p, `stop -${(this.cfg.stop * 100).toFixed(0)}%`);
    }

    if (this.now() - this.lastEval < EVAL_MS) return;
    this.lastEval = this.now();
    const watch = [...new Set([...this.set, ...this.pos.keys()])];
    const series = await Promise.all(watch.map((s) => this.ex.closes(s, '1m', this.cfg.win).catch(() => [] as number[])));
    for (const [i, s] of watch.entries()) {
      const c = series[i];
      if (c.length < this.cfg.win * 0.9) continue;
      let s1 = 0;
      let s2 = 0;
      for (const x of c) {
        s1 += x;
        s2 += x * x;
      }
      const mean = s1 / c.length;
      const sd = Math.sqrt(Math.max(0, s2 / c.length - mean * mean));
      const close = c[c.length - 1];
      const line = mean - this.cfg.k * sd;
      this.read[s] = { mean, line, close };
      const held = this.pos.get(s);
      if (held) {
        if (close >= mean) await this.close(held, 'back at its average');
      } else if (!o.locked && this.set.includes(s) && close < line) {
        await this.open(s, o.px[s] ?? close, o.budget, o.rules[s]);
      }
    }
  }

  private async open(symbol: string, px: number, budget: number, r: SymbolRules | undefined) {
    if (!r || !px) return;
    const qty = roundDown(this.slice(budget) / px, r.stepSize);
    if (qty < r.minQty || qty * px < r.minNotional) return;
    if (!this.setupDone.has(symbol)) {
      await this.ex.setup(symbol, this.leverage);
      this.setupDone.add(symbol);
    }
    const fill = await this.ex.marketOpen(symbol, 'BUY', qty);
    const p: PanicPos = { symbol, qty: fill.qty, entry: fill.avgPrice || px };
    this.pos.set(symbol, p);
    try {
      p.stop = await this.ex.stopClose(symbol, roundTo(p.entry * (1 - this.cfg.stop), r.tickSize));
    } catch (e) {
      this.log('warn', `PANIC ${symbol}: exchange-side stop unavailable (${(e as Error).message}) — app-side stop still active`);
    }
    this.log('pass', `⚡ PANIC ${symbol}: bought ${p.qty} at ${p.entry} (sharp dip under its 8h average) · stop ${roundTo(p.entry * (1 - this.cfg.stop), r.tickSize)}`);
  }

  async close(p: PanicPos, reason: string) {
    const real = await this.ex.position(p.symbol);
    if (p.stop) await this.ex.cancelStop(p.symbol, p.stop).catch(() => undefined);
    if (real.qty !== 0) await this.ex.marketClose(p.symbol);
    this.pos.delete(p.symbol);
    this.trades++;
    this.log(real.unrealized >= 0 ? 'pass' : 'veto', `PANIC ${p.symbol} sold (${reason})`, real.unrealized);
  }

  async closeAll(reason: string) {
    for (const p of [...this.pos.values()]) {
      try {
        await this.close(p, reason);
      } catch (e) {
        this.log('warn', `PANIC close ${p.symbol} failed: ${(e as Error).message} — check Binance manually`);
      }
    }
  }
}
