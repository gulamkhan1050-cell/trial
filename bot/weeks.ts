import './nodeStorage';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { simulate, WARMUP_BARS, type Contestant, type Loaded } from '../src/core/arena';
import { DEFAULT_SETTINGS, type Settings, WIDE_MARKETS } from '../src/core/engine';
import type { Candle } from '../src/core/types';
import { name, runGrid, type Params } from './sweep';

/**
 * WEEKS — replay settings on each of the last N real weeks, one week at a time:  npm run weeks -- 500 8
 *
 * A setting that made money on one week can be luck; this shows every week side by side. Runs the engine's
 * grid (the setting that once made +23% in the Arena, and the current live one) and a wide family of fixed
 * long / neutral grids. Prices are cached in weeks-cache.json so a re-run doesn't re-download.
 */

const capital = Number(process.argv[2]) || 500;
const WEEKS = Number(process.argv[3]) || 8;
const WEEK = 7 * 1440;
const CACHE = process.env.WEEKS_CACHE || 'weeks-cache.json';
const ENGINE = !process.env.WEEKS_NO_ENGINE;

async function download(symbol: string, bars: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end: number | undefined;
  while (out.length < bars + 1) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000${end ? `&endTime=${end}` : ''}`;
    let res: Response | null = null;
    for (let a = 0; a < 4 && !res?.ok; a++) res = await fetch(url).catch(() => null);
    if (!res?.ok) throw new Error(`${symbol}: HTTP ${res?.status ?? 'no connection'}`);
    const rows = (await res.json()) as [number, string, string, string, string, string, number, string][];
    if (!rows.length) break;
    out.unshift(...rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })));
    end = rows[0][0] - 1;
  }
  return out.slice(0, -1).slice(-bars);
}

async function prices(): Promise<{ data: Record<string, Candle[]>; symbols: string[] }> {
  const bars = WARMUP_BARS + WEEKS * WEEK;
  if (existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, 'utf8')) as { data: Record<string, Candle[]>; symbols: string[] };
    if (c.symbols.every((s) => c.data[s].length >= bars)) return c;
  }
  const data: Record<string, Candle[]> = {};
  const symbols: string[] = [];
  for (const [i, s] of WIDE_MARKETS.entries()) {
    console.log(`  downloading ${s} (${i + 1}/${WIDE_MARKETS.length})`);
    try {
      const c = await download(s, bars);
      if (c.length < bars) throw new Error(`only ${c.length} bars`);
      data[s] = c;
      symbols.push(s);
    } catch (e) {
      console.log(`  skipped ${s}: ${(e as Error).message}`);
    }
  }
  const len = Math.min(...symbols.map((s) => data[s].length));
  for (const s of symbols) data[s] = data[s].slice(-len);
  writeFileSync(CACHE, JSON.stringify({ data, symbols }));
  return { data, symbols };
}

const day = (t: number) => new Date(t).toISOString().slice(5, 10);

async function main() {
  const { data, symbols } = await prices();
  const len = data[symbols[0]].length;
  // Week w = 0 is the most recent. Each window carries its own warm-up bars before the week.
  const windows = Array.from({ length: WEEKS }, (_, w) => {
    const end = len - w * WEEK;
    const from = end - WEEK - WARMUP_BARS;
    const d: Record<string, Candle[]> = {};
    for (const s of symbols) d[s] = data[s].slice(from, end);
    return { label: `${day(d[symbols[0]][WARMUP_BARS].t)}→${day(d[symbols[0]][d[symbols[0]].length - 1].t)}`, data: d };
  }).reverse();
  console.log(`$${capital} · ${symbols.length} coins · weeks: ${windows.map((w) => w.label).join(', ')}`);

  const rows: { name: string; weeks: number[]; dd: number[] }[] = [];

  // Fixed grids: fast, so a wide family.
  const fixed: Params[] = [];
  for (const lev of [2, 3, 5, 8])
    for (const shorts of [false, true])
      for (const step of [0.005, 0.008, 0.012, 0.016, 0.02, 0.025])
        for (const levels of [4, 8, 12, 16]) fixed.push({ family: 'grid', shorts, slow: 0, band: 0, exit: 'opposite', lev, stop: 0, step, levels });
  for (const p of fixed) {
    const weeks: number[] = [];
    const dd: number[] = [];
    for (const w of windows) {
      const slice = capital / symbols.length;
      const per = symbols.map(() => new Float64Array(WARMUP_BARS + WEEK));
      symbols.forEach((s, j) => runGrid(p, w.data[s], slice, WARMUP_BARS, WARMUP_BARS + WEEK, (i, v) => (per[j][i] = v)));
      let peak = capital;
      let worst = 0;
      let v = capital;
      for (let i = WARMUP_BARS; i < WARMUP_BARS + WEEK; i += 30) {
        v = per.reduce((a, arr) => a + arr[i], 0);
        peak = Math.max(peak, v);
        worst = Math.max(worst, 1 - v / peak);
      }
      v = per.reduce((a, arr) => a + arr[WARMUP_BARS + WEEK - 1], 0);
      weeks.push(v - capital);
      dd.push(worst);
    }
    rows.push({ name: name(p), weeks, dd });
  }

  // The engine's own grid (what the app trades), thorough FORGE as in the +23% Arena run.
  if (ENGINE) {
    const base: Settings = { ...DEFAULT_SETTINGS, startBalance: capital, feed: 'sim', strategy: 'grid', interval: '1m', symbols };
    const g = { ...base.grid, crashGuard: true, crashDrop: 0.025, crashBars: 30, crashShare: 0.67, classicTp: true, regime: false };
    const contestants: Contestant[] = [
      { name: 'ENGINE grid 5x · the +23% Arena setting', patch: { strategy: 'grid', grid: { ...g, leverage: 5 } } },
      { name: 'ENGINE grid 3x · live now (restart at +6.7%)', patch: { strategy: 'grid', grid: { ...g, leverage: 3, dailyTarget: Math.round(capital * (20 / 300)), afterTarget: 'restart' } } },
    ];
    const eng = contestants.map((c) => ({ name: c.name, weeks: [] as number[], dd: [] as number[] }));
    for (const [k, w] of windows.entries()) {
      console.log(`  engine week ${k + 1}/${windows.length} ${w.label}`);
      const loaded: Loaded = { data: w.data, symbols, source: 'real', note: '' };
      const out = await simulate(loaded, { symbols, days: 7, source: 'real', base, contestants, forgeMode: 'thorough' }, 0);
      out.results.forEach((r, j) => {
        eng[j].weeks.push(r.final - r.start);
        eng[j].dd.push(r.maxDrawdown);
      });
    }
    rows.push(...eng);
  }

  const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(0)}`.padStart(6);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const line = (r: (typeof rows)[number]) =>
    `${r.name.padEnd(56)} ${r.weeks.map(money).join(' ')} │ ${money(sum(r.weeks) / r.weeks.length)} ${money(Math.min(...r.weeks))} ${String(r.weeks.filter((x) => x > 0).length).padStart(2)}/${r.weeks.length} ${`${(Math.max(...r.dd) * 100).toFixed(0)}%`.padStart(5)}`;
  const head = `${'setting'.padEnd(56)} ${windows.map((w, i) => `wk${i + 1}`.padStart(6)).join(' ')} │ ${'avg'.padStart(6)} ${'worst'.padStart(6)} green  drop`;
  const byAvg = [...rows].sort((a, b) => sum(b.weeks) - sum(a.weeks));
  const steady = rows.filter((r) => r.weeks.every((x) => x > 0)).sort((a, b) => Math.min(...b.weeks) - Math.min(...a.weeks));
  const best = Math.max(...rows.flatMap((r) => r.weeks));
  const fortyPct = rows.filter((r) => sum(r.weeks) / r.weeks.length >= capital * 0.4);
  const report = [
    `real Binance 1m prices · ${symbols.length} coins · $${capital} · ${rows.length} settings · ${WEEKS} separate weeks`,
    windows.map((w, i) => `wk${i + 1} = ${w.label}`).join('  '),
    '',
    'ENGINE (what the app trades):',
    head,
    ...rows.filter((r) => r.name.startsWith('ENGINE')).map(line),
    '',
    'TOP 25 by average week:',
    head,
    ...byAvg.slice(0, 25).map(line),
    '',
    `Green EVERY week: ${steady.length}`,
    ...steady.slice(0, 15).map(line),
    '',
    `Best single week of any setting: ${money(best)} · settings averaging ≥ 40%/week ($${capital * 0.4}): ${fortyPct.length}`,
  ].join('\n');
  console.log(`\n${report}`);
  writeFileSync('weeks-report.txt', report);
}

main().catch((e) => {
  console.error('✕', (e as Error).message);
  process.exit(1);
});
