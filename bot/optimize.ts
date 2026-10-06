import './nodeStorage'; // gives src/ a localStorage (unused here, but some modules touch it)
import { writeFileSync } from 'node:fs';
import { runArena, type ArenaResult, type Contestant } from '../src/core/arena';
import { DEFAULT_SETTINGS, type Settings, WIDE_MARKETS } from '../src/core/engine';

/**
 * OPTIMIZER — run on a computer that can reach Binance:  npm run optimize  (or: npm run optimize -- 200)
 *
 * Downloads the last 9 days of real 1-minute prices for the 15 coins, replays the CURRENT live setting
 * and 24 alternatives on the same prices, and ranks them walk-forward: the first 7 days choose
 * ("tune"), the last 2 days — which no ranking looked at — check ("test"). A setting that only wins
 * on the days it was picked on is luck; one that also wins the unseen days is worth trading.
 */

const capital = Number(process.argv[2]) || 200;
const TUNE_DAYS = 7;
const TEST_DAYS = 2;
/** OPT_SMOKE=1: 3 coins on simulated prices, just to check the optimizer itself runs. */
const SMOKE = !!process.env.OPT_SMOKE;

const base: Settings = { ...DEFAULT_SETTINGS, startBalance: capital, feed: 'sim', strategy: 'grid', interval: '1m', symbols: WIDE_MARKETS };
const guard = { crashGuard: true, crashDrop: 0.025, crashBars: 30, crashShare: 0.67 };
// Take profit & restart at ~6.7% of capital, as live.
const restart = { dailyTarget: Math.round(capital * (20 / 300)), afterTarget: 'restart' as const };

function c(name: string, g: Partial<Settings['grid']>): Contestant {
  return { name, patch: { strategy: 'grid', grid: { ...base.grid, ...guard, ...restart, slices: undefined, maxSpacing: undefined, ...g } } };
}

const contestants: Contestant[] = [c('CURRENT live · 5x classic · 8 slices', { leverage: 5, classicTp: true, regime: false, slices: 8 })];
for (const lev of [2, 3, 5])
  for (const regime of [false, true])
    for (const classicTp of [true, false])
      for (const slices of [8, 15])
        contestants.push(
          c(`${lev}x · ${classicTp ? 'classic' : 'smart'} TP · regime ${regime ? 'on' : 'off'} · ${slices} slices`, { leverage: lev, classicTp, regime, slices }),
        );

function split(r: ArenaResult) {
  const pts = r.equity;
  const end = pts[pts.length - 1];
  const cut = end.t - TEST_DAYS * 86_400_000;
  const atCut = [...pts].reverse().find((p) => p.t <= cut) ?? pts[0];
  let peak = r.start;
  let dd = 0;
  for (const p of pts) {
    peak = Math.max(peak, p.v);
    dd = Math.max(dd, 1 - p.v / peak);
  }
  return { tune: atCut.v - r.start, test: end.v - atCut.v, total: end.v - r.start, dd };
}

async function main() {
  let lastPct = -1;
  console.log(`Optimizer · $${capital} · ${contestants.length} settings · ${TUNE_DAYS} tune days + ${TEST_DAYS} test days of real Binance prices`);
  const out = await runArena({
    symbols: SMOKE ? WIDE_MARKETS.slice(0, 3) : WIDE_MARKETS,
    days: TUNE_DAYS + TEST_DAYS,
    source: SMOKE ? 'sim' : 'real',
    base,
    contestants,
    forgeMode: 'fast',
    onProgress: (p) => {
      const pct = Math.floor(p.pct * 20) * 5;
      if (p.stage === 'download' || pct !== lastPct) {
        lastPct = pct;
        console.log(`  ${p.stage} ${p.stage === 'download' ? '' : `${pct}% `}${p.text}`);
      }
    },
  });
  if (out.source !== 'real' && !SMOKE) {
    console.error('✕ Binance prices unreachable from this computer — run it where the bot runs.');
    process.exit(1);
  }

  const rows = out.results.map((r) => ({ name: r.name, trades: r.trades, ...split(r) }));
  const money = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`.padStart(9);
  const ranked = [...rows].sort((a, b) => b.tune - a.tune);
  const lines = [
    `${out.note}`,
    '',
    'RANK by the 7 tune days → then the 2 UNSEEN test days decide',
    `${'setting'.padEnd(44)} ${'tune 7d'.padStart(9)} ${'TEST 2d'.padStart(9)} ${'per day'.padStart(9)} ${'total'.padStart(9)} ${'worst drop'.padStart(10)} ${'trades'.padStart(7)}`,
    ...ranked.map(
      (x) =>
        `${x.name.padEnd(44)} ${money(x.tune)} ${money(x.test)} ${money(x.test / TEST_DAYS)} ${money(x.total)} ${`${(x.dd * 100).toFixed(1)}%`.padStart(10)} ${String(x.trades).padStart(7)}`,
    ),
    '',
  ];
  // Recommendation: among the top third by tune, the best on the unseen days with a bearable worst drop.
  const pool = ranked.slice(0, Math.max(3, Math.ceil(ranked.length / 3))).filter((x) => x.dd < 0.25);
  const pick = [...pool].sort((a, b) => b.test - a.test)[0];
  const current = rows[0];
  lines.push(`CURRENT live setting: tune ${money(current.tune)} · unseen 2 days ${money(current.test)} · worst drop ${(current.dd * 100).toFixed(1)}%`);
  if (pick && pick.test > 0)
    lines.push(`PICK: ${pick.name} — tune ${money(pick.tune)}, unseen 2 days ${money(pick.test)} (${money(pick.test / TEST_DAYS)}/day), worst drop ${(pick.dd * 100).toFixed(1)}%`);
  else lines.push('PICK: none of the top settings made money on the unseen 2 days — the market, not the setting, is the problem right now.');
  const report = lines.join('\n');
  console.log(`\n${report}`);
  writeFileSync('optimize-report.txt', report);
  console.log('\nSaved optimize-report.txt — send it (or a screenshot of the table) back.');
}

main().catch((e) => {
  console.error('✕', (e as Error).message);
  process.exit(1);
});
