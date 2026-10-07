import { writeFileSync } from 'node:fs';
import { type Bars, label, type P, prices, simGrid, simPos, WEEK } from './hunt';

/**
 * COMBO — the grid and "buy the panic" (mean reversion) side by side, on all coins or on the coins picked each
 * week, over the 16 real weeks hunt downloaded:  npm run combo -- 1000
 *
 * Coin pick: at the start of each week, rank coins by how much they moved up and down LAST week compared with
 * where they ended (choppy = good for a grid), and keep the top K. Only past prices are used for the pick.
 * The mean-reversion setting came from hunt's 8 recent weeks, so the 8 older weeks are unseen for it.
 */

const capital = Number(process.argv[2]) || 1000;
const OUT = process.env.COMBO_OUT || 'combo-report.txt';

const GRID = (step: number): P => ({ family: 'grid', side: 'long', lev: 5, step, levels: 8, win: 480, k: 0, stop: 0 });
const MR = (lev: number): P => ({ family: 'meanrev', side: 'long', lev, step: 0, levels: 0, win: 480, k: 3.6, stop: 0.08 });

/** Hourly path length ÷ net move over [from, to): high = choppy (good for a grid), low = trending. */
function chop(b: Bars, from: number, to: number): number {
  let path = 0;
  for (let i = from + 60; i < to; i += 60) path += Math.abs(b.c[i] / b.c[i - 60] - 1);
  const net = Math.abs(b.c[to - 1] / b.c[from] - 1);
  return path / Math.max(net, 0.005);
}
/** Hourly path length alone: how much the coin moves. */
function move(b: Bars, from: number, to: number): number {
  let path = 0;
  for (let i = from + 60; i < to; i += 60) path += Math.abs(b.c[i] / b.c[i - 60] - 1);
  return path;
}

interface Mix {
  name: string;
  grid?: P;
  mr?: P;
  /** Share of the money in the grid (rest in mean reversion). */
  gridShare: number;
  pick: 'all' | 'chop' | 'move' | 'splitTop' | 'splitBottom';
  k: number;
}

