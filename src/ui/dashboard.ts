import { type Engine, fmtPrice, tpLabel } from '../core/engine';
import type { AgentId } from '../core/types';
import { barsChart, candleChart, lineChart } from './charts';
import { type LiveController, type LiveSettings, loadLiveSettings, saveLiveSettings } from '../exchange/liveController';
import { PROFILE, PROFILE_LABEL, withProfile } from '../exchange/profile';

type Tab = 'grid' | 'log' | 'setup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'grid', label: 'Live' },
  { id: 'log', label: 'Trades' },
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
    const l = withProfile(this.liveSettings);
    const opt = (v: string, cur: string, label: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    return `
      <section class="card form live-card">
        <h3>Binance futures account <span class="dim">${l.network === 'mainnet' ? '<span class="down">REAL MONEY</span>' : 'demo — fake money'}</span></h3>
        <label>Account
          <select data-live="network">${opt('demo', l.network, 'Demo (binance.com demo mode) — fake money, for testing')}${opt('mainnet', l.network, 'REAL MONEY (binance.com) — your own USDT')}</select></label>
        <label>API key
          <input type="text" autocomplete="off" spellcheck="false" data-live="apiKey" value="${esc(l.apiKey)}"></label>
        <label>API secret
          <input type="password" autocomplete="off" data-live="apiSecret" value="${esc(l.apiSecret)}"></label>
        <label>Money to trade (USDT in your futures wallet)
          <input type="number" min="20" step="10" data-live="maxCapital" value="${l.maxCapital}"></label>
        <div class="stats">
          ${stat('Strategy (fixed)', `${PROFILE.leverage}× · ½ grid on ${PROFILE.maxCoins} coins + ½ panic buy on ${PROFILE.panic.coins}`)}
          ${stat('Take profit', `every +${usd(l.dailyTarget)} → sell all, new round`)}
          ${stat('Loss limit', `stops itself at −${usd(l.maxCapital * l.dailyLossLimit)}`)}
          ${stat('Reinvest', 'on — profits grow the budget')}
        </div>
        <p class="dim small">${esc(PROFILE_LABEL)}. The strategy is fixed — only the account, keys and money are yours to set.
        API key: <b>only "Enable Futures"</b>, never withdrawals. Keys stay on this device.</p>
        <div class="presets">
          <button class="ghost" data-act="live-check">Check connection</button>
          <button class="ghost primary" data-act="live-start">▶ Start trading</button>
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
              lv.locked
                ? '🔒 target hit — banked, only selling'
                : lv.cfg.dailyTarget > 0
                  ? `target ${usd(lv.cfg.dailyTarget)}${lv.cfg.afterTarget === 'restart' ? ` · take &amp; restart${lv.rounds ? ` · ${lv.rounds} round${lv.rounds === 1 ? '' : 's'} banked ${signed(lv.bankedRounds)}` : ''}` : ''}`
                  : 'no target'
            }</span>`,
          )}
          ${stat('Wallet', `${usd(lv.wallet)} <span class="dim small">${signed(pnl)} realized</span>`)}
          ${stat('Held coins now', `<span class="${cls(lv.unrealized)}">${signed(lv.unrealized)}</span>`)}
          ${stat('Round trips', `${lv.roundTrips} <span class="dim small">booked ${signed(lv.realized)}</span>`)}
          ${
            lv.panic && lv.cfg.panic
              ? stat(
                  'Panic buy',
                  `${lv.panic.pos.size} held · ${lv.panic.trades} done <span class="dim small">${lv.panic.set.map((x) => `${esc(x.replace('USDT', ''))}${lv.panic!.pos.has(x) ? '●' : ''}`).join(' ') || 'picking coins…'}</span>`,
                )
              : ''
          }
          ${stat('Budget · grid coins', `${usd(lv.budget)} × ${lv.cfg.leverage} · ${lv.coins.size}/${lv.cfg.maxCoins}${lv.cfg.compound && Math.abs(lv.budget - lv.baseBudget) >= 0.01 ? ` <span class="dim small">reinvesting (started ${usd(lv.baseBudget)})</span>` : ''}`)}
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
      } else if (act === 'live-check') {
        this.renderLiveStatus('checking…');
        const b = await c.check(s);
        this.renderLiveStatus(
          `connected to ${s.network === 'mainnet' ? 'REAL account' : 'demo'}: futures wallet $${b.wallet.toFixed(2)}, available $${b.available.toFixed(2)}` +
            (b.available < s.maxCapital ? ` — less than the $${s.maxCapital} you set; the bot will use $${b.available.toFixed(2)}` : ''),
        );
      } else if (act === 'live-start') {
        if (!s.apiKey || !s.apiSecret) return this.renderLiveStatus('enter your API key and secret first');
        const p = withProfile(s);
        if (
          p.network === 'mainnet' &&
          !confirm(`Start REAL-MONEY trading on Binance?\n\n$${p.maxCapital} at ${p.leverage}× on up to ${p.maxCoins} coins.\nTake profit every +$${p.dailyTarget}. Loss limit −$${(p.maxCapital * p.dailyLossLimit).toFixed(0)} → stops itself.\n\nYou can lose this money.`)
        )
          return;
        this.renderLiveStatus('starting…');
        await c.start(p);
        this.renderLiveStatus(c.status === 'running' ? 'placing orders — watch the Live tab' : '');
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
    return this.liveCardView();
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
    } else if (el.dataset.act === 'toggle') {
      if (this.engine.running) this.engine.stop();
      else void this.engine.start();
    } else if (el.dataset.act?.startsWith('live-')) {
      void this.liveAction(el.dataset.act);
    } else if (el.dataset.act === 'picker') {
      this.pickerOpen = !this.pickerOpen;
      this.renderTab(true);
    } else if (el.dataset.act === 'flatten') {
      void this.engine.closeAll();
    } else if (el.dataset.act === 'reset') {
      if (confirm('Reset the paper account? Balance, positions and history will be cleared.')) this.engine.reset();
    }
  }

  private onInput(ev: Event) {
    const el = ev.target as HTMLInputElement | HTMLSelectElement;
    const lk = el.dataset.live as keyof LiveSettings | undefined;
    if (!lk) return;
    const l = this.liveSettings;
    const v = el.value.trim();
    if (lk === 'network') l.network = v === 'mainnet' ? 'mainnet' : 'demo';
    else if (lk === 'apiKey' || lk === 'apiSecret') l[lk] = v;
    else if (lk === 'maxCapital') l.maxCapital = Math.max(20, Number(v) || 100);
    saveLiveSettings(l);
    // The summary (take-profit and loss-limit amounts) follows the money.
    if (lk === 'maxCapital' || lk === 'network') {
      this.renderTab(true);
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

function kpi(label: string, value: string, sub: string): string {
  return `<div class="kpi"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
}

function stat(label: string, value: string): string {
  return `<div><small>${label}</small><b>${value}</b></div>`;
}
