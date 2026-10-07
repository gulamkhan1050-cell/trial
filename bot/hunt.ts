import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WIDE_MARKETS } from '../src/core/engine';

/**
 * HUNT — search thousands of settings for one that makes money EVERY week:  npm run hunt -- 500
 *
 * Four families on all 15 coins, each week replayed from the same starting money:
 *   grid      fixed ladder (long, short, neutral, or switched by each coin's trend regime)
 *   meanrev   buy (or short) a stretch below (above) a moving average, exit back at the average
 *   breakout  follow a break of the last N bars' high (low) with a trailing stop
 *   trend     long/short on a fast/slow average cross
 * Score = the WORST of the 8 most recent weeks (the target is ≥ $100 every week). The best then face
 * the 8 weeks before those, which the search never saw — a setting that only wins where it was found is luck.
 */

const capital = Number(process.argv[2]) || 500;
const TARGET = Number(process.argv[3]) || 100;
const WEEKS = 16; // 8 searched + 8 unseen
export const WEEK = 7 * 1440;
const WARM = 3000;
const CACHE = process.env.HUNT_CACHE || 'hunt-cache.bin';
const SAMPLES = Number(process.env.HUNT_SAMPLES) || 6000;
const MAKER = 0.0002;
const TAKER = 0.0005;

export interface Bars { o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array; t: Float64Array }

