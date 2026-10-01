import { DEFAULT_SENTRY } from '../agents/sentry';
import { DEFAULT_SETTINGS, MAJORS, MEGA_MARKETS, WIDE_MARKETS, type Engine, fmtPrice, type Settings, tpLabel } from '../core/engine';
import type { AgentId } from '../core/types';
import { barsChart, candleChart, lineChart } from './charts';
import { type LiveController, type LiveSettings, loadLiveSettings, saveLiveSettings } from '../exchange/liveController';
import { type ArenaProgress, type ArenaResult, gridVariants, runArenaRepeated } from '../core/arena';

type Tab = 'grid' | 'log' | 'arena' | 'setup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'grid', label: 'Live' },
  { id: 'log', label: 'Trades' },
  { id: 'arena', label: 'Arena' },
  { id: 'setup', label: 'Setup' },
];

const AGENT_META: Record<AgentId, { role: string; color: string }> = {
  SCOUT: { role: 'reads every bar', color: 'var(--scout)' },
  SENTRY: { role: 'last word before money', color: 'var(--sentry)' },
  HAWK: { role: 'the only one that trades', color: 'var(--hawk)' },
  FORGE: { role: 'evolves the strategies', color: 'var(--forge)' },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (x: number) => `${x >= 0 ? '+' : '-'}${usd(Math.abs(x))}`;
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
const cls = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const short = (s: string) => s.replace('USDT', '');

export class Dashboard {
  private tab: Tab = 'grid';
  private symbol: string;
  private frame = 0;
  private body!: HTMLElement;
  private arena: {
    running: boolean;
    progress: ArenaProgress | null;
    results: ArenaResult[] | null;
    note: string;
    error: string;
    signal: { cancelled: boolean };
    source: 'real' | 'sim';
    days: number;
    markets: number;
    thorough: boolean;
    leverage: number;
    variants: boolean;
    repeats: number;
  } = { repeats: 3, variants: true, running: false, progress: null, results: null, note: '', error: '', signal: { cancelled: false }, source: 'real', days: 7, markets: 15, leverage: 3, thorough: true };

  private liveSettings: LiveSettings = loadLiveSettings();
  /** Coin-picker (paper simulation) details on the Live tab: hidden unless asked for. */
  private pickerOpen = false;

  constructor(
    private root: HTMLElement,
    private engine: Engine,
    private liveCtl: LiveController | null = null,
  ) {
    this.symbol = engine.settings.symbols[0];
    try {
      const saved = localStorage.getItem('swarmdesk:tab') as Tab | null;
      if (saved && TABS.some((t) => t.id === saved)) this.tab = saved;
    } catch {
      /* ignore */
    }
    this.mount();
    engine.onChange(() => this.schedule());
    window.addEventListener('resize', () => this.schedule());
    setInterval(() => this.schedule(), 1000); // uptime clock
  }

  private mount() {
    this.root.innerHTML = `
      <header class="top">
        <div class="brand"><span class="logo">◆</span><div><b>SWARM DESK</b><small>SCOUT · SENTRY · HAWK · FORGE</small></div></div>
        <div class="status" id="status"></div>
      </header>
      <main id="body"></main>
      <nav class="tabs">${TABS.map((t) => `<button data-tab="${t.id}">${t.label}</button>`).join('')}</nav>`;
    this.body = this.root.querySelector('#body')!;
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onInput(e));
    this.renderTab(true);
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderTab(false);
    });
  }

  private renderTab(full: boolean) {
    this.root.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    this.renderStatus();
    // The setup form is rendered once per visit so typing is never interrupted.
    if (this.tab === 'setup') {
      if (full) this.body.innerHTML = this.setupView();
      this.renderLiveStatus();
      return;
    }
    // The arena form is also rendered once; only its results panel refreshes.
    if (this.tab === 'arena') {
      if (full) this.body.innerHTML = this.arenaView();
      this.renderArenaLive();
      return;
    }
    const html = this.tab === 'grid' ? this.gridView() : this.logView();
    this.body.innerHTML = html;
    this.drawCharts();
  }

  private renderStatus() {
    const e = this.engine;
    const up = e.running ? Math.floor((Date.now() - e.startedAt) / 1000) : 0;
    const hh = String(Math.floor(up / 3600)).padStart(2, '0');
    const mm = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
    const ss = String(up % 60).padStart(2, '0');
    const feed = e.feedStatus === 'live' ? 'LIVE DATA' : e.feedStatus === 'sim' ? 'SIMULATOR' : e.feedStatus === 'replay' ? 'REPLAY · REAL DATA' : e.feedStatus.toUpperCase();
    this.root.querySelector('#status')!.innerHTML = `
      <span class="pill ${e.feedStatus}">${feed}</span>
      <span class="pill">${e.barLabel().toUpperCase()} CANDLES</span>
      ${this.liveCtl?.status === 'running' ? `<span class="pill live-money">● LIVE $ · ${this.liveCtl.network === 'mainnet' ? 'REAL MONEY' : this.liveCtl.network === 'demo' ? 'DEMO' : 'TESTNET'}</span><button class="kill" data-act="live-kill">■ KILL</button>` : '<span class="pill paper">PAPER</span>'}
      <span class="mono dim">${hh}:${mm}:${ss}</span>
      <button class="run ${e.running ? 'on' : ''}" data-act="toggle">${e.running ? '■ STOP' : '▶ START'}</button>
      ${e.feedStatus === 'replay' || e.feedStatus === 'connecting' ? `<span class="feed-detail mono dim">${esc(e.feedDetail)}</span>` : ''}`;
  }

  private logList(n: number): string {
    const rows = this.engine.log.slice(0, n);
    if (!rows.length) return `<p class="empty">Press START — the agents will narrate every decision here.</p>`;
    return `<ul class="log">${rows
      .map(
        (l) => `<li class="${l.kind}"><span class="mono dim">${time(l.t)}</span><b style="color:${AGENT_META[l.agent].color}">${l.agent}</b>
          <span>${esc(l.text)}</span>${l.pnl !== undefined ? `<span class="mono ${cls(l.pnl)}">${signed(l.pnl)}</span>` : ''}</li>`,
      )
      .join('')}</ul>`;
  }

  // ------------------------------------------------------------ GRID

  private gridView(): string {
    const e = this.engine;
    if (!e.gridMode())
      return `<section class="card"><h3>Grid engine <span class="dim">off</span></h3>
        <p class="empty">The GRID micro-trader is off. Go to Setup and tap <b>▦ Grid micro-trading</b> to run it.</p></section>`;

    if (!e.grids.has(this.symbol)) this.symbol = e.settings.symbols[0];
    const sym = this.symbol;
    const g = e.grids.get(sym);
    const bot = g?.bot;
    const f = g?.forge;
    const c = f?.champion;
    const px = e.price(sym);
    const gridTrades = e.trades.filter((t) => t.reason.startsWith('grid'));
    const gridPnl = gridTrades.reduce((sum, t) => sum + t.pnl, 0);
    const tot = e.gridTotals();
    const open = [...e.grids.values()].reduce((sum, x) => sum + (x.bot ? x.bot.unrealized(e.price(x.symbol) || x.bot.center) : 0), 0);

    const chips = [...e.grids.values()]
      .map((x) => {
        const pnl = e.trades.filter((t) => t.symbol === x.symbol && t.reason.startsWith('grid')).reduce((sum, t) => sum + t.pnl, 0);
        const held = x.bot?.inventory().qty ? 'holding' : x.bot?.armed ? 'armed' : x.forge.champion ? 'waiting' : 'searching';
        return `<button class="sym slim ${x.symbol === sym ? 'on' : ''}" data-sym="${x.symbol}"><b>${short(x.symbol)}</b>
          <small class="${held === 'holding' || held === 'armed' ? 'up' : ''}">${held} · ${x.roundTrips}</small>
          <small class="${cls(pnl)}">${signed(pnl)}</small></button>`;
      })
      .join('');

    const rows = bot?.armed
      ? [...bot.orders]
          .sort((a, b) => b.price - a.price)
          .map((o) => {
            const dist = px ? ((o.price - px) / px) * 100 : 0;
            return `<tr class="${o.side}"><td>${o.side === 'sell' ? 'TP' : 'L' + o.lvl}</td><td class="mono">${fmtPrice(o.price)}</td>
              <td class="mono">${usd(o.price * o.qty)}</td><td class="mono dim">${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%</td>
              <td>${o.side === 'sell' ? '<span class="up">FILLED → selling</span>' : '<span class="dim">ARMED</span>'}</td></tr>`;
          })
          .join('')
      : '';
    const liveOn = this.liveCtl?.status === 'running';
    const picker = `
      <section class="card">
        <h3>Coin picker <span class="dim">paper simulation that chooses coins &amp; settings for the live bot · not your money</span></h3>
        <p class="small dim">It test-trades all ${tot.markets} coins with $${e.settings.startBalance} of play money and hands the live bot the coins and
        grid settings that win on unseen data. It must keep running; you don't need to watch it.
        Now: ${tot.armed}/${tot.markets} coins approved · play-money result <span class="${cls(gridPnl + open)}">${signed(gridPnl + open)}</span>.</p>
        <button class="ghost" data-act="picker">${this.pickerOpen ? '▲ Hide coin picker details' : '▼ Show coin picker details'}</button>
      </section>`;
    const offCard = `
      <section class="card live-card">
        <h3>Live account <span class="down">OFF — not trading</span></h3>
        <p class="small">Live trading isn't running, so nothing is happening on Binance. Your saved orders and coins are picked up again when you start.</p>
        <button class="ghost primary" data-tab="setup">Go to Setup → ▶ Start live trading</button>
      </section>`;
    if (!this.pickerOpen) return `${liveOn || this.liveCtl?.live ? this.livePanelView() : offCard}${picker}`;
    return `
      ${liveOn || this.liveCtl?.live ? this.livePanelView() : offCard}
      ${picker}
      <section class="kpis">
        ${kpi(
          'Paper net result',
          `<span class="${cls(gridPnl + open)}">${signed(gridPnl + open)}</span>`,
          `booked ${signed(gridPnl)} · held coins ${signed(open)} · ${tot.roundTrips} round trips`,
        )}
        ${kpi('Ladders armed', `${tot.armed}/${tot.markets}`, `${tot.holding} holding · ${e.settings.grid.leverage}× leverage`)}
        ${kpi('Inventory', usd(tot.inventory), `open ${signed(open)}`)}
        ${kpi('Fees', `${(e.settings.grid.maker * 200).toFixed(2)}%`, 'maker, per round trip')}
      </section>
      <div class="syms">${chips}</div>
      <section class="card">
        <h3>Grid engine · ${short(sym)} <span class="dim">buys ▬ green · take-profits ▬ red · stop ▬ amber</span></h3>
        <canvas id="c-grid" class="chart tall"></canvas>
      </section>
      <div class="split">
        <section class="card">
          <h3>Order grid · ${short(sym)} <span class="dim">${bot?.armed ? `stop ${fmtPrice(bot.stopPrice())}` : 'not armed'}</span></h3>
          ${
            rows
              ? `<table class="grid"><thead><tr><th>LVL</th><th>PRICE</th><th>SIZE</th><th>DIST</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table>`
              : `<p class="empty">${esc(g?.why || 'Waiting for FORGE to find a grid that beats fees here.')}</p>`
          }
        </section>
        <section class="card">
          <h3>Grid genome · ${short(sym)} <span class="dim">FORGE gen ${f?.generation ?? 0} · kill ${f?.tested ? pct(f.killed / f.tested) : '0%'}</span></h3>
          ${
            c
              ? `<div class="stats">
                  ${stat('Step', `${(c.genome.spacing * 100).toFixed(2)}%`)}
                  ${stat('Levels', String(c.genome.levels))}
                  ${stat('Stop', `${(c.genome.stop * 100).toFixed(1)}%`)}
                  ${stat('Take-profit', tpLabel(c.genome))}
                  ${stat('OOS profit', pct(c.test.profit, 2))}
                  ${stat('OOS trips', String(c.test.roundTrips))}
                  ${stat('Max DD', pct(c.test.maxDrawdown, 2))}
                </div>`
              : `<p class="empty">No grid has beaten fees on unseen data for ${short(sym)} yet.</p>`
          }
          <canvas id="c-gridfit" class="chart short"></canvas>
        </section>
      </div>
      <section class="card">
        <h3>Execution log <span class="dim">all markets</span></h3>
        ${this.logList(14)}
      </section>`;
  }

  // ------------------------------------------------------------ LIVE (real money)

  private liveCardView(): string {
    const l = this.liveSettings;
    const g = this.engine.settings.grid;
    const recOn = isRecommended(l) && g.classicTp === false && g.regime !== false;
    const opt = (v: string | number, cur: string | number, label: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    return `
      <section class="card form live-card">
        <h3>Binance futures account <span class="dim">real orders</span></h3>
        <p class="dim small">Runs the grid as real post-only orders on Binance USDⓈ-M futures, on the best coins FORGE rates that fit your budget,
        with isolated margin per coin. Start with <b>Demo trading</b> (fake money: keys made in binance.com demo mode) before Mainnet.
        Create an API key with <b>only "Enable Futures"</b> — never withdrawals — and restrict it to your IP. Keys are stored only in this browser.</p>
        <label>Network
          <select data-live="network">${opt('demo', l.network, 'Demo trading (binance.com demo mode) — fake money')}${opt('testnet', l.network, 'Old futures testnet — fake money')}${opt('mainnet', l.network, 'Mainnet — REAL MONEY')}</select></label>
        <label>API key
          <input type="text" autocomplete="off" spellcheck="false" data-live="apiKey" value="${esc(l.apiKey)}"></label>
        <label>API secret
          <input type="password" autocomplete="off" data-live="apiSecret" value="${esc(l.apiSecret)}"></label>
        <div class="arena-controls">
          <label>Max capital (USDT)
            <input type="number" min="10" step="10" data-live="maxCapital" value="${l.maxCapital}"></label>
          <label>Leverage
            <select data-live="leverage">${[1, 2, 3, 4, 5].map((x) => opt(x, l.leverage, `${x}×`)).join('')}</select></label>
          <label>Max coins at once
            <select data-live="maxCoins">${[1, 2, 3, 4, 5, 6, 8, 10].map((x) => opt(x, l.maxCoins, String(x))).join('')}</select></label>
          <label>Loss limit (% of capital) → kill
            <input type="number" min="1" max="50" data-live="dailyLossLimit" value="${pctInput(l.dailyLossLimit)}"></label>
          <label>Daily target (USDT) → bank the day
            <input type="number" min="0" step="1" data-live="dailyTarget" value="${l.dailyTarget}"></label>
          <label>Reinvest profit
            <select data-live="compound">${opt('1', l.compound ? '1' : '0', 'On — budget grows with profit, shrinks with loss')}${opt('0', l.compound ? '1' : '0', 'Off — fixed budget')}</select></label>
        </div>
        <div class="presets">
          <button class="ghost ${recOn ? 'on-profile' : ''}" data-act="live-recommended">${recOn ? '✓ RECOMMENDED ON' : '★ Recommended'}: $300 · 3× · regime + smart take-profit · 8 coins · reinvest · bank $10/day · 20% loss limit</button>
          <button class="ghost ${isAggressive(l) ? 'on-profile' : ''}" data-act="live-aggressive">${isAggressive(l) ? '✓ AGGRESSIVE ON' : '⚡ Aggressive'}: $300 (≈₹25k) · 5× · 8 coins · reinvest · 20% loss limit</button>
          <button class="ghost" data-act="live-check">Check connection</button>
          <button class="ghost primary" data-act="live-start">▶ Start live trading</button>
          <button class="kill big-kill" data-act="live-kill">■ KILL — cancel all & close positions</button>
        </div>
        <p class="small" id="live-status"></p>
      </section>`;
  }

  private renderLiveStatus(msg?: string) {
    const el = this.body.querySelector<HTMLElement>('#live-status');
    if (!el) return;
    if (msg !== undefined) el.dataset.msg = msg;
    const c = this.liveCtl;
    const status = !c ? 'live trading unavailable' : c.status === 'running' ? `● running on ${c.network}` : c.status;
    el.innerHTML = `<span class="${c?.status === 'running' ? 'up' : c?.status === 'error' ? 'down' : 'dim'}">${esc(status)}</span>${c?.message ? ` · <span class="down">${esc(c.message)}</span>` : ''}${el.dataset.msg ? ` · ${esc(el.dataset.msg)}` : ''}`;
  }

  private livePanelView(): string {
    const lv = this.liveCtl?.live;
    if (!lv || !this.liveCtl) return '';
    const pnl = lv.wallet - lv.startWallet;
    const total = pnl + lv.unrealized;
    const days = Math.max((Date.now() - lv.since) / 86_400_000, 1 / 24);
    const coins = [...lv.coins.values()]
      .map((c) => {
        const held = c.levels.filter((l) => l.side === 'sell').length;
        return `<span class="stage ${held ? 'hold' : 'idle'}"><b>${short(c.symbol)}</b>${held}/${c.levels.length} filled</span>`;
      })
      .join('');
    return `
      <section class="card live-card">
        <h3>Live account · Binance ${esc(this.liveCtl.network)} <span class="dim">${esc(this.liveCtl.status)}</span></h3>
        <div class="stats">
          ${stat('TOTAL result', `<span class="${cls(total)}">${signed(total)}</span> <span class="dim small">${pct(total / lv.budget, 1)} of $${lv.budget.toFixed(0)}</span>`)}
          ${stat(
            'Per day',
            days * 24 < 3
              ? `<span class="dim">after 3 h</span> <span class="dim small">running ${(days * 24).toFixed(1)} h — too early to project</span>`
              : `<span class="${cls(total)}">${signed(total / days)}</span> <span class="dim small">over ${days < 1 ? `${(days * 24).toFixed(1)} h` : `${days.toFixed(1)} days`}</span>`,
          )}
          ${stat(
            'Today',
            `<span class="${cls(lv.today)}">${signed(lv.today)}</span> <span class="dim small">${
              lv.locked ? '🔒 target hit — banked, only selling' : lv.cfg.dailyTarget > 0 ? `target ${usd(lv.cfg.dailyTarget)}` : 'no target'
            }</span>`,
          )}
          ${stat('Wallet', `${usd(lv.wallet)} <span class="dim small">${signed(pnl)} realized</span>`)}
          ${stat('Held coins now', `<span class="${cls(lv.unrealized)}">${signed(lv.unrealized)}</span>`)}
          ${stat('Round trips', `${lv.roundTrips} <span class="dim small">booked ${signed(lv.realized)}</span>`)}
          ${stat('Budget · coins', `${usd(lv.budget)} × ${lv.cfg.leverage} · ${lv.coins.size}/${lv.cfg.maxCoins}${lv.cfg.compound && Math.abs(lv.budget - lv.baseBudget) >= 0.01 ? ` <span class="dim small">reinvesting (started ${usd(lv.baseBudget)})</span>` : ''}`)}
        </div>
        <p class="dim small">This box is your Binance account. Everything below it is the paper simulation ($1,000 of play money on all 15 coins) that FORGE uses to pick coins — not your money.</p>
        <div class="stages">${coins || '<span class="dim small">waiting for FORGE to approve coins…</span>'}</div>
        ${lv.lastError ? `<p class="down small">${esc(lv.lastError)}</p>` : ''}
        <div class="presets">
          <button class="ghost" data-act="live-zero">↺ Start count from zero</button>
          <button class="kill big-kill" data-act="live-kill">■ KILL — cancel all & close positions</button>
        </div>
      </section>`;
  }

  private async liveAction(act: string) {
    const c = this.liveCtl;
    if (!c) return;
    const s = this.liveSettings;
    try {
      if (act === 'live-zero') {
        if (!confirm('Start counting from zero now? Orders and coins stay as they are — the live TOTAL, per-day and round trips, and the paper profit and trades, all restart at 0.')) return;
        c.resetStats();
        this.engine.resetCounters();
        this.renderTab(true);
      } else if (act === 'live-recommended') {
        // The real-week Arena winner: 3x, market regime on, smart take-profit; bank $10 a day.
        Object.assign(s, { maxCapital: 300, leverage: 3, maxCoins: 8, dailyLossLimit: 0.2, compound: true, dailyTarget: 10 });
        saveLiveSettings(s);
        const fees = { maker: this.engine.settings.grid.maker, taker: this.engine.settings.grid.taker };
        this.engine.updateSettings({ ...PRESETS.live, grid: { ...PRESETS.live.grid!, ...fees, classicTp: false, regime: true } });
        this.renderTab(true);
        this.renderLiveStatus(c.status === 'running' ? 'saved — refresh the page and press Start to apply (orders are kept)' : 'saved — press Start');
      } else if (act === 'live-aggressive') {
        // Real-week Arena: 5x made +10% to +23% a week on 15 coins, with drops of 14-20% along the way.
        Object.assign(s, { maxCapital: 300, leverage: 5, maxCoins: 8, dailyLossLimit: 0.2, compound: true });
        saveLiveSettings(s);
        const fees = { maker: this.engine.settings.grid.maker, taker: this.engine.settings.grid.taker };
        this.engine.updateSettings({ ...PRESETS.live5, grid: { ...PRESETS.live5.grid!, ...fees } });
        this.renderTab(true);
        this.renderLiveStatus(
          c.status === 'running' ? 'saved — refresh the page and press Start to apply (orders are kept)' : 'saved — press Start',
        );
      } else if (act === 'live-check') {
        this.renderLiveStatus('checking…');
        const b = await c.check(s);
        this.renderLiveStatus(`connected to ${s.network}: wallet $${b.wallet.toFixed(2)}, available $${b.available.toFixed(2)}`);
      } else if (act === 'live-start') {
        if (!s.apiKey || !s.apiSecret) return this.renderLiveStatus('enter your API key and secret first');
        if (
          s.network === 'mainnet' &&
          !confirm(`Start REAL-MONEY trading on Binance?\n\nUp to $${s.maxCapital} at ${s.leverage}× on up to ${s.maxCoins} coins.\nLoss limit ${Math.round(s.dailyLossLimit * 100)}% → kill switch.\n\nYou can lose this money.`)
        )
          return;
        this.renderLiveStatus('starting…');
        await c.start(s);
        this.renderLiveStatus(c.status === 'running' ? 'placing orders — watch the Grid tab' : '');
      } else if (act === 'live-kill') {
        if (c.status !== 'running' && !c.live) return this.renderLiveStatus('nothing running');
        if (!confirm('KILL: cancel every order and close every live position at market?')) return;
        await c.kill('kill switch pressed');
        this.renderLiveStatus('killed — all orders cancelled, positions closed. Check Binance to confirm.');
      }
    } catch (e) {
      this.renderLiveStatus(`error: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ ARENA

  private arenaView(): string {
    const a = this.arena;
    const opt = (v: string | number, cur: string | number, label: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    return `
      <section class="card form">
        <h3>Arena <span class="dim">same real prices, every contestant, full speed</span></h3>
        <p class="dim small">Replays a past stretch of real market bar by bar and races the micro grids (OLD 3×, SMART 3×, SMART 5×) against two long strategies:
        HOLD (buy every coin, hold) and TREND LONG (long a coin only while its trend reads UP), all at the same leverage on identical prices, each with
        its own $${this.engine.settings.startBalance} paper account. Repeating runs averages out the luck of FORGE's random search.</p>
        <div class="arena-controls">
          <label>Prices
            <select data-arena="source">${opt('real', a.source, 'Real Binance history')}${opt('sim', a.source, 'Offline simulator')}</select></label>
          <label>Period
            <select data-arena="days">${opt(1, a.days, 'Last 1 day')}${opt(3, a.days, 'Last 3 days')}${opt(7, a.days, 'Last 7 days')}</select></label>
          <label>Markets
            <select data-arena="markets">${opt(6, a.markets, '6 majors')}${opt(15, a.markets, '15 coins')}${opt(30, a.markets, '30 coins (slower)')}</select></label>
          <label>FORGE mode
            <select data-arena="thorough">${opt('1', a.thorough ? '1' : '0', 'Thorough — re-tune hourly, like live (slower)')}${opt('0', a.thorough ? '1' : '0', 'Fast — shared, re-tune every 3h')}</select></label>
          <label>Repeat each setting (average out luck)
            <select data-arena="repeats">${opt(1, a.repeats, '1 run')}${opt(3, a.repeats, '3 runs — recommended')}${opt(5, a.repeats, '5 runs (slowest)')}</select></label>
        </div>
        <button class="run-arena" data-act="arena">${a.running ? '■ Cancel' : '▶ Run arena'}</button>
      </section>
      <div id="arena-live"></div>`;
  }

  private renderArenaLive() {
    const el = this.body.querySelector<HTMLElement>('#arena-live');
    if (!el) return;
    const a = this.arena;
    const btn = this.body.querySelector<HTMLButtonElement>('[data-act=arena]');
    if (btn) btn.textContent = a.running ? '■ Cancel' : '▶ Run arena';
    let html = '';
    if (a.running && a.progress) {
      html += `<section class="card"><h3>Running <span class="dim">${esc(a.progress.stage)}</span></h3>
        <div class="bar big"><i style="width:${Math.round(a.progress.pct * 100)}%"></i></div>
        <p class="dim small">${esc(a.progress.text)}</p></section>`;
    }
    if (a.error) html += `<section class="card"><p class="down">${esc(a.error)}</p></section>`;
    if (a.results) {
      const start = a.results[0].start;
      const best = [...a.results].sort((x, y) => y.final - x.final)[0];
      html += `<section class="card"><h3>Result <span class="dim">${esc(a.note)}</span></h3>
        <p class="big ${cls(best.final - start)}">${esc(best.name.split(' · ')[0])} ${best.final >= start ? 'wins' : 'loses least'}: ${signed(best.final - start)}</p>
        ${
          a.source === 'real' && a.note.startsWith('offline')
            ? '<p class="down small">Binance could not be reached, so this ran on the offline simulator instead of real prices.</p>'
            : ''
        }
        ${
          a.note.startsWith('offline')
            ? '<p class="warn small">Offline simulator prices are synthetic and trend far harder than real markets — these numbers are not achievable. Use Real Binance history to judge a strategy.</p>'
            : ''
        }
        <canvas id="c-arena" class="chart tall"></canvas>
        <p class="legend">${a.results.map((r, i) => `<i style="background:var(${ARENA_COLORS[i]})"></i>${esc(r.name)}`).join(' ')}</p>
      </section>
      <div class="split">${a.results
        .map(
          (r, i) => `<section class="card"><h3><span style="color:var(${ARENA_COLORS[i]})">${esc(r.name)}</span></h3>
            <p class="big ${cls(r.final - start)}">${usd(r.final)} <small>${signed(r.final - start)} · ${pct((r.final - start) / start, 1)}</small></p>
            <div class="stats">
              ${stat('Trades', r.trades.toLocaleString())}
              ${stat('Win rate', pct(r.winRate))}
              ${stat('Max drawdown', pct(r.maxDrawdown, 1))}
              ${stat('Peak', signed(r.peak - start))}
              ${stat('Best day', signed(r.bestDay))}
              ${stat('Worst day', signed(r.worstDay))}
              ${stat('Per day', signed((r.final - start) / Math.max(1, r.equity.length ? (r.equity[r.equity.length - 1].t - r.equity[0].t) / 86_400_000 : 1)))}
            </div>${
              r.runs && r.runs > 1
                ? `<p class="small">Average of ${r.runs} runs · range <span class="${cls((r.minFinal ?? 0) - start)}">${signed((r.minFinal ?? 0) - start)}</span> to
                   <span class="${cls((r.maxFinal ?? 0) - start)}">${signed((r.maxFinal ?? 0) - start)}</span> · green in <b>${r.greenRuns}/${r.runs}</b> runs</p>`
                : ''
            }</section>`,
        )
        .join('')}</div>`;
    }
    el.innerHTML = html;
    const c = el.querySelector<HTMLCanvasElement>('#c-arena');
    if (c && a.results) {
      lineChart(
        c,
        a.results.map((r, i) => ({ values: r.equity.map((p) => p.v), color: ARENA_COLORS[i], width: 2 })),
        (v) => `$${Math.round(v).toLocaleString()}`,
        a.results[0].start,
      );
    }
  }

  private async toggleArena() {
    const a = this.arena;
    if (a.running) {
      a.signal.cancelled = true;
      return;
    }
    a.running = true;
    a.error = '';
    a.results = null;
    a.signal = { cancelled: false };
    a.progress = { stage: 'download', pct: 0, text: 'starting…' };
    this.renderArenaLive();
    const base = this.engine.settings;
    try {
      const out = await runArenaRepeated({
        symbols: a.markets >= 30 ? MEGA_MARKETS : a.markets >= 15 ? WIDE_MARKETS : MAJORS,
        days: a.days,
        source: a.source,
        base,
        contestants: gridVariants(base),
        benchmarkLeverage: 3,
        forgeMode: a.thorough ? 'thorough' : 'fast',
        signal: a.signal,
        onProgress: (p) => {
          a.progress = p;
          if (this.tab === 'arena') this.renderArenaLive();
        },
      }, a.repeats);
      a.results = out.results;
      a.note = out.note + (a.signal.cancelled ? ' · cancelled early' : '');
    } catch (err) {
      a.error = `Arena failed: ${(err as Error).message}`;
    }
    a.running = false;
    if (this.tab === 'arena') this.renderArenaLive();
  }

  // ------------------------------------------------------------ LOG

  private logView(): string {
    const trades = this.engine.trades.slice(0, 40);
    const fills = this.engine.log.filter((l) => /^(LIVE (BUY|SELL)|✕ LIVE)/.test(l.text)).slice(0, 60);
    return `
      <section class="card live-card">
        <h3>Binance fills <span class="dim">your account · newest first</span></h3>
        ${
          fills.length
            ? `<ul class="log">${fills
                .map(
                  (l) => `<li class="${l.kind}"><span class="mono dim">${time(l.t)}</span><span>${esc(l.text)}</span>${
                    l.pnl !== undefined ? `<span class="mono ${cls(l.pnl)}">${signed(l.pnl)}</span>` : ''
                  }</li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">No Binance fills yet — start live trading in Setup.</p>'
        }
      </section>
      <section class="card">
        <h3>Paper trades <span class="dim">coin-picker simulation · ${this.engine.trades.length} closed · not your money</span></h3>
        <canvas id="c-trades" class="chart mini"></canvas>
        ${
          trades.length
            ? `<ul class="log">${trades
                .map(
                  (t) => `<li><span class="mono dim">${time(t.closedAt)}</span><b>${short(t.symbol)} ${t.dir === 1 ? 'L' : 'S'}</b>
                  <span>${fmtPrice(t.entry)} → ${fmtPrice(t.exit)} · ${esc(t.reason)}</span><span class="mono ${cls(t.pnl)}">${signed(t.pnl)}</span></li>`,
                )
                .join('')}</ul>`
            : '<p class="empty">No closed trades yet.</p>'
        }
      </section>
      <section class="card">
        <h3>Decision log <span class="dim">every entry, every veto</span></h3>
        ${this.logList(120)}
      </section>`;
  }

  // ------------------------------------------------------------ SETUP

  private setupView(): string {
    const s = this.engine.settings;
    return `
${this.liveCardView()}
      <section class="card form">
        <h3>Coin picker <span class="dim">paper simulation FORGE uses to choose coins — not your money</span></h3>
        <p class="dim small">A $${s.startBalance} play-money grid runs on all ${s.symbols.length} coins on live Binance prices. FORGE re-tunes each coin's grid
        continuously and only coins that beat fees on unseen data are traded for real.</p>
        <label>Grid leverage used for picking (match your live leverage)
          <select data-set="grid.leverage">${[1, 2, 3, 4, 5].map((x) => `<option value="${x}" ${x === s.grid.leverage ? 'selected' : ''}>${x}×</option>`).join('')}</select></label>
        <label>Take-profit
          <select data-set="grid.classicTp">
            <option value="0" ${s.grid.classicTp === false ? 'selected' : ''}>Smart — FORGE picks 1–3 steps (won the real-week Arena: +6.3% vs −0.5%)</option>
            <option value="1" ${s.grid.classicTp !== false ? 'selected' : ''}>Classic — always one step up</option>
          </select></label>
        <label>Market regime (skip coins in a downtrend, fewer coins on bad days)
          <select data-set="grid.regime">
            <option value="1" ${s.grid.regime !== false ? 'selected' : ''}>On — recommended</option>
            <option value="0" ${s.grid.regime === false ? 'selected' : ''}>Off</option>
          </select></label>
        <label>Crash guard (pause every grid when most coins dump together)
          <select data-set="grid.crashGuard">
            <option value="1" ${s.grid.crashGuard ? 'selected' : ''}>On — recommended</option>
            <option value="0" ${s.grid.crashGuard ? '' : 'selected'}>Off</option>
          </select></label>
        <label>Maker fee % (your Binance futures maker fee)
          <input type="number" step="0.01" min="0" max="1" data-set="grid.maker" value="${pctInput(s.grid.maker)}"></label>
        <label>Taker fee % (stop-outs)
          <input type="number" step="0.01" min="0" max="1" data-set="grid.taker" value="${pctInput(s.grid.taker)}"></label>
        <button class="danger" data-act="reset">Reset paper simulation</button>
      </section>`;
  }

  // ------------------------------------------------------------ events

  private onClick(ev: Event) {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-act],[data-sym],[data-preset]');
    if (!el) return;
    if (el.dataset.tab) {
      this.tab = el.dataset.tab as Tab;
      try {
        localStorage.setItem('swarmdesk:tab', this.tab);
      } catch {
        /* ignore */
      }
      this.renderTab(true);
      this.body.scrollTop = 0;
    } else if (el.dataset.sym) {
      this.symbol = el.dataset.sym;
      this.renderTab(true);
    } else if (el.dataset.preset) {
      const preset = PRESETS[el.dataset.preset];
      // Presets set grid leverage but keep the user's own fee settings.
      const fees = { maker: this.engine.settings.grid.maker, taker: this.engine.settings.grid.taker };
      this.engine.updateSettings(preset.grid ? { ...preset, grid: { ...preset.grid, ...fees } } : preset);
      this.renderTab(true);
    } else if (el.dataset.act === 'toggle') {
      if (this.engine.running) this.engine.stop();
      else void this.engine.start();
    } else if (el.dataset.act?.startsWith('live-')) {
      void this.liveAction(el.dataset.act);
    } else if (el.dataset.act === 'picker') {
      this.pickerOpen = !this.pickerOpen;
      this.renderTab(true);
    } else if (el.dataset.act === 'arena') {
      void this.toggleArena();
    } else if (el.dataset.act === 'flatten') {
      void this.engine.closeAll();
    } else if (el.dataset.act === 'reset') {
      if (confirm('Reset the paper account? Balance, positions and history will be cleared.')) this.engine.reset();
    }
  }

  private onInput(ev: Event) {
    const el = ev.target as HTMLInputElement | HTMLSelectElement;
    const lk = el.dataset.live as keyof LiveSettings | undefined;
    if (lk) {
      const l = this.liveSettings;
      const v = el.value.trim();
      if (lk === 'network') l.network = v as LiveSettings['network'];
      else if (lk === 'apiKey' || lk === 'apiSecret') l[lk] = v;
      else if (lk === 'dailyLossLimit') l.dailyLossLimit = Math.min(0.5, Math.max(0.01, Number(v) / 100));
      else if (lk === 'maxCapital') l.maxCapital = Math.max(10, Number(v) || 100);
      else if (lk === 'compound') l.compound = v === '1';
      else if (lk === 'dailyTarget') l.dailyTarget = Math.max(0, Number(v) || 0);
      else l[lk] = Number(v);
      saveLiveSettings(l);
      return;
    }
    const ak = el.dataset.arena;
    if (ak) {
      const a = this.arena;
      if (ak === 'source') a.source = el.value as 'real' | 'sim';
      if (ak === 'days') a.days = Number(el.value);
      if (ak === 'markets') a.markets = Number(el.value);
      if (ak === 'thorough') a.thorough = el.value === '1';
      if (ak === 'leverage') a.leverage = Number(el.value);
      if (ak === 'variants') a.variants = el.value === '1';
      if (ak === 'repeats') a.repeats = Number(el.value);
      return;
    }
    const key = el.dataset.set;
    if (!key) return;
    const s = this.engine.settings;
    const num = Number(el.value);
    switch (key) {
      case 'feed':
        this.engine.updateSettings({ feed: el.value as Settings['feed'] });
        break;
      case 'strategy':
        this.engine.updateSettings({ strategy: el.value as Settings['strategy'] });
        break;
      case 'grid.regime':
        this.engine.updateSettings({ grid: { ...s.grid, regime: el.value === '1' } });
        break;
      case 'grid.classicTp':
        this.engine.updateSettings({ grid: { ...s.grid, classicTp: el.value === '1' } });
        break;
      case 'grid.crashGuard':
        this.engine.updateSettings({ grid: { ...s.grid, crashGuard: el.value === '1' } });
        break;
      case 'grid.crashDrop':
        if (num > 0) this.engine.updateSettings({ grid: { ...s.grid, crashDrop: num / 100 } });
        break;
      case 'grid.leverage':
        if (num >= 1 && num <= 5) this.engine.updateSettings({ grid: { ...s.grid, leverage: num } });
        break;
      case 'grid.maker':
      case 'grid.taker':
        if (num >= 0) this.engine.updateSettings({ grid: { ...s.grid, [key.split('.')[1]]: num / 100 } });
        break;
      case 'interval':
        this.engine.updateSettings({ interval: el.value as Settings['interval'] });
        break;
      case 'simBarMs':
        if (num > 0) this.engine.updateSettings({ simBarMs: num * 1000 });
        break;
      case 'symbols': {
        const list = el.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{2,20}$/.test(x));
        if (list.length) {
          this.engine.updateSettings({ symbols: list });
          this.symbol = list[0];
        }
        break;
      }
      case 'startBalance':
        if (num > 0) this.engine.updateSettings({ startBalance: num });
        break;
      default: {
        const [group, field] = key.split('.') as ['hawk' | 'sentry', string];
        const scale = field === 'cooldownBars' || field === 'maxOpen' || field === 'maxLeverage' ? 1 : 0.01;
        if (!(num >= 0)) return;
        this.engine.updateSettings({ [group]: { ...s[group], [field]: num * scale } } as never);
      }
    }
  }

  // ------------------------------------------------------------ canvases

  private drawCharts() {
    const e = this.engine;
    const q = (id: string) => this.body.querySelector<HTMLCanvasElement>(`#${id}`);
    const gC = q('c-grid');
    const gs = e.symbols.get(this.symbol);
    const gbot = e.grids.get(this.symbol)?.bot;
    if (gC && gs) {
      const candles = [...gs.candles.slice(-119), ...(gs.forming ? [gs.forming] : [])];
      const levels = (gbot?.armed ? gbot.orders : []).map((o) => ({ price: o.price, color: o.side === 'buy' ? '--up' : '--down' }));
      if (gbot?.armed) levels.push({ price: gbot.stopPrice(), color: '--warn' });
      candleChart(gC, candles, undefined, e.trades.filter((t) => t.symbol === gs.symbol), fmtPrice, levels);
    }
    const gfC = q('c-gridfit');
    if (gfC) {
      const h = e.grids.get(this.symbol)?.forge.history.slice(-80) ?? [];
      lineChart(gfC, [{ values: h.map((x) => Math.max(-0.05, x.best)), color: '--up', fill: true }], (v) => `${(v * 100).toFixed(2)}%`, 0);
    }

    const tC = q('c-trades');
    if (tC) {
      const tr = [...e.trades].slice(0, 60).reverse();
      barsChart(tC, tr.map((x) => x.pnl), tr.map((x) => (x.pnl >= 0 ? '--up' : '--down')));
    }
  }
}

const ARENA_COLORS = ['--scout', '--hawk', '--forge', '--warn', '--down', '--up', '--muted'];

const PRESETS: Record<string, Partial<Settings>> = {
  // The setup that won the real-week Arena, on live real-time prices (paper fills).
  live: { feed: 'binance', strategy: 'grid', interval: '1m', symbols: WIDE_MARKETS, grid: DEFAULT_SETTINGS.grid, sentry: { ...DEFAULT_SENTRY } },
  // 5x made money in all four real 15-coin weeks (+9.8% to +23.4%) with deeper drops (14-20%).
  live5: { feed: 'binance', strategy: 'grid', interval: '1m', symbols: WIDE_MARKETS, grid: { ...DEFAULT_SETTINGS.grid, leverage: 5 }, sentry: { ...DEFAULT_SENTRY } },
};

/** Fraction → percent for a form field, without float noise like 55.00000000000001. */
const pctInput = (x: number) => String(Math.round(x * 10000) / 100);

function kpi(label: string, value: string, sub: string): string {
  return `<div class="kpi"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
}

function stat(label: string, value: string): string {
  return `<div><small>${label}</small><b>${value}</b></div>`;
}

/** The one-click aggressive profile is active (so its button can show it). */
function isRecommended(l: LiveSettings): boolean {
  return l.maxCapital === 300 && l.leverage === 3 && l.maxCoins === 8 && Math.abs(l.dailyLossLimit - 0.2) < 1e-9 && l.compound && l.dailyTarget === 10;
}

function isAggressive(l: LiveSettings): boolean {
  return l.maxCapital === 300 && l.leverage === 5 && l.maxCoins === 8 && Math.abs(l.dailyLossLimit - 0.2) < 1e-9 && l.compound;
}