async function main() {
  const { symbols, data } = await prices();
  const LEN = data[0].c.length;
  const weeks = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]; // oldest → newest
  const range = (w: number): [number, number] => [LEN - (w + 1) * WEEK, LEN - w * WEEK];
  const day = (i: number) => new Date(data[0].t[i]).toISOString().slice(5, 10);

  const mixes: Mix[] = [];
  for (const step of [0.012, 0.02])
    for (const pick of ['all', 'chop', 'move'] as const)
      for (const k of pick === 'all' ? [symbols.length] : [5, 8, 10]) {
        const tag = pick === 'all' ? 'all 15 coins' : `top ${k} ${pick === 'chop' ? 'choppy' : 'moving'} coins`;
        mixes.push({ name: `GRID ${step * 100}% only · ${tag}`, grid: GRID(step), gridShare: 1, pick, k });
        for (const lev of [3, 5])
          for (const share of [0.5, 0.7])
            mixes.push({ name: `GRID ${step * 100}% ${share * 100}% + PANIC ${lev}x ${100 - share * 100}% · ${tag}`, grid: GRID(step), mr: MR(lev), gridShare: share, pick, k });
      }
  for (const lev of [3, 5]) mixes.push({ name: `PANIC ${lev}x only · all 15 coins`, mr: MR(lev), gridShare: 0, pick: 'all', k: symbols.length });
  // Separate coins: on Binance one coin has one position, so grid and panic can't share a coin live.
  // Coins ranked by last week's movement; panic takes the top `k`, grid the rest (or the reverse).
  for (const step of [0.012, 0.02])
    for (const lev of [3, 5])
      for (const k of [5, 7, 10])
        for (const panicTop of [true, false])
          mixes.push({
            name: `SPLIT grid ${step * 100}% + PANIC ${lev}x · panic on ${panicTop ? 'top' : 'bottom'} ${k} moving, grid rest`,
            grid: GRID(step),
            mr: MR(lev),
            gridShare: 0.5,
            pick: panicTop ? 'splitTop' : 'splitBottom',
            k,
          });

  const rows = mixes.map((m) => {
    let worstDrop = 0;
    const pnl = weeks.map((w) => {
      const [from, to] = range(w);
      const idx = symbols.map((_, j) => j);
      const chosen =
        m.pick === 'all' || m.pick === 'splitTop' || m.pick === 'splitBottom'
          ? idx
          : idx
              .map((j) => ({ j, s: m.pick === 'chop' ? chop(data[j], Math.max(0, from - WEEK), from) : move(data[j], Math.max(0, from - WEEK), from) }))
              .sort((a, b) => b.s - a.s)
              .slice(0, m.k)
              .map((x) => x.j);
      let end = 0;
      let lows = 0;
      if (m.pick === 'splitTop' || m.pick === 'splitBottom') {
        const order = idx.map((j) => ({ j, s: move(data[j], Math.max(0, from - WEEK), from) })).sort((a, b) => b.s - a.s).map((x) => x.j);
        const panic = m.pick === 'splitTop' ? order.slice(0, m.k) : order.slice(-m.k);
        const grid = order.filter((j) => !panic.includes(j));
        for (const j of grid) {
          const [e, l] = simGrid(m.grid!, data[j], j, from, to, (capital * m.gridShare) / grid.length);
          end += e;
          lows += l;
        }
        for (const j of panic) {
          const [e, l] = simPos(m.mr!, data[j], j, from, to, (capital * (1 - m.gridShare)) / panic.length);
          end += e;
          lows += l;
        }
        worstDrop = Math.max(worstDrop, 1 - lows / capital);
        return end - capital;
      }
      for (const j of chosen) {
        if (m.grid && m.gridShare > 0) {
          const [e, l] = simGrid(m.grid, data[j], j, from, to, (capital * m.gridShare) / chosen.length);
          end += e;
          lows += l;
        }
        if (m.mr && m.gridShare < 1) {
          const [e, l] = simPos(m.mr, data[j], j, from, to, (capital * (1 - m.gridShare)) / chosen.length);
          end += e;
          lows += l;
        }
      }
      worstDrop = Math.max(worstDrop, 1 - lows / capital);
      return end - capital;
    });
    return { name: m.name, pnl, worstDrop };
  });

  const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(0)}`.padStart(6);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const line = (r: (typeof rows)[number]) =>
    `${r.name.padEnd(62)} ${r.pnl.map(money).join('')} │ avg ${money(avg(r.pnl))}/wk (${money(avg(r.pnl) / 7)}/day) · older 8 ${money(avg(r.pnl.slice(0, 8)))} · newer 8 ${money(avg(r.pnl.slice(8)))} · worst ${money(Math.min(...r.pnl))} · green ${r.pnl.filter((x) => x > 0).length}/16 · drop ${(r.worstDrop * 100).toFixed(0)}%`;
  const ranked = [...rows].sort((a, b) => avg(b.pnl) + 0.5 * Math.min(...b.pnl) - (avg(a.pnl) + 0.5 * Math.min(...a.pnl)));
  const report = [
    `COMBO · real Binance 1m · ${symbols.length} coins · $${capital} each week · 16 weeks ${day(range(15)[0])} → ${day(range(0)[1] - 1)} (oldest → newest)`,
    `PANIC = ${label(MR(5)).replace('5x', 'Nx')} — its setting came from the newer 8 weeks; the older 8 are unseen for it.`,
    'Ranked by average week + half the worst week (steady beats lucky):',
    '',
    ...ranked.map(line),
  ].join('\n');
  console.log(report);
  writeFileSync(OUT, report);
}

main().catch((e) => {
  console.error('✕', (e as Error).message);
  process.exit(1);
});