async function download(symbol: string, bars: number): Promise<number[][]> {
  const out: number[][] = [];
  let end: number | undefined;
  while (out.length < bars + 1) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000${end ? `&endTime=${end}` : ''}`;
    let res: Response | null = null;
    for (let a = 0; a < 5 && !res?.ok; a++) res = await fetch(url).catch(() => null);
    if (!res?.ok) throw new Error(`${symbol}: HTTP ${res?.status ?? 'no connection'}`);
    const rows = (await res.json()) as [number, string, string, string, string, string, number, string][];
    if (!rows.length) break;
    out.unshift(...rows.map((r) => [r[0], +r[1], +r[2], +r[3], +r[4], +r[7]]));
    end = rows[0][0] - 1;
  }
  return out.slice(0, -1).slice(-bars);
}

/** Binary cache: [coins, len] header then per coin t,o,h,l,c,v columns. */
export async function prices(): Promise<{ symbols: string[]; data: Bars[] }> {
  const need = WARM + WEEKS * WEEK;
  if (existsSync(CACHE)) {
    const buf = readFileSync(CACHE);
    const f = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    const n = f[0];
    const len = f[1];
    if (len >= need) {
      const symbols = JSON.parse(readFileSync(`${CACHE}.json`, 'utf8')) as string[];
      const data: Bars[] = [];
      for (let k = 0; k < n; k++) {
        const col = (j: number) => f.slice(2 + (k * 6 + j) * len, 2 + (k * 6 + j + 1) * len);
        data.push({ t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) });
      }
      return { symbols, data };
    }
  }
  const raw: number[][][] = [];
  const symbols: string[] = [];
  for (const [i, s] of WIDE_MARKETS.entries()) {
    console.log(`  downloading ${s} (${i + 1}/${WIDE_MARKETS.length})`);
    try {
      const rows = await download(s, need);
      if (rows.length < need) throw new Error(`only ${rows.length} bars`);
      raw.push(rows);
      symbols.push(s);
    } catch (e) {
      console.log(`  skipped ${s}: ${(e as Error).message}`);
    }
  }
  const len = Math.min(...raw.map((r) => r.length));
  const f = new Float64Array(2 + raw.length * 6 * len);
  f[0] = raw.length;
  f[1] = len;
  const data: Bars[] = [];
  raw.forEach((rows, k) => {
    const r = rows.slice(-len);
    for (let j = 0; j < 6; j++) for (let i = 0; i < len; i++) f[2 + (k * 6 + j) * len + i] = r[i][j];
    const col = (j: number) => f.slice(2 + (k * 6 + j) * len, 2 + (k * 6 + j + 1) * len);
    data.push({ t: col(0), o: col(1), h: col(2), l: col(3), c: col(4), v: col(5) });
  });
  writeFileSync(CACHE, Buffer.from(f.buffer));
  writeFileSync(`${CACHE}.json`, JSON.stringify(symbols));
  return { symbols, data };
}

// ───────────────────────────── settings ─────────────────────────────

type Family = 'grid' | 'meanrev' | 'breakout' | 'trend';
export interface P {
  family: Family;
  lev: number;
  /** grid: 'long' | 'short' | 'neutral' | 'switch' (regime: up→long, chop→neutral, down→short). Others: 'long' | 'both'. */
  side: 'long' | 'short' | 'neutral' | 'switch' | 'both';
  step: number; // grid step
  levels: number; // grid levels per side
  win: number; // bars: average / channel / slow window
  k: number; // meanrev: stretch in std devs; trend: fast window share
  stop: number; // 0 = none; meanrev/trend stop, breakout trailing stop
}

const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const LEVS = [1, 2, 3, 5, 8, 10, 15, 20];

function random(r: () => number): P {
  const family = pick(r, ['grid', 'grid', 'meanrev', 'breakout', 'trend'] as Family[]);
  const lev = pick(r, LEVS);
  if (family === 'grid')
    return { family, lev, side: pick(r, ['long', 'short', 'neutral', 'switch'] as const), step: 0.002 + r() ** 1.5 * 0.04, levels: 2 + Math.floor(r() * 19), win: pick(r, [240, 480, 1440]), k: 0.015, stop: 0 };
  if (family === 'meanrev')
    return { family, lev, side: pick(r, ['long', 'both'] as const), step: 0, levels: 0, win: pick(r, [30, 60, 120, 240, 480, 1440, 2880]), k: 1 + r() * 3.5, stop: pick(r, [0, 0.01, 0.02, 0.04, 0.08]) };
  if (family === 'breakout')
    return { family, lev, side: pick(r, ['long', 'both'] as const), step: 0, levels: 0, win: pick(r, [30, 60, 120, 240, 480, 1440, 2880]), k: 0, stop: 0.003 + r() * 0.05 };
  return { family, lev, side: pick(r, ['long', 'both'] as const), step: 0, levels: 0, win: pick(r, [120, 240, 480, 1440, 2880]), k: 0.1 + r() * 0.4, stop: pick(r, [0, 0.01, 0.02, 0.04]) };
}

function mutate(p: P, r: () => number): P {
  const q = { ...p };
  const j = (x: number, f = 0.25) => x * (1 + (r() * 2 - 1) * f);
  switch (Math.floor(r() * 4)) {
    case 0:
      q.lev = pick(r, LEVS);
      break;
    case 1:
      q.step = Math.min(0.06, Math.max(0.001, j(q.step)));
      q.k = Math.max(0.05, j(q.k));
      break;
    case 2:
      q.levels = Math.max(2, Math.min(30, q.levels + Math.round((r() * 2 - 1) * 3)));
      q.win = pick(r, [30, 60, 120, 240, 480, 1440, 2880]);
      break;
    default:
      q.stop = q.family === 'breakout' ? Math.max(0.002, j(q.stop || 0.01)) : pick(r, [0, 0.01, 0.02, 0.04, 0.08]);
  }
  if (q.family === 'grid') q.win = pick(r, [240, 480, 1440]);
  return q;
}

export function label(p: P): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  if (p.family === 'grid') return `GRID ${p.side} ${p.lev}x · step ${pct(p.step)} · ${p.levels} lv`;
  if (p.family === 'meanrev') return `MEANREV ${p.side} ${p.lev}x · ${p.win}m avg · ${p.k.toFixed(2)}σ · stop ${p.stop ? pct(p.stop) : '-'}`;
  if (p.family === 'breakout') return `BREAKOUT ${p.side} ${p.lev}x · ${p.win}m channel · trail ${pct(p.stop)}`;
  return `TREND ${p.side} ${p.lev}x · ${p.win}m/${Math.round(p.win * (Math.round(p.k * 10) / 10))}m · stop ${p.stop ? pct(p.stop) : '-'}`;
}

// ───────────────────────────── indicators (cached per coin) ─────────────────────────────

const memo = new Map<string, Float64Array | Int8Array>();
function ema(b: Bars, coin: number, n: number): Float64Array {
  const key = `e${coin}|${n}`;
  let x = memo.get(key) as Float64Array | undefined;
  if (x) return x;
  x = new Float64Array(b.c.length);
  const a = 2 / (n + 1);
  x[0] = b.c[0];
  for (let i = 1; i < x.length; i++) x[i] = b.c[i] * a + x[i - 1] * (1 - a);
  memo.set(key, x);
  return x;
}
/** Rolling mean and std of close over n bars. */
function band(b: Bars, coin: number, n: number): [Float64Array, Float64Array] {
  const km = `m${coin}|${n}`;
  const ks = `s${coin}|${n}`;
  if (memo.has(km)) return [memo.get(km) as Float64Array, memo.get(ks) as Float64Array];
  const len = b.c.length;
  const m = new Float64Array(len);
  const s = new Float64Array(len);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    s1 += b.c[i];
    s2 += b.c[i] * b.c[i];
    if (i >= n) {
      s1 -= b.c[i - n];
      s2 -= b.c[i - n] * b.c[i - n];
    }
    const cnt = Math.min(i + 1, n);
    m[i] = s1 / cnt;
    s[i] = Math.sqrt(Math.max(0, s2 / cnt - m[i] * m[i]));
  }
  memo.set(km, m);
  memo.set(ks, s);
  return [m, s];
}
/** Highest high / lowest low of the n bars BEFORE i. */
function channel(b: Bars, coin: number, n: number): [Float64Array, Float64Array] {
  const kh = `h${coin}|${n}`;
  const kl = `l${coin}|${n}`;
  if (memo.has(kh)) return [memo.get(kh) as Float64Array, memo.get(kl) as Float64Array];
  const len = b.c.length;
  const hi = new Float64Array(len);
  const lo = new Float64Array(len);
  const dq: number[] = [];
  const dl: number[] = [];
  for (let i = 0; i < len; i++) {
    hi[i] = dq.length ? b.h[dq[0]] : Infinity;
    lo[i] = dl.length ? b.l[dl[0]] : -Infinity;
    while (dq.length && b.h[dq[dq.length - 1]] <= b.h[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
    while (dl.length && b.l[dl[dl.length - 1]] >= b.l[i]) dl.pop();
    dl.push(i);
    while (dl[0] <= i - n) dl.shift();
  }
  memo.set(kh, hi);
  memo.set(kl, lo);
  return [hi, lo];
}
/** Trend regime per bar: 1 up, -1 down, 0 chop (price change over n bars beyond ±1.5% and agreeing average slope). */
function regime(b: Bars, coin: number, n: number): Int8Array {
  const key = `r${coin}|${n}`;
  let r = memo.get(key) as Int8Array | undefined;
  if (r) return r;
  const f = ema(b, coin, 30);
  const s = ema(b, coin, Math.round(n / 2));
  r = new Int8Array(b.c.length);
  for (let i = n; i < r.length; i++) {
    const tr = b.c[i] / b.c[i - n] - 1;
    const sl = f[i] / s[i] - 1;
    if (tr > 0.015 && sl > 0) r[i] = 1;
    else if (tr < -0.015 && sl < 0) r[i] = -1;
  }
  memo.set(key, r);
  return r;
}

// ───────────────────────────── simulators: one coin, one week ─────────────────────────────

/** Returns the coin's equity at the end of [from, to) starting from `cash`, and its lowest equity. */
export function simGrid(p: P, b: Bars, coin: number, from: number, to: number, cash0: number): [number, number] {
  const reg = p.side === 'switch' ? regime(b, coin, p.win) : null;
  const N = p.levels;
  const step = p.step;
  let cash = cash0;
  let posCost = 0;
  let pos = 0;
  let center = b.c[from];
  let qty = (cash * p.lev) / N / center;
  let mode: 'long' | 'short' | 'neutral' = p.side === 'switch' ? 'neutral' : (p.side as 'long' | 'short' | 'neutral');
  let low = cash0;
  const eq = (px: number) => cash - posCost + pos * qty * px;
  const target = (px: number) => {
    const k = Math.floor((px - center) / (center * step) + 1e-9);
    if (k < 0) return mode === 'short' ? 0 : Math.min(N, -k);
    return mode === 'long' ? 0 : -Math.min(N, k);
  };
  const fill = (to2: number, px: number) => {
    const d = to2 - pos;
    if (!d) return;
    posCost += d * qty * px;
    cash -= Math.abs(d) * qty * px * MAKER;
    pos = to2;
  };
  const flatten = (px: number) => {
    cash -= Math.abs(pos) * qty * px * TAKER;
    cash = eq(px);
    posCost = 0;
    pos = 0;
    center = px;
    qty = (Math.max(0, cash) * p.lev) / N / center;
  };
  for (let i = from; i < to; i++) {
    if (reg && (i - from) % 15 === 0) {
      const want = reg[i] > 0 ? 'long' : reg[i] < 0 ? 'short' : 'neutral';
      if (want !== mode) {
        flatten(b.c[i]);
        mode = want;
      }
    }
    const o = b.o[i];
    const path = b.c[i] < o ? [o, b.h[i], b.l[i], b.c[i]] : [o, b.l[i], b.h[i], b.c[i]];
    for (let j = 1; j < 4; j++) {
      const a = path[j - 1];
      const z = path[j];
      if (a === z) continue;
      const dir = z > a ? 1 : -1;
      // Levels crossed between a and z, in order.
      const unit = center * step;
      let k = dir > 0 ? Math.floor((a - center) / unit + 1e-9) + 1 : Math.ceil((a - center) / unit - 1e-9) - 1;
      for (let guard = 0; guard < 200; guard++) {
        const lp = center + k * unit;
        if (dir > 0 ? lp > z : lp < z) break;
        fill(target(lp), lp);
        if (Math.abs(lp - center) >= unit * (N + 1) - 1e-9) {
          flatten(lp);
          break;
        }
        k += dir;
      }
    }
    const e = eq(b.c[i]);
    // Isolated margin: worst-case equity inside the bar.
    const worst = Math.min(eq(b.l[i]), eq(b.h[i]));
    low = Math.min(low, worst);
    if (worst <= 0) return [0, 0];
    void e;
  }
  return [eq(b.c[to - 1]), low];
}

/** Single position strategies (meanrev / breakout / trend): market orders, taker fee, liquidation at 1/lev. */
export function simPos(p: P, b: Bars, coin: number, from: number, to: number, cash0: number): [number, number] {
  let cash = cash0;
  let side = 0;
  let entry = 0;
  let base = 0; // equity committed at entry
  let ext = 0; // best price since entry (trailing stop)
  let low = cash0;
  const both = p.side === 'both';
  const value = (px: number) => (side ? base + base * p.lev * side * (px / entry - 1) : cash);
  const open = (s: number, px: number) => {
    base = cash - cash * p.lev * TAKER;
    side = s;
    entry = px;
    ext = px;
  };
  const close = (px: number) => {
    cash = Math.max(0, value(px) - base * p.lev * TAKER * (px / entry));
    side = 0;
  };
  let m: Float64Array, sd: Float64Array, hi: Float64Array, lo: Float64Array, fast: Float64Array, slow: Float64Array;
  if (p.family === 'meanrev') [m, sd] = band(b, coin, p.win);
  else if (p.family === 'breakout') [hi, lo] = channel(b, coin, p.win);
  else {
    slow = ema(b, coin, p.win);
    fast = ema(b, coin, Math.max(5, Math.round(p.win * (Math.round(p.k * 10) / 10)))); // k rounded: bounded indicator cache
  }
  for (let i = from; i < to; i++) {
    const c = b.c[i];
    if (side) {
      const worstPx = side > 0 ? b.l[i] : b.h[i];
      const adverse = side * (1 - worstPx / entry);
      if (adverse >= 1 / p.lev) return [0, 0];
      low = Math.min(low, value(worstPx));
      if (p.family === 'breakout') {
        ext = side > 0 ? Math.max(ext, b.h[i]) : Math.min(ext, b.l[i]);
        const stopPx = ext * (1 - side * p.stop);
        if (side > 0 ? b.l[i] <= stopPx : b.h[i] >= stopPx) {
          close(stopPx);
          continue;
        }
      } else if (p.stop && adverse >= p.stop) {
        close(entry * (1 - side * p.stop));
        continue;
      }
      if (p.family === 'meanrev' && (side > 0 ? c >= m![i] : c <= m![i])) close(c);
      else if (p.family === 'trend' && Math.sign(fast![i] - slow![i]) === -side) close(c);
    }
    if (!side && cash > cash0 * 0.05) {
      if (p.family === 'meanrev') {
        if (c < m![i] - p.k * sd![i]) open(1, c);
        else if (both && c > m![i] + p.k * sd![i]) open(-1, c);
      } else if (p.family === 'breakout') {
        if (c > hi![i]) open(1, c);
        else if (both && c < lo![i]) open(-1, c);
      } else if ((i - from) % 15 === 0) {
        const d = Math.sign(fast![i] - slow![i]);
        if (d > 0 || (both && d < 0)) open(d, c);
      }
    }
  }
  if (side) close(b.c[to - 1]);
  return [cash, low];
}

// ───────────────────────────── evaluation ─────────────────────────────

let SYMBOLS: string[] = [];
let DATA: Bars[] = [];
let LEN = 0;
/** Week w = 0 is the most recent. */
const weekRange = (w: number): [number, number] => [LEN - (w + 1) * WEEK, LEN - w * WEEK];

function weekly(p: P, weeks: number[]): { pnl: number[]; dd: number } {
  const slice = capital / SYMBOLS.length;
  let dd = 0;
  const pnl = weeks.map((w) => {
    const [from, to] = weekRange(w);
    let end = 0;
    let lows = 0;
    DATA.forEach((b, j) => {
      const [e, l] = p.family === 'grid' ? simGrid(p, b, j, from, to, slice) : simPos(p, b, j, from, to, slice);
      end += e;
      lows += l;
    });
    dd = Math.max(dd, 1 - lows / capital);
    return end - capital;
  });
  return { pnl, dd };
}

const SEARCH = [7, 6, 5, 4, 3, 2, 1, 0];
const UNSEEN = [15, 14, 13, 12, 11, 10, 9, 8];
const min = (xs: number[]) => Math.min(...xs);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const score = (pnl: number[]) => min(pnl) + 0.25 * avg(pnl);

async function main() {
  const t0 = Date.now();
  ({ symbols: SYMBOLS, data: DATA } = await prices());
  LEN = DATA[0].c.length;
  const day = (i: number) => new Date(DATA[0].t[i]).toISOString().slice(5, 10);
  const wl = (w: number) => `${day(weekRange(w)[0])}→${day(weekRange(w)[1] - 1)}`;
  console.log(`$${capital} · ${SYMBOLS.length} coins · search weeks ${wl(7)} … ${wl(0)} · unseen ${wl(15)} … ${wl(8)}`);

  const r = rng(Number(process.env.HUNT_SEED) || 20261006);
  type Row = { p: P; pnl: number[]; dd: number; s: number };
  const seen: Row[] = [];
  const evalP = (p: P): Row => {
    const { pnl, dd } = weekly(p, SEARCH);
    const row = { p, pnl, dd, s: score(pnl) };
    seen.push(row);
    return row;
  };
  for (let n = 0; n < SAMPLES; n++) {
    evalP(random(r));
    if (n % 500 === 0) {
      const best = [...seen].sort((a, b) => b.s - a.s)[0];
      console.log(`  random ${n}/${SAMPLES} · ${Math.round((Date.now() - t0) / 1000)}s · best worst-week ${best ? `$${min(best.pnl).toFixed(0)} (${label(best.p)})` : '-'}`);
    }
  }
  // Refine: mutate the best settings, keep improving the elite.
  // The best 10 of EACH family are refined, so one family's local peak can't crowd out the others.
  const GENS = Number(process.env.HUNT_GENS) || 60;
  for (let gen = 0; gen < GENS; gen++) {
    const sorted = [...seen].sort((a, b) => b.s - a.s);
    const elite = (['grid', 'meanrev', 'breakout', 'trend'] as Family[]).flatMap((f) => sorted.filter((x) => x.p.family === f).slice(0, 10));
    for (const e of elite) for (let m = 0; m < 4; m++) evalP(mutate(e.p, r));
    const best = sorted[0];
    if (gen % 5 === 4)
      console.log(`  refine ${gen + 1}/${GENS} · ${seen.length} settings · ${Math.round((Date.now() - t0) / 1000)}s · best worst-week $${min(best.pnl).toFixed(0)} avg $${avg(best.pnl).toFixed(0)} (${label(best.p)})`);
  }

  // Distinct top settings, then the unseen 8 weeks.
  const top: Row[] = [];
  const names = new Set<string>();
  const ranked = [...seen].sort((a, b) => b.s - a.s);
  for (const f of ['grid', 'meanrev', 'breakout', 'trend'] as Family[]) {
    let k = 0;
    for (const row of ranked) {
      if (row.p.family !== f || k >= 8) continue;
      const n = label(row.p);
      if (names.has(n)) continue;
      names.add(n);
      top.push(row);
      k++;
    }
  }
  top.sort((a, b) => b.s - a.s);
  const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(0)}`.padStart(6);
  const out = top.map((row) => ({ ...row, un: weekly(row.p, UNSEEN) }));
  const line = (x: (typeof out)[number]) =>
    `${label(x.p).padEnd(58)} ${x.pnl.map(money).join('')} │ ${money(min(x.pnl))}${money(avg(x.pnl))} ║ ${x.un.pnl.map(money).join('')} │ ${money(min(x.un.pnl))}${money(avg(x.un.pnl))} ${`${(Math.max(x.dd, x.un.dd) * 100).toFixed(0)}%`.padStart(5)}`;
  const hit = out.filter((x) => min(x.pnl) >= TARGET && min(x.un.pnl) >= TARGET);
  const hitSearch = seen.filter((x) => min(x.pnl) >= TARGET).length;
  const report = [
    `HUNT · real Binance 1m · ${SYMBOLS.length} coins · $${capital} each week · target ≥ $${TARGET} EVERY week · ${seen.length} settings searched`,
    `search weeks (oldest→newest): ${SEARCH.map(wl).join(' ')}`,
    `unseen weeks (oldest→newest): ${UNSEEN.map(wl).join(' ')}`,
    '',
    `${'setting'.padEnd(58)} ${'8 search weeks'.padEnd(48)} │  worst   avg ║ ${'8 UNSEEN weeks'.padEnd(48)} │  worst   avg  drop`,
    ...out.map(line),
    '',
    `Settings with ≥ $${TARGET} in all 8 search weeks: ${hitSearch} of ${seen.length}`,
    `…and ALSO ≥ $${TARGET} in all 8 unseen weeks: ${hit.length}`,
    ...hit.map(line),
  ].join('\n');
  console.log(`\n${report}`);
  writeFileSync(process.env.HUNT_OUT || 'hunt-report.txt', report);
}

// Only when run as the hunt itself (combo.ts imports the simulators from here).
if (process.argv[1]?.includes('hunt'))
  main().catch((e) => {
    console.error('✕', (e as Error).message);
    process.exit(1);
  });
