import { flushStorage, STATE_FILE } from './nodeStorage'; // must come first: gives src/ a localStorage
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_SETTINGS, Engine, MEGA_MARKETS, WIDE_MARKETS, type Settings } from '../src/core/engine';
import type { LogEntry } from '../src/core/types';
import { BinanceFutures, type Network } from '../src/exchange/binance';
import { DEFAULT_LIVE_SETTINGS, LiveController, type LiveSettings } from '../src/exchange/liveController';
import { DEFAULT_LIVE, LiveGrid } from '../src/exchange/liveGrid';

/**
 * Headless live grid — the same engine and LiveGrid as the app, without a screen, so it can run for
 * days in Termux on a phone (or any small server). Ctrl+C stops the bot but leaves its orders and
 * positions on Binance; the next start picks them back up. `--kill` closes everything.
 *
 * Exit codes (run-bot.sh restarts on anything else): 0 = stopped by you, 3 = kill switch / loss limit.
 */

const CONFIG_FILE = process.env.BOT_CONFIG ?? 'bot.config.json';
const args = new Set(process.argv.slice(2));

async function main() {
  if (typeof WebSocket === 'undefined') fail('Node 22 or newer is needed (for WebSocket). In Termux: pkg upgrade nodejs');
  (globalThis as { crypto?: unknown }).crypto ??= webcrypto;

  const s = await config();
  const universe = [...new Set([...WIDE_MARKETS, ...MEGA_MARKETS])];

  if (args.has('--kill')) return killAll(s, universe);

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    feed: 'binance',
    strategy: 'grid',
    interval: '1m',
    symbols: WIDE_MARKETS,
    grid: { ...DEFAULT_SETTINGS.grid, leverage: s.leverage },
  };
  const engine = new Engine(settings);
  const printed = new WeakSet<LogEntry>();
  for (const l of engine.log) printed.add(l); // don't replay the last session's log
  engine.onChange(() => {
    for (let i = engine.log.length - 1; i >= 0; i--) {
      const l = engine.log[i];
      if (printed.has(l)) continue;
      printed.add(l);
      // FORGE/SENTRY chatter is kept in the state file; the console shows trades and problems.
      if (l.text.includes('LIVE') || l.kind === 'warn') say(`${l.text}${l.pnl !== undefined ? `  ${money(l.pnl)}` : ''}`);
    }
  });

  say(`starting · ${s.network.toUpperCase()} · $${s.maxCapital} × ${s.leverage} · up to ${s.maxCoins} coins · loss limit ${(s.dailyLossLimit * 100).toFixed(0)}%`);
  say('downloading 15 coins of 1m history from Binance…');
  await engine.start();
  // Network trouble is worth retrying (run-bot.sh restarts on exit 1); rejected keys are not.
  if (engine.feedName !== 'Binance') fail('Binance market data is unreachable from this network', 1);

  const ctl = new LiveController(engine);
  await ctl.start(s);
  if (ctl.status !== 'running') fail(`could not start: ${ctl.message}`, /-1022|-201[45]|API-key|Signature/i.test(ctl.message) ? 2 : 1);

  const stop = (code: number, why: string) => {
    ctl.pause();
    engine.stop();
    flushStorage();
    say(why);
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0, 'stopped — orders and positions stay on Binance; run again to resume, or with --kill to close all'));
  process.on('SIGTERM', () => stop(1, 'terminated by the system — will resume on restart'));

  setInterval(() => {
    const live = ctl.live;
    if (!live) return;
    if (ctl.status === 'killed') {
      engine.stop();
      flushStorage();
      say('■ kill switch fired — everything closed. Check Binance, then start again when ready.');
      process.exit(3);
    }
    const coins = [...live.coins.values()].map((c) => `${c.symbol.replace('USDT', '')} ${c.levels.filter((l) => l.side === 'sell').length}/${c.levels.length}`);
    say(
      `wallet $${live.wallet.toFixed(2)} · since start ${money(live.wallet - live.startWallet)} · round trips ${live.roundTrips} · booked ${money(live.realized)} · ${coins.join('  ') || 'waiting for FORGE'}`,
    );
    engine.save();
  }, 60_000);
}

/** Close every order and position this bot holds, then exit. */
async function killAll(s: LiveSettings, universe: string[]) {
  const snapKey = `swarmdesk:live:${s.network}:${s.apiKey.slice(0, 8)}`;
  const snap = JSON.parse(localStorage.getItem(snapKey) ?? 'null');
  const live = new LiveGrid(
    new BinanceFutures(s.apiKey, s.apiSecret, s.network),
    { candidates: () => [], stressed: () => false, log: (_k, t) => say(t) },
    { ...DEFAULT_LIVE, maxCapital: s.maxCapital, leverage: s.leverage, maxCoins: s.maxCoins },
    universe,
  );
  await live.start(snap);
  await live.kill('--kill from the command line');
  localStorage.removeItem(snapKey);
  flushStorage();
  process.exit(3);
}

/** Settings from bot.config.json (asked for once, then saved with owner-only permissions). */
async function config(): Promise<LiveSettings> {
  if (existsSync(CONFIG_FILE)) return { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  if (!process.stdin.isTTY) fail(`${CONFIG_FILE} not found — run once in a terminal to create it`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string) => (await rl.question(`${q} [${def}]: `)).trim() || def;
  console.log('\nFirst run — Binance futures API key with ONLY "Enable Futures" (never withdrawals).\n');
  let network = (await ask('Network — just press Enter for demo, or type mainnet', 'demo')).toLowerCase() as Network;
  let pastedKey = '';
  if (network.length > 20) {
    // The API key pasted one question early: take it as the key, on demo.
    pastedKey = network;
    network = 'demo';
    console.log('  (that looks like the API key — using it, network demo)');
  }
  if (!['demo', 'mainnet', 'testnet'].includes(network)) fail('network must be demo or mainnet');
  const s: LiveSettings = {
    network,
    apiKey: pastedKey || (await ask('Paste the API KEY', '')),
    apiSecret: await ask('Paste the SECRET KEY', ''),
    maxCapital: +(await ask('Max capital USDT', '100')),
    leverage: +(await ask('Leverage', '3')),
    maxCoins: +(await ask('Max coins', '5')),
    dailyLossLimit: +(await ask('Loss limit (fraction of wallet, 0.1 = 10%)', '0.1')),
  };
  if (network === 'mainnet' && (await ask('REAL MONEY. Type YES to confirm', 'no')) !== 'YES') fail('cancelled');
  rl.close();
  if (!s.apiKey || !s.apiSecret) fail('API key and secret are required');
  const bal = await new BinanceFutures(s.apiKey, s.apiSecret, s.network).balance().catch((e) => fail(`keys rejected: ${(e as Error).message}`));
  say(`keys OK · futures wallet $${bal.wallet.toFixed(2)}`);
  writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
  say(`saved ${CONFIG_FILE} (delete it to change keys) · state is kept in ${STATE_FILE}`);
  return s;
}

function say(text: string) {
  console.log(`${new Date().toLocaleTimeString('en-GB')}  ${text}`);
}

function money(x: number) {
  return `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`;
}

function fail(msg: string, code = 2): never {
  console.error(`✕ ${msg}`);
  process.exit(code);
}

process.on('unhandledRejection', (e) => {
  console.error('✕ unexpected error:', e);
  try {
    flushStorage();
  } finally {
    process.exit(1);
  }
});

void main();
