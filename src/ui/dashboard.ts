import { unrealized } from '../agents/hawk';
import { DEFAULT_SENTRY } from '../agents/sentry';
import { DEFAULT_SETTINGS, type Engine, fmtPrice, type Settings, type SymbolState } from '../core/engine';
import { GENE_RANGES } from '../core/evolver';
import { edgeStats, sizedRisk } from '../core/kelly';
import type { AgentId } from '../core/types';
import { barsChart, candleChart, kellyChart, lineChart } from './charts';

type Tab = 'desk' | 'grid' | 'markets' | 'forge' | 'log' | 'setup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'desk', label: 'Desk' },
  { id: 'grid', label: 'Grid' },
  { id: 'markets', label: 'Markets' },
  { id: 'forge', label: 'Forge' },
  { id: 'log', label: 'Log' },
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
  private tab: Tab = 'desk';
  private symbol: string;
  private frame = 0;
  private body!: HTMLElement;

  constructor(
    private root: HTMLElement,
    private engine: Engine,
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
      return;
    }
    const html = this.tab === 'desk' ? this.deskView() : this.tab === 'grid' ? this.gridView() : this.tab === 'markets' ? this.marketsView() : this.tab === 'forge' ? this.forgeView() : this.logView();
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
      <span class="pill paper">PAPER</span>
      <span class="mono dim">${hh}:${mm}:${ss}</span>
      <button class="run ${e.running ? 'on' : ''}" data-act="toggle">${e.running ? '■ STOP' : '▶ START'}</button>
      ${e.feedStatus === 'replay' || e.feedStatus === 'connecting' ? `<span class="feed-detail mono dim">${esc(e.feedDetail)}</span>` : ''}`;
  }

  // ------------------------------------------------------------ DESK

  private deskView(): string {
    const e = this.engine;
    const eq = e.totalEquity();
    const net = eq - e.startBalance;
    const wins = e.trades.filter((t) => t.pnl > 0).length;
    const f = e.forgeTotals();
    return `
      <section class="kpis">
        ${kpi('Session balance', usd(eq), `start ${usd(e.startBalance)}`)}
        ${kpi('Net PnL', `<span class="${cls(net)}">${signed(net)}</span>`, `<span class="${cls(net)}">${pct(net / e.startBalance, 2)}</span> · day ${signed(e.dayPnl)}`)}
        ${kpi('Win rate', pct(e.winRate()), `${wins}W / ${e.trades.length - wins}L`)}
        ${kpi('In position', String(e.positions.length), `open ${signed(e.openPnl())}`)}
      </section>

      <section class="card">
        <h3>Balance history <span class="dim">USD</span></h3>
        <canvas id="c-equity" class="chart"></canvas>
      </section>

      <section class="card">
        <h3>Decision pipeline <span class="dim">read → gate → execute</span></h3>
        <div class="agents">${(Object.keys(AGENT_META) as AgentId[]).map((a) => this.agentCard(a)).join('')}</div>
        <div class="stages">${[...e.symbols.values()].map((s) => stageChip(s)).join('')}</div>
      </section>

      <div class="split">
        <section class="card">
          <h3>Entry checks <span class="dim">SENTRY</span></h3>
          ${this.gateView()}
        </section>
        <section class="card">
          <h3>Position control <span class="dim">HAWK</span></h3>
          ${this.positionsView()}
        </section>
      </div>

      <section class="card">
        <h3>Decision log <span class="dim">${f.live}/${e.symbols.size} markets armed · ${e.vetoes} vetoes</span></h3>
        ${this.logList(8)}
      </section>`;
  }

  private agentCard(a: AgentId): string {
    const st = this.engine.agents[a];
    const recent = Date.now() - st.at < 4000;
    return `<div class="agent ${recent || st.busy ? 'busy' : ''}" style="--c:${AGENT_META[a].color}">
      <i></i><div><b>${a}</b><small>${AGENT_META[a].role}</small><em>${esc(st.text)}</em></div></div>`;
  }

  private gateView(): string {
    const g = this.engine.lastGate;
    if (!g) return `<p class="empty">No setup has reached the gate yet.</p>`;
    const passed = g.verdict.checks.filter((c) => c.pass).length;
    return `
      <div class="gate-head"><b>${short(g.symbol)} ${g.signal.dir === 1 ? 'LONG' : 'SHORT'}</b>
        <span class="${g.verdict.pass ? 'up' : 'down'}">${g.verdict.pass ? '✓ PASSED' : '✕ VETO'} · ${passed}/3</span></div>
      ${g.verdict.checks
        .map(
          (c) => `<div class="check"><span>${c.name}</span>${meter(c.score, c.pass)}<small class="${c.pass ? '' : 'down'}">${esc(c.detail)}</small></div>`,
        )
        .join('')}
      ${g.verdict.blockedBy ? `<p class="down small">${esc(g.verdict.blockedBy)}</p>` : ''}
      <p class="dim small">${time(g.at)} · ${esc(g.signal.reason)}</p>`;
  }

  private positionsView(): string {
    const e = this.engine;
    if (!e.positions.length)
      return `<p class="big dim">FLAT</p><p class="dim small">Size vs bank · never vs mood · no revenge entries</p>`;
    return `<p class="big up">IN POSITION</p>
      ${e.positions
        .map((p) => {
          const px = e.price(p.symbol) || p.entry;
          const u = unrealized(p, px);
          return `<div class="pos"><b>${short(p.symbol)} ${p.dir === 1 ? 'LONG' : 'SHORT'}</b>
            <span class="${cls(u)}">${signed(u)}</span>
            <small>entry ${fmtPrice(p.entry)} · now ${fmtPrice(px)} · stop ${fmtPrice(p.stop)} · tp ${fmtPrice(p.take)}</small></div>`;
        })
        .join('')}
      <button class="ghost" data-act="flatten">Close all</button>`;
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
    return `
      <section class="kpis">
        ${kpi('Grid profit', `<span class="${cls(gridPnl)}">${signed(gridPnl)}</span>`, `${tot.roundTrips} round trips · all markets`)}
        ${kpi('Ladders armed', `${tot.armed}/${tot.markets}`, `${tot.holding} holding coins`)}
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

  // ------------------------------------------------------------ MARKETS

  private marketsView(): string {
    const e = this.engine;
    const s = e.symbols.get(this.symbol);
    const chips = e.settings.symbols
      .map((sym) => {
        const st = e.symbols.get(sym);
        const c = st?.candles ?? [];
        const px = e.price(sym);
        const ref = c[Math.max(0, c.length - 60)]?.c ?? px;
        const ch = ref ? (px - ref) / ref : 0;
        return `<button class="sym ${sym === this.symbol ? 'on' : ''}" data-sym="${sym}"><b>${short(sym)}</b>
          <span class="mono">${px ? fmtPrice(px) : '—'}</span><small class="${cls(ch)}">${pct(ch, 2)} 60 bars</small></button>`;
      })
      .join('');
    const champ = s?.evolver.champion;
    const g = champ?.genome;
    return `
      <div class="syms">${chips}</div>
      <section class="card">
        <h3>${short(this.symbol)} / USDT <span class="dim">${e.barLabel()} · last 120 bars</span></h3>
        <canvas id="c-candles" class="chart tall"></canvas>
      </section>
      <section class="card">
        <h3>Live strategy <span class="dim">FORGE champion</span></h3>
        ${
          g && champ
            ? `<div class="stats">
                ${stat('Family', g.regime)}
                ${stat('OOS return', pct(champ.test.totalReturn, 2))}
                ${stat('OOS trades', String(champ.test.trades.length))}
                ${stat('Win rate', pct(champ.test.winRate))}
                ${stat('Expectancy', `${champ.test.expectancyR.toFixed(2)}R`)}
                ${stat('Max DD', pct(champ.test.maxDrawdown, 2))}
              </div>
              <p class="dim small">stop ${g.stopAtr}×ATR · target ${g.takeAtr}×ATR · trail ${g.trailAtr}×ATR · signal: ${esc(s?.lastSignal?.reason ?? 'waiting')}</p>`
            : `<p class="empty">No strategy has survived the out-of-sample gate for this market yet — SENTRY keeps it benched.</p>`
        }
      </section>`;
  }

  // ------------------------------------------------------------ FORGE

  private forgeView(): string {
    const e = this.engine;
    const f = e.forgeTotals();
    const s = e.symbols.get(this.symbol);
    const ev = s?.evolver;
    const last = ev?.history[ev.history.length - 1];
    const champ = ev?.champion;
    const t = champ?.test;
    const { w, payoff } = t ? edgeStats(t) : { w: 0, payoff: 0 };
    const chosen = t ? sizedRisk(w, payoff, 1) : 0;
    const genes = champ
      ? (Object.keys(GENE_RANGES) as (keyof typeof GENE_RANGES)[])
          .map((k) => {
            const [lo, hi] = GENE_RANGES[k];
            const v = champ.genome[k];
            return `<div class="gene"><span>${k}</span><div class="bar"><i style="width:${((v - lo) / (hi - lo)) * 100}%"></i></div><b class="mono">${v}</b></div>`;
          })
          .join('')
      : '';
    return `
      <section class="kpis">
        ${kpi('Generation', `#${f.gen}`, 'observe · mutate · test · select')}
        ${kpi('Tested', f.tested.toLocaleString(), 'backtests run')}
        ${kpi('Kill rate', pct(f.killRate), 'fail the out-of-sample gate')}
        ${kpi('Armed', `${f.live}/${e.symbols.size}`, 'markets with a champion')}
      </section>
      <div class="syms">${e.settings.symbols.map((sym) => `<button class="sym slim ${sym === this.symbol ? 'on' : ''}" data-sym="${sym}"><b>${short(sym)}</b><small>gen ${e.symbols.get(sym)?.evolver.generation ?? 0}</small></button>`).join('')}</div>
      <section class="card">
        <h3>Fitness · best of generation <span class="dim">${short(this.symbol)} · every generation must beat the gate or it dies</span></h3>
        <canvas id="c-fitness" class="chart"></canvas>
        <p class="legend"><i style="background:var(--up)"></i>best <i style="background:var(--muted)"></i>population mean</p>
      </section>
      <div class="split">
        <section class="card">
          <h3>Natural selection <span class="dim">gen ${last?.gen ?? 0}</span></h3>
          ${funnel('Generated', last?.generated ?? 0, DEFAULT_POP)}
          ${funnel('Backtested', last?.backtested ?? 0, DEFAULT_POP)}
          ${funnel('Passed gate', last?.passedGate ?? 0, DEFAULT_POP)}
          ${funnel('Live', last?.survivors ?? 0, DEFAULT_POP)}
        </section>
        <section class="card">
          <h3>Kelly sizing <span class="dim">half-Kelly, capped</span></h3>
          ${
            t
              ? `<p class="big">${pct(Math.min(chosen, e.settings.hawk.maxRiskPerTrade), 2)} <small class="dim">risk / trade</small></p>
                 <canvas id="c-kelly" class="chart short"></canvas>
                 <p class="dim small">win ${pct(w)} (smoothed) · payoff ${payoff.toFixed(2)} · raw half-Kelly ${pct(chosen, 2)} · cap ${pct(e.settings.hawk.maxRiskPerTrade, 1)}</p>`
              : `<p class="empty">Needs a champion.</p>`
          }
        </section>
      </div>
      <section class="card">
        <h3>Genome <span class="dim">${champ ? `${champ.genome.regime} · ${champ.genome.id}` : 'none alive'}</span></h3>
        ${genes || '<p class="empty">No survivor yet.</p>'}
      </section>`;
  }

  // ------------------------------------------------------------ LOG

  private logView(): string {
    const trades = this.engine.trades.slice(0, 40);
    return `
      <section class="card">
        <h3>Trades <span class="dim">${this.engine.trades.length} closed</span></h3>
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
      <section class="card">
        <h3>Presets <span class="dim">paper only</span></h3>
        <div class="presets">
          <button class="ghost" data-preset="grid">▦ Grid micro-trading — replay</button>
          <button class="ghost" data-preset="replay">⏩ Replay real market — fast</button>
          <button class="ghost" data-preset="fast">⚡ Live — 15 markets, looser gate</button>
          <button class="ghost" data-preset="standard">Live standard — 6 markets, default gate</button>
        </div>
        <p class="dim small">Grid micro-trading runs a ladder of limit buys on each of 15 coins, with an equal slice of the bank each; every fill gets a take-profit one step higher,
        so every small bounce books a small profit at maker fees. It earns in ranges and is stopped out in hard sell-offs.</p>
        <p class="dim small">Replay fast-forwards the last ~2 days of real 1m prices (1 bar every 1.5s) — the same thing the "session replay" dashboards show.
        It is real price history, so results mean more than the simulator, but it is still a backtest: live trading can't run faster than the market.</p>
        <p class="dim small">Live fast watches 15 liquid coins on 1-minute candles with a looser gate, so setups come several times more often.
        Faster candles don't help: a 1-second move is far smaller than exchange fees, so no strategy survives FORGE there.</p>
      </section>
      <section class="card form">
        <h3>Market data</h3>
        <label>Feed
          <select data-set="feed">
            <option value="replay" ${s.feed === 'replay' ? 'selected' : ''}>Replay — last ~2 days of real Binance prices, fast-forwarded</option>
            <option value="binance" ${s.feed === 'binance' ? 'selected' : ''}>Binance live prices (real time, paper fills)</option>
            <option value="sim" ${s.feed === 'sim' ? 'selected' : ''}>Simulator (turbo, offline)</option>
          </select></label>
        <label>Live candle timeframe
          <select data-set="interval">
            <option value="1s" ${s.interval === '1s' ? 'selected' : ''}>1 second (experimental — fees usually exceed moves)</option>
            <option value="1m" ${s.interval === '1m' ? 'selected' : ''}>1 minute (standard)</option>
            <option value="5m" ${s.interval === '5m' ? 'selected' : ''}>5 minutes (slow — fewer, larger moves)</option>
          </select></label>
        <label>Simulator speed — seconds per 1m bar
          <input type="number" step="0.5" min="0.5" max="60" data-set="simBarMs" value="${s.simBarMs / 1000}"></label>
        <label>Markets (comma separated)
          <input type="text" data-set="symbols" value="${s.symbols.join(',')}"></label>
      </section>
      <section class="card form">
        <h3>Strategy</h3>
        <label>Engine
          <select data-set="strategy">
            <option value="agents" ${s.strategy === 'agents' ? 'selected' : ''}>Directional agents (SCOUT → SENTRY → HAWK)</option>
            <option value="grid" ${s.strategy === 'grid' ? 'selected' : ''}>Grid micro-trading (a grid on every market)</option>
          </select></label>
        <label>Maker fee % (grid fills)
          <input type="number" step="0.01" min="0" max="1" data-set="grid.maker" value="${pctInput(s.grid.maker)}"></label>
        <label>Taker fee % (stop-outs)
          <input type="number" step="0.01" min="0" max="1" data-set="grid.taker" value="${pctInput(s.grid.taker)}"></label>
      </section>
      <section class="card form">
        <h3>HAWK · sizing</h3>
        <label>Starting balance (USDT, applies on reset)
          <input type="number" min="10" data-set="startBalance" value="${s.startBalance}"></label>
        <label>Max risk per trade (% of bank lost at stop)
          <input type="number" step="0.1" min="0.1" max="10" data-set="hawk.maxRiskPerTrade" value="${pctInput(s.hawk.maxRiskPerTrade)}"></label>
        <label>Max leverage (notional / equity)
          <input type="number" step="0.5" min="1" max="10" data-set="hawk.maxLeverage" value="${s.hawk.maxLeverage}"></label>
      </section>
      <section class="card form">
        <h3>SENTRY · gate</h3>
        <label>Min signal confidence (%)
          <input type="number" min="0" max="100" data-set="sentry.minConfidence" value="${pctInput(s.sentry.minConfidence)}"></label>
        <label>Max open positions
          <input type="number" min="1" max="10" data-set="sentry.maxOpen" value="${s.sentry.maxOpen}"></label>
        <label>Daily loss limit (% of day-start equity)
          <input type="number" step="0.5" min="0.5" max="50" data-set="sentry.dailyLossLimit" value="${pctInput(s.sentry.dailyLossLimit)}"></label>
        <label>Cooldown after a loss (bars)
          <input type="number" min="0" max="240" data-set="sentry.cooldownBars" value="${s.sentry.cooldownBars}"></label>
      </section>
      <section class="card">
        <h3>Book</h3>
        <button class="danger" data-act="reset">Reset paper account</button>
        <p class="dim small">Paper trading only: orders are simulated against real (or simulated) prices. No exchange keys are used or stored.
        Past or simulated performance says nothing about future results.</p>
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
      this.engine.updateSettings(PRESETS[el.dataset.preset]);
      this.renderTab(true);
    } else if (el.dataset.act === 'toggle') {
      if (this.engine.running) this.engine.stop();
      else void this.engine.start();
    } else if (el.dataset.act === 'flatten') {
      void this.engine.closeAll();
    } else if (el.dataset.act === 'reset') {
      if (confirm('Reset the paper account? Balance, positions and history will be cleared.')) this.engine.reset();
    }
  }

  private onInput(ev: Event) {
    const el = ev.target as HTMLInputElement | HTMLSelectElement;
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
    const money = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
    const eqC = q('c-equity');
    if (eqC) lineChart(eqC, [{ values: [...e.equity.map((p) => p.v), e.totalEquity()], color: '--up', fill: true }], money, e.startBalance);

    const cC = q('c-candles');
    const s = e.symbols.get(this.symbol);
    if (cC && s) {
      const candles = [...s.candles.slice(-119), ...(s.forming ? [s.forming] : [])];
      candleChart(cC, candles, e.positions.find((p) => p.symbol === this.symbol), e.trades.filter((t) => t.symbol === this.symbol), fmtPrice);
    }

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

    const fC = q('c-fitness');
    if (fC && s) {
      const h = s.evolver.history.slice(-80);
      const clampF = (x: number) => Math.max(-0.2, x);
      lineChart(fC, [
        { values: h.map((x) => clampF(x.mean)), color: '--muted', width: 1 },
        { values: h.map((x) => clampF(x.best)), color: '--up', fill: true },
      ], (v) => v.toFixed(3), 0);
    }

    const kC = q('c-kelly');
    const t = s?.evolver.champion?.test;
    if (kC && t) {
      const { w, payoff } = edgeStats(t);
      kellyChart(kC, w, payoff, Math.min(sizedRisk(w, payoff, 1), 0.6));
    }

    const tC = q('c-trades');
    if (tC) {
      const tr = [...e.trades].slice(0, 60).reverse();
      barsChart(tC, tr.map((x) => x.pnl), tr.map((x) => (x.pnl >= 0 ? '--up' : '--down')));
    }
  }
}

