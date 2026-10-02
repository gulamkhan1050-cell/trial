import { DEFAULT_SETTINGS, Engine, type Settings } from './engine';
import { BINANCE_PUBLIC, type FeedHandlers, type MarketFeed, partial, SimFeed } from './market';
import { readRegime } from './regime';
import type { Candle } from './types';

/**
 * ARENA — replay the same stretch of market through several strategies at full CPU
 * speed and compare what each one would have made. Each contestant is a normal Engine
 * with its own paper book, fed bar by bar from the same candles.
 */

export interface Contestant {
  name: string;
  patch: Partial<Settings>;
}

export interface ArenaResult {
  name: string;
  equity: { t: number; v: number }[];
  start: number;
  final: number;
  trades: number;
  winRate: number;
  maxDrawdown: number; // fraction of peak
  peak: number; // highest equity reached
  bestDay: number;
  worstDay: number;
  /** Set when averaged over repeated runs: how many runs, their range, and how many ended green. */
  runs?: number;
  minFinal?: number;
  maxFinal?: number;
  greenRuns?: number;
}

export interface ArenaProgress {
  stage: 'download' | 'warmup' | 'run' | 'done';
  pct: number; // 0..1
  text: string;
}

export interface ArenaOptions {
  symbols: string[];
  days: number;
  source: 'real' | 'sim';
  base: Settings;
  contestants: Contestant[];
  onProgress?: (p: ArenaProgress) => void;
  signal?: { cancelled: boolean };
  /**
   * 'fast' (default): grid contestants share one FORGE per market, re-tuned every ~3h of replay.
   * 'thorough': every contestant runs its own FORGE, re-tuned every ~1h (the original Arena; ~4× slower).
   */
  forgeMode?: 'fast' | 'thorough';
  /** Also race HOLD (buy every coin, hold) and TREND LONG (long while a coin's regime is UP) at this leverage. */
  benchmarkLeverage?: number;
}

export const WARMUP_BARS = 1200;

/** Supplies history only; the Arena pushes live bars into each engine itself. */
class HistoryFeed implements MarketFeed {
  readonly name = 'Arena';
  constructor(private history: Record<string, Candle[]>) {}
  async start(symbols: string[], h: FeedHandlers) {
    for (const s of symbols) h.onHistory(s, this.history[s]);
    h.onStatus('replay', 'arena');
  }
  stop() {}
}

async function download(symbol: string, bars: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end: number | undefined;
  while (out.length < bars + 1) {
    const url = `${BINANCE_PUBLIC.rest}/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000${end ? `&endTime=${end}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const rows = (await res.json()) as [number, string, string, string, string, string, number, string][];
    if (!rows.length) break;
    out.unshift(...rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })));
    end = rows[0][0] - 1;
  }
  return out.slice(0, -1).slice(-bars); // drop the forming bar
}

export async function loadData(
  symbols: string[],
  bars: number,
  source: 'real' | 'sim',
  onProgress?: (p: ArenaProgress) => void,
): Promise<{ data: Record<string, Candle[]>; source: 'real' | 'sim'; note: string; symbols: string[] }> {
  const data: Record<string, Candle[]> = {};
  if (source === 'real') {
    // Download coin by coin; a coin that fails (delisted, renamed, too new) is skipped, not fatal.
    const ok: string[] = [];
    const skipped: string[] = [];
    let lastError = '';
    for (const [i, s] of symbols.entries()) {
      onProgress?.({ stage: 'download', pct: i / symbols.length, text: `downloading ${s} (${i + 1}/${symbols.length})` });
      try {
        const c = await download(s, bars);
        // Too little history (listed recently) would shorten every coin's window; skip it instead.
        if (c.length < Math.min(bars, WARMUP_BARS + 1440)) throw new Error(`only ${c.length} bars`);
        data[s] = c;
        ok.push(s);
      } catch (err) {
        lastError = (err as Error).message;
        skipped.push(s);
        // Nothing has worked by the third coin: Binance itself is unreachable — stop trying.
        if (!ok.length && skipped.length >= 3) break;
      }
    }
    if (ok.length >= 1) {
      const len = Math.min(...ok.map((s) => data[s].length));
      for (const s of ok) data[s] = data[s].slice(-len);
      const note = `real Binance 1m prices · ${ok.length} coins · ${fmtRange(data[ok[0]])}` + (skipped.length ? ` · skipped ${skipped.map((s) => s.replace('USDT', '')).join(', ')}` : '');
      return { data, source: 'real', note, symbols: ok };
    }
    onProgress?.({ stage: 'download', pct: 1, text: `Binance unreachable (${lastError}) — using offline data` });
    for (const s of Object.keys(data)) delete data[s];
  }
  for (const [i, s] of symbols.entries()) {
    await new SimFeed(1000, 7919 * (i + 1), bars).start([s], { onHistory: (_x, c) => (data[s] = c), onCandle() {}, onStatus() {} });
  }
  return { data, source: 'sim', note: 'offline simulated prices', symbols };
}

