import './nodeStorage';
import { writeFileSync } from 'node:fs';
import { loadData, WARMUP_BARS } from '../src/core/arena';
import { WIDE_MARKETS } from '../src/core/engine';
import type { Candle } from '../src/core/types';

/**
 * SWEEP — a wide, fast search beyond grids on real prices:  npm run sweep  (or: npm run sweep -- 200)
 *
 * Trend-following (long-only, or long AND short), and buy/short-and-hold, over many parameter sets, on
 * the same 9 days of real 1-minute prices as the optimizer. Walk-forward: the first 7 days rank, the last
 * 2 unseen days check. Market orders (taker fee) in and out; a position is liquidated if it moves 1/leverage
 * against it.
 */

const capital = Number(process.argv[2]) || 200;
const TUNE_DAYS = 7;
const TEST_DAYS = 2;
const FEE = 0.0005;
const EVAL = 15; // decide every 15 minutes

interface Params {
  family: 'trend' | 'hold' | 'grid';
  /** grid: step between levels, levels per side, and whether it also sells above the centre (neutral). */
  step?: number;
  levels?: number;
  shorts: boolean; // trend: also short downtrends; hold: short instead of long
  slow: number; // bars for the trend window
  band: number; // |trend| above this = trend
  exit: 'opposite' | 'chop'; // close when the trend flips, or as soon as it stops trending
  lev: number;
  stop: number; // 0 = none, else fraction adverse move that closes the position
}

function ema(c: Candle[], n: number): Float64Array {
  const out = new Float64Array(c.length);
  const k = 2 / (n + 1);
  out[0] = c[0].c;
  for (let i = 1; i < c.length; i++) out[i] = c[i].c * k + out[i - 1] * (1 - k);
  return out;
}

/** Per coin: 1 = up, -1 = down, 0 = chop, at each bar (same rules as core/regime, computed incrementally). */
function regimes(c: Candle[], slow: number, band: number): Int8Array {
  const fast = ema(c, 30);
  const slowE = ema(c, slow / 2);
  const vol = new Float64Array(c.length + 1);
  for (let i = 0; i < c.length; i++) vol[i + 1] = vol[i] + c[i].v;
  const r = new Int8Array(c.length);
  for (let i = slow + 1; i < c.length; i++) {
    const trend = c[i].c / c[i - slow].c - 1;
    const slope = fast[i] / slowE[i] - 1;
    const hourVol = vol[i + 1] - vol[i - 59];
    const avgHour = ((vol[i + 1] - vol[i - slow]) / (slow + 1)) * 60;
    const lastHour = c[i].c / c[i - 59].o - 1;
    if ((trend < -band && slope < 0) || (lastHour < -band / 2 && avgHour > 0 && hourVol / avgHour > 2)) r[i] = -1;
    else if (trend > band && slope > 0) r[i] = 1;
  }
  return r;
}

function run(p: Params, data: Record<string, Candle[]>, symbols: string[], len: number, cache: Map<string, Int8Array>) {
  const slice = capital / symbols.length;
  const equity: { t: number; v: number }[] = [];
  let trades = 0;
  if (p.family === 'grid') {
    const per = symbols.map(() => new Float64Array(len));
    symbols.forEach((sym, j) => (trades += runGrid(p, data[sym], slice, WARMUP_BARS, len, (i, v) => (per[j][i] = v))));
    for (let i = WARMUP_BARS; i < len; i++)
      if ((i - WARMUP_BARS) % 30 === 0 || i === len - 1) equity.push({ t: data[symbols[0]][i].t, v: per.reduce((a, arr) => a + arr[i], 0) });
    return summarize(equity, trades);
  }
  const st = symbols.map(() => ({ side: 0, entry: 0, cash: slice }));
  const value = (j: number, px: number) => {
    const s = st[j];
    return s.side === 0 ? s.cash : Math.max(0, s.cash + s.cash * p.lev * s.side * (px / s.entry - 1));
  };
  const close = (j: number, px: number) => {
    const s = st[j];
    s.cash = Math.max(0, value(j, px) - s.cash * p.lev * FEE);
    s.side = 0;
    trades++;
  };
  const open = (j: number, side: number, px: number) => {
    const s = st[j];
    if (s.cash <= 0) return;
    s.cash -= s.cash * p.lev * FEE;
    s.side = side;
    s.entry = px;
  };
  for (let i = WARMUP_BARS; i < len; i++) {
    symbols.forEach((sym, j) => {
      const k = data[sym][i];
      const s = st[j];
      if (s.side !== 0) {
        // Liquidation / stop, using the bar's extreme against the position.
        const worst = s.side > 0 ? k.l : k.h;
        const adverse = s.side * (1 - worst / s.entry);
        if (adverse >= 1 / p.lev) {
          s.cash = 0;
          s.side = 0;
          trades++;
          return;
        }
        if (p.stop > 0 && adverse >= p.stop) {
          close(j, s.entry * (1 - s.side * p.stop));
          return;
        }
      }
      if (p.family === 'hold') {
        if (i === WARMUP_BARS) open(j, p.shorts ? -1 : 1, k.c);
        return;
      }
      if ((i - WARMUP_BARS) % EVAL !== 0) return;
      const key = `${sym}|${p.slow}|${p.band}`;
      let r = cache.get(key);
      if (!r) cache.set(key, (r = regimes(data[sym], p.slow, p.band)));
      const g = r[i];
      if (s.side !== 0) {
        const flip = g === -s.side;
        if (flip || (p.exit === 'chop' && g === 0)) close(j, k.c);
      }
      if (s.side === 0 && g !== 0 && (g > 0 || p.shorts)) open(j, g, k.c);
    });
    if ((i - WARMUP_BARS) % 30 === 0 || i === len - 1)
      equity.push({ t: data[symbols[0]][i].t, v: symbols.reduce((a, sym, j) => a + value(j, data[sym][i].c), 0) });
  }
  return summarize(equity, trades);
}