const DEFAULT_POP = 40;

const WIDE_MARKETS = [...DEFAULT_SETTINGS.symbols, 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT', 'SUIUSDT', 'LTCUSDT', 'DOTUSDT', 'NEARUSDT', 'BCHUSDT'];

const PRESETS: Record<string, Partial<Settings>> = {
  grid: { feed: 'replay', strategy: 'grid', interval: '1m', symbols: WIDE_MARKETS, sentry: { ...DEFAULT_SENTRY } },
  replay: { feed: 'replay', strategy: 'agents', interval: '1m', sentry: { ...DEFAULT_SENTRY } },
  fast: {
    feed: 'binance',
    strategy: 'agents',
    interval: '1m',
    symbols: WIDE_MARKETS,
    sentry: { ...DEFAULT_SENTRY, minConfidence: 0.4, cooldownBars: 5, maxOpen: 5 },
  },
  standard: { feed: 'binance', strategy: 'agents', interval: '1m', symbols: DEFAULT_SETTINGS.symbols, sentry: { ...DEFAULT_SENTRY } },
};

/** Fraction → percent for a form field, without float noise like 55.00000000000001. */
const pctInput = (x: number) => String(Math.round(x * 10000) / 100);

function kpi(label: string, value: string, sub: string): string {
  return `<div class="kpi"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
}

function stat(label: string, value: string): string {
  return `<div><small>${label}</small><b>${value}</b></div>`;
}

function meter(score: number, pass: boolean): string {
  const n = 10;
  const on = Math.round(score * n);
  return `<span class="meter ${pass ? '' : 'fail'}">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
}

function funnel(label: string, value: number, max: number): string {
  return `<div class="funnel"><span>${label}</span><div class="bar"><i style="width:${Math.min(100, (value / max) * 100)}%"></i></div><b class="mono">${value}</b></div>`;
}

function stageChip(s: SymbolState): string {
  const label: Record<string, string> = { idle: 'watching', read: 'reading', gate: 'at gate', veto: s.evolver.champion ? 'vetoed' : 'benched', execute: 'executing', hold: 'in position' };
  return `<span class="stage ${s.stage}"><b>${short(s.symbol)}</b>${label[s.stage]}</span>`;
}