type Loaded = Awaited<ReturnType<typeof loadData>>;

export async function runArena(opt: ArenaOptions): Promise<{ results: ArenaResult[]; note: string; source: 'real' | 'sim' }> {
  const loaded = await loadData(opt.symbols, WARMUP_BARS + opt.days * 1440, opt.source, opt.onProgress);
  return simulate(loaded, opt, 0);
}

/**
 * Run the same prices `runs` times with different FORGE seeds and average each contestant, so a
 * setting has to win on average — not get lucky once. Prices are downloaded once.
 */
export async function runArenaRepeated(opt: ArenaOptions, runs: number): Promise<{ results: ArenaResult[]; note: string; source: 'real' | 'sim' }> {
  const loaded = await loadData(opt.symbols, WARMUP_BARS + opt.days * 1440, opt.source, opt.onProgress);
  const all: ArenaResult[][] = [];
  let note = '';
  for (let k = 0; k < runs && !opt.signal?.cancelled; k++) {
    const out = await simulate(loaded, { ...opt, onProgress: (p) => opt.onProgress?.({ ...p, text: `run ${k + 1}/${runs} · ${p.text}`, pct: (k + p.pct) / runs }) }, k);
    all.push(out.results);
    note = out.note;
  }
  return { results: averageRuns(all), note: `${note} · average of ${all.length} run${all.length === 1 ? '' : 's'}`, source: loaded.source };
}

export function averageRuns(all: ArenaResult[][]): ArenaResult[] {
  if (all.length <= 1) return all[0] ?? [];
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return all[0].map((first, j) => {
    const rs = all.map((run) => run[j]);
    const finals = rs.map((r) => r.final);
    return {
      ...first,
      final: mean(finals),
      trades: Math.round(mean(rs.map((r) => r.trades))),
      winRate: mean(rs.map((r) => r.winRate)),
      maxDrawdown: mean(rs.map((r) => r.maxDrawdown)),
      peak: mean(rs.map((r) => r.peak)),
      bestDay: Math.max(...rs.map((r) => r.bestDay)),
      worstDay: Math.min(...rs.map((r) => r.worstDay)),
      runs: rs.length,
      minFinal: Math.min(...finals),
      maxFinal: Math.max(...finals),
      greenRuns: finals.filter((f) => f > first.start).length,
    };
  });
}