function summarize(equity: { t: number; v: number }[], trades: number) {
  const end = equity[equity.length - 1];
  const cut = end.t - TEST_DAYS * 86_400_000;
  const atCut = [...equity].reverse().find((e) => e.t <= cut) ?? equity[0];
  let peak = capital;
  let dd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.v);
    dd = Math.max(dd, 1 - e.v / peak);
  }
  return { tune: atCut.v - capital, test: end.v - atCut.v, total: end.v - capital, dd, trades };
}

/**
 * Fixed grid on one coin, filled at its level prices along each bar's likely path (open → extreme → extreme →
 * close). Long grid: buys below the centre, each sold one step up. Neutral grid: also sells above the centre,
 * each bought back one step down. Position target = -(levels crossed from the centre), clamped to the ladder;
 * leaving the ladder by one more step closes everything at market (taker) and re-centres.
 */
function runGrid(p: Params, c: Candle[], slice: number, from: number, len: number, onBar: (i: number, v: number) => void) {
  const step = p.step!;
  const N = p.levels!;
  let cash = slice;
  let center = c[from].c;
  let pos = 0; // in levels: + long, - short
  let qty = (slice * p.lev) / N / center; // coins per level
  let trades = 0;
  let dead = false;
  const levelPrice = (k: number) => center * (1 + k * step);
  const target = (px: number) => {
    const k = Math.floor((px - center) / (center * step) + 1e-9); // levels above (k>0) or below (k<0) the centre
    const t = k < 0 ? Math.min(N, -k) : p.shorts ? -Math.min(N, k) : 0;
    return t;
  };
  const markValue = (px: number) => cash + pos * qty * px;
  // Cash holds the margin plus realised P&L; the open position is valued by marking pos × qty against cash
  // spent, so keep cash as "equity minus position value".
  cash = slice; // equity
  let posCost = 0; // cash paid for the open position (negative for shorts)
  const equityAt = (px: number) => cash - posCost + pos * qty * px;
  void markValue;
  const fill = (to: number, px: number) => {
    const d = to - pos;
    if (d === 0) return;
    posCost += d * qty * px;
    cash -= Math.abs(d) * qty * px * 0.0002; // maker
    pos = to;
    trades += Math.abs(d);
  };
  for (let i = from; i < len; i++) {
    const k = c[i];
    const path = k.c < k.o ? [k.o, k.h, k.l, k.c] : [k.o, k.l, k.h, k.c];
    for (let j = 1; j < path.length && !dead; j++) {
      const a = path[j - 1];
      const b = path[j];
      // Walk level by level so fills happen at level prices.
      const dir = Math.sign(b - a);
      if (!dir) continue;
      let x = a;
      while (dir > 0 ? x < b : x > b) {
        const kNow = Math.floor((x - center) / (center * step) + 1e-9);
        const next = levelPrice(dir > 0 ? kNow + 1 : kNow);
        const nx = dir > 0 ? Math.min(b, next) : Math.max(b, next === x ? levelPrice(kNow - 1) : next);
        if (nx === x) break;
        x = nx;
        fill(target(x), x);
        // Out of the ladder by one more step: stop out at market and re-centre.
        if (Math.abs(x - center) >= center * step * (N + 1)) {
          cash -= Math.abs(pos) * qty * x * 0.0005;
          cash = equityAt(x);
          posCost = 0;
          pos = 0;
          trades++;
          center = x;
          qty = (Math.max(0, cash) * p.lev) / N / center;
          if (cash <= slice * 0.05) dead = true;
        }
      }
    }
    // Liquidation check on isolated margin: equity of this coin can't fall below zero.
    if (equityAt(k.c) <= 0) {
      dead = true;
      cash = 0;
      posCost = 0;
      pos = 0;
    }
    onBar(i, dead ? Math.max(0, cash) : equityAt(k.c));
  }
  return trades;
}