async function simulate(loaded: Loaded, opt: ArenaOptions, run: number): Promise<{ results: ArenaResult[]; note: string; source: 'real' | 'sim' }> {
  const { data, source, note } = loaded;
  const symbols = loaded.symbols;
  const len = Math.min(...symbols.map((s) => data[s].length));
  if (len < WARMUP_BARS + 60) throw new Error('not enough history');

  const history: Record<string, Candle[]> = {};
  for (const s of symbols) history[s] = data[s].slice(0, WARMUP_BARS);

  // Fixed seeds: the same prices and settings give the same result every run. In thorough mode each
  // contestant gets its own seed, so their FORGEs search independently (as the original Arena did).
  const thorough = opt.forgeMode === 'thorough';
  const engines = opt.contestants.map((c, j) => {
    const e = new Engine({ ...opt.base, ...c.patch, feed: 'sim', symbols: symbols }, 20260101 + run * 104729 + (thorough ? j * 7919 : 0));
    e.manualForge = true;
    return e;
  });
  for (const e of engines) await e.start(new HistoryFeed(history));

  // Grid contestants that differ only in leverage or crash guard share one FORGE per market:
  // they then trade identical ladders, so the comparison isolates what actually differs — and
  // the search (most of the Arena's CPU) runs once instead of once per contestant.
  // Grids that share fees and take-profit rules can share one FORGE (fast mode); old-vs-new must not.
  const feeKey = (e: Engine) => `${e.settings.grid.maker}/${e.settings.grid.taker}/${e.settings.grid.classicTp ? 'classic' : 'smart'}`; // FORGE ignores regime, so OLD and REGIME may share it
  const leaders = new Map<string, Engine>();
  const followerOf = new Map<Engine, Engine>();
  for (const e of engines) {
    if (thorough || !e.gridMode()) continue;
    const lead = leaders.get(feeKey(e));
    if (lead) followerOf.set(e, lead);
    else leaders.set(feeKey(e), e);
  }
  const forge = () => {
    for (const e of engines) if (!followerOf.has(e)) e.forgeOnce();
    for (const [f, lead] of followerOf) for (const [sym, slot] of lead.grids) {
      const mine = f.grids.get(sym);
      if (mine) mine.forge = slot.forge;
    }
  };

  // Warm-up: a dozen FORGE generations per market before the first live bar.
  const warmSteps = 12 * symbols.length;
  for (let i = 0; i < warmSteps; i++) {
    forge();
    if (i % 10 === 0) {
      opt.onProgress?.({ stage: 'warmup', pct: i / warmSteps, text: `FORGE warm-up ${Math.round((i / warmSteps) * 100)}%` });
      await tick();
    }
    if (opt.signal?.cancelled) break;
  }

  const curves: { t: number; v: number }[][] = engines.map(() => []);
  // Each market is re-judged about every 3 hours of replay in fast mode (cheap enough for 30 coins ×
  // several contestants), or every hour in thorough mode.
  const forgeEvery = Math.max(1, Math.round((thorough ? 60 : 180) / symbols.length));
  for (let i = WARMUP_BARS; i < len && !opt.signal?.cancelled; i++) {
    for (const e of engines) {
      for (const s of symbols) {
        const k = data[s][i];
        for (let step = 1; step < 4; step++) await e.ingest(s, partial(k, step), false);
        await e.ingest(s, k, true);
      }
    }
    if ((i - WARMUP_BARS) % forgeEvery === 0) forge();
    if ((i - WARMUP_BARS) % 30 === 0 || i === len - 1) {
      const t = data[symbols[0]][i].t;
      engines.forEach((e, j) => curves[j].push({ t, v: e.totalEquity() }));
    }
    if (i % 20 === 0) {
      const pct = (i - WARMUP_BARS) / (len - WARMUP_BARS);
      const day = new Date(data[symbols[0]][i].t).toLocaleDateString();
      opt.onProgress?.({ stage: 'run', pct, text: `replaying ${day} · ${Math.round(pct * 100)}%` });
      await tick();
    }
  }
  for (const e of engines) e.stop();

  const results = engines.map((e, j) => summarize(opt.contestants[j].name, e, curves[j]));
  if (opt.benchmarkLeverage) {
    const start = opt.base.startBalance;
    const fee = opt.base.grid.taker;
    results.push(benchmark('HOLD · 3× buy every coin and hold', data, symbols, len, start, opt.benchmarkLeverage, fee, () => true));
    results.push(benchmark('TREND LONG · 3× long while regime is UP', data, symbols, len, start, opt.benchmarkLeverage, fee, 'trend'));
  }
  opt.onProgress?.({ stage: 'done', pct: 1, text: 'done' });
  return { results, note: note + (thorough ? ' · thorough FORGE' : ' · fast FORGE'), source };
}

/**
 * Simple long benchmarks on the same prices, no FORGE: an equal slice of the bank per coin at `lev`,
 * market orders (taker fee) in and out, and a coin is liquidated (its slice lost) if it falls 1/lev.
 * HOLD buys every coin at the start; TREND is long a coin only from an UP regime read until a DOWN one.
 */
function benchmark(
  name: string,
  data: Record<string, Candle[]>,
  symbols: string[],
  len: number,
  start: number,
  lev: number,
  fee: number,
  mode: (() => boolean) | 'trend',
): ArenaResult {
  const slice = start / symbols.length;
  const pos = symbols.map(() => ({ in: false, entry: 0, cash: slice, trades: 0, wins: 0, dead: false }));
  const value = (j: number, px: number) => {
    const p = pos[j];
    if (!p.in) return p.cash;
    return Math.max(0, p.cash + p.cash * lev * (px / p.entry - 1));
  };
  const close = (j: number, px: number) => {
    const p = pos[j];
    const v = value(j, px) - p.cash * lev * fee;
    if (v > p.cash) p.wins++;
    p.cash = Math.max(0, v);
    p.in = false;
    p.trades++;
  };
  const open = (j: number, px: number) => {
    const p = pos[j];
    if (p.dead || p.cash <= 0) return;
    p.cash -= p.cash * lev * fee;
    p.entry = px;
    p.in = true;
  };
  const equity: { t: number; v: number }[] = [];
  for (let i = WARMUP_BARS; i < len; i++) {
    symbols.forEach((s, j) => {
      const k = data[s][i];
      const p = pos[j];
      if (p.in && k.l <= p.entry * (1 - 1 / lev)) {
        p.cash = 0; // liquidated
        p.in = false;
        p.dead = true;
        p.trades++;
        return;
      }
      if (mode === 'trend') {
        if ((i - WARMUP_BARS) % 15 !== 0) return;
        const r = readRegime(data[s].slice(Math.max(0, i - 300), i + 1)).regime;
        if (!p.in && r === 'up') open(j, k.c);
        else if (p.in && r === 'down') close(j, k.c);
      } else if (i === WARMUP_BARS) open(j, k.c);
    });
    if ((i - WARMUP_BARS) % 30 === 0 || i === len - 1) {
      equity.push({ t: data[symbols[0]][i].t, v: symbols.reduce((sum, s, j) => sum + value(j, data[s][i].c), 0) });
    }
  }
  // Mark open positions at the last price (no exit fee) so the result is comparable to the grids' equity.
  const trades = pos.reduce((n, p) => n + p.trades + (p.in ? 1 : 0), 0);
  const wins = pos.reduce((n, p) => n + p.wins, 0);
  const fake = { startBalance: start, totalEquity: () => equity[equity.length - 1]?.v ?? start, tradeCount: trades, winCount: wins } as unknown as Engine;
  return summarize(name, fake, equity);
}

function summarize(name: string, e: Engine, equity: { t: number; v: number }[]): ArenaResult {
  let peak = e.startBalance;
  let maxDd = 0;
  const byDay = new Map<string, { first: number; last: number }>();
  let prev = e.startBalance;
  for (const p of equity) {
    peak = Math.max(peak, p.v);
    maxDd = Math.max(maxDd, 1 - p.v / peak);
    const key = new Date(p.t).toDateString();
    const d = byDay.get(key) ?? { first: prev, last: prev };
    d.last = p.v;
    byDay.set(key, d);
    prev = p.v;
  }
  const days = [...byDay.values()].map((d) => d.last - d.first);
  return {
    name,
    equity,
    start: e.startBalance,
    final: e.totalEquity(),
    trades: e.tradeCount,
    winRate: e.tradeCount ? e.winCount / e.tradeCount : 0,
    maxDrawdown: maxDd,
    peak,
    bestDay: days.length ? Math.max(...days) : 0,
    worstDay: days.length ? Math.min(...days) : 0,
  };
}

function fmtRange(c: Candle[]): string {
  const f = (t: number) => new Date(t).toLocaleDateString();
  return `${f(c[WARMUP_BARS]?.t ?? c[0].t)} → ${f(c[c.length - 1].t)}`;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export const ARENA_CONTESTANTS: Contestant[] = [
  { name: 'NORMAL · directional agents', patch: { strategy: 'agents' } },
  { name: 'MICRO · grid on every market', patch: { strategy: 'grid' } },
];

/** Grid variants on the same data, plus NORMAL as the baseline. */
export function gridVariants(base: Settings): Contestant[] {
  const g = base.grid;
  const loose = { crashDrop: 0.025, crashBars: 30, crashShare: 0.67 };
  return [
    // The grids that matter; HOLD and TREND LONG are added as benchmarks (benchmarkLeverage).
    { name: 'OLD · 3× grid', patch: { strategy: 'grid', grid: { ...g, leverage: 3, crashGuard: true, ...loose, classicTp: true, regime: false } } },
    { name: 'SMART · 3× regime + smart TP', patch: { strategy: 'grid', grid: { ...g, leverage: 3, crashGuard: true, ...loose, classicTp: false, regime: true } } },
    { name: 'SMART · 5× regime + smart TP', patch: { strategy: 'grid', grid: { ...g, leverage: 5, crashGuard: true, ...loose, classicTp: false, regime: true } } },
  ];
}

export { DEFAULT_SETTINGS };