function name(p: Params) {
  if (p.family === 'grid') return `GRID ${p.shorts ? 'NEUTRAL' : 'long'} ${p.lev}x · step ${(p.step! * 100).toFixed(2)}% · ${p.levels} levels/side`;
  if (p.family === 'hold') return `HOLD ${p.shorts ? 'SHORT' : 'LONG'} ${p.lev}x${p.stop ? ` stop ${p.stop * 100}%` : ''}`;
  return `TREND ${p.shorts ? 'long+short' : 'long'} ${p.lev}x · ${p.slow / 60}h · band ${(p.band * 100).toFixed(1)}% · exit ${p.exit}${p.stop ? ` · stop ${p.stop * 100}%` : ''}`;
}

async function main() {
  const probe = await fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1').catch(() => null);
  if (!probe?.ok) {
    console.error('✕ Binance prices unreachable from this computer');
    process.exit(1);
  }
  const loaded = await loadData(WIDE_MARKETS, WARMUP_BARS + (TUNE_DAYS + TEST_DAYS) * 1440, 'real', (p) => console.log(`  ${p.text}`));
  if (loaded.source !== 'real') {
    console.error('✕ download failed');
    process.exit(1);
  }
  const { data, symbols } = loaded;
  const len = Math.min(...symbols.map((s) => data[s].length));
  const all: Params[] = [];
  for (const lev of [1, 2, 3, 5])
    for (const stop of [0, 0.03]) {
      all.push({ family: 'hold', shorts: false, slow: 0, band: 0, exit: 'opposite', lev, stop });
      all.push({ family: 'hold', shorts: true, slow: 0, band: 0, exit: 'opposite', lev, stop });
      for (const shorts of [false, true])
        for (const slow of [120, 240, 480])
          for (const band of [0.008, 0.015, 0.025])
            for (const exit of ['opposite', 'chop'] as const) all.push({ family: 'trend', shorts, slow, band, exit, lev, stop });
    }
  for (const lev of [1, 2, 3, 5])
    for (const shorts of [false, true])
      for (const step of [0.0015, 0.003, 0.005, 0.008, 0.012])
        for (const levels of [4, 8, 12]) all.push({ family: 'grid', shorts, slow: 0, band: 0, exit: 'opposite', lev, stop: 0, step, levels });
  const cache = new Map<string, Int8Array>();
  const rows = all.map((p) => ({ name: name(p), ...run(p, data, symbols, len, cache) }));
  const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`.padStart(9);
  const ranked = [...rows].sort((a, b) => b.tune - a.tune);
  const line = (x: (typeof rows)[number]) =>
    `${x.name.padEnd(62)} ${money(x.tune)} ${money(x.test)} ${money(x.test / TEST_DAYS)} ${money(x.total)} ${`${(x.dd * 100).toFixed(1)}%`.padStart(7)} ${String(x.trades).padStart(6)}`;
  const head = `${'setting'.padEnd(62)} ${'tune 7d'.padStart(9)} ${'TEST 2d'.padStart(9)} ${'/day'.padStart(9)} ${'total'.padStart(9)} ${'drop'.padStart(7)} ${'trades'.padStart(6)}`;
  const both = rows.filter((x) => x.tune > 0 && x.test > 0).sort((a, b) => b.total - a.total);
  const tenADay = rows.filter((x) => x.test / TEST_DAYS >= 10 && x.tune > 0);
  const report = [
    `real Binance 1m prices · ${symbols.length} coins · $${capital} · ${rows.length} settings`,
    '',
    'TOP 20 by the 7 tune days (then look at the unseen 2 days):',
    head,
    ...ranked.slice(0, 20).map(line),
    '',
    `Positive in BOTH the tune week and the unseen days: ${both.length}`,
    ...both.slice(0, 15).map(line),
    '',
    `Made ≥ $10/day on the unseen days AND was positive in the tune week: ${tenADay.length}`,
    ...tenADay.map(line),
  ].join('\n');
  console.log(`\n${report}`);
  writeFileSync('sweep-report.txt', report);
}

main().catch((e) => {
  console.error('✕', (e as Error).message);
  process.exit(1);
});
