import { BINANCE_PUBLIC, SimFeed } from './market';
import { DEFAULT_MM_OPTIONS, type MMParams, runMM, tuneMM } from './mm';
import type { Candle } from './types';
import type { ArenaProgress } from './arena';

/**
 * 1-second market-making arena: download real Binance 1s bars (or simulate them), tune the
 * market maker per coin on the first quarter, then run it on the remaining three quarters
 * at several maker-fee levels so the effect of fees is visible side by side.
 */

export interface MMArenaOptions {
  symbols: string[];
  hours: number;
  source: 'real' | 'sim';
  makerFees: number[]; // fractions; negative = rebate
  takerFee: number;
  fillProb: number;
  capital: number;
  onProgress?: (p: ArenaProgress) => void;
  signal?: { cancelled: boolean };
}

export interface MMArenaResult {
  name: string;
  maker: number;
  equity: { t: number; v: number }[];
  start: number;
  final: number;
  fills: number;
  volume: number;
  fees: number;
  maxDrawdown: number;
  stops: number;
  params: Record<string, MMParams>;
}

async function download1s(symbol: string, bars: number, onPage: () => void, signal?: { cancelled: boolean }): Promise<Candle[]> {
  const out: Candle[] = [];
  let end: number | undefined;
  while (out.length < bars + 1 && !signal?.cancelled) {
    const url = `${BINANCE_PUBLIC.rest}/api/v3/klines?symbol=${symbol}&interval=1s&limit=1000${end ? `&endTime=${end}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const rows = (await res.json()) as [number, string, string, string, string, string, number, string][];
    if (!rows.length) break;
    out.unshift(...rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })));
    end = rows[0][0] - 1;
    onPage();
  }
  return out.slice(0, -1).slice(-bars);
}

export async function runMMArena(opt: MMArenaOptions): Promise<{ results: MMArenaResult[]; note: string; source: 'real' | 'sim' }> {
  const bars = Math.round(opt.hours * 3600);
  const data: Record<string, Candle[]> = {};
  let source: 'real' | 'sim' = opt.source;
  let note = '';
  if (opt.source === 'real') {
    try {
      const pagesPer = Math.ceil(bars / 1000) + 1;
      let pages = 0;
      const total = pagesPer * opt.symbols.length;
      for (const s of opt.symbols) {
        data[s] = await download1s(
          s,
          bars,
          () => {
            pages++;
            if (pages % 3 === 0) opt.onProgress?.({ stage: 'download', pct: pages / total, text: `downloading 1-second bars · ${s} · ${pages}/${total} pages` });
          },
          opt.signal,
        );
      }
      const f = (t: number) => new Date(t).toLocaleString();
      const first = data[opt.symbols[0]];
      note = `real Binance 1s prices · ${f(first[0].t)} → ${f(first[first.length - 1].t)}`;
    } catch (err) {
      opt.onProgress?.({ stage: 'download', pct: 1, text: `Binance unreachable (${(err as Error).message}) — using offline data` });
      source = 'sim';
    }
  }
  if (source === 'sim') {
    for (const [i, s] of opt.symbols.entries()) {
      // Simulated minute bars scaled to 1-second volatility and relabelled one second apart.
      let c: Candle[] = [];
      await new SimFeed(1000, 104729 * (i + 1), bars, 0.13).start([s], { onHistory: (_x, h) => (c = h), onCandle() {}, onStatus() {} });
      const t0 = Date.now() - bars * 1000;
      data[s] = c.map((k, j) => ({ ...k, t: t0 + j * 1000 }));
    }
    note = 'offline simulated 1s prices';
  }

  const len = Math.min(...opt.symbols.map((s) => data[s].length));
  if (len < 600) throw new Error('not enough 1-second history');
  const split = Math.floor(len * 0.25);
  const per = opt.capital / opt.symbols.length;
  const mmOpt = { ...DEFAULT_MM_OPTIONS, fillProb: opt.fillProb };

  const results: MMArenaResult[] = [];
  for (const [fi, maker] of opt.makerFees.entries()) {
    if (opt.signal?.cancelled) break;
    const fees = { maker, taker: opt.takerFee };
    const params: Record<string, MMParams> = {};
    let combined: { t: number; v: number }[] = [];
    let fills = 0;
    let volume = 0;
    let feesPaid = 0;
    let stops = 0;
    for (const [si, s] of opt.symbols.entries()) {
      opt.onProgress?.({
        stage: 'run',
        pct: (fi * opt.symbols.length + si) / (opt.makerFees.length * opt.symbols.length),
        text: `tuning & running ${s} at maker ${(maker * 100).toFixed(3)}%`,
      });
      await new Promise((r) => setTimeout(r, 0));
      const series = data[s].slice(0, len);
      const tuned = tuneMM(series.slice(0, split), fees, mmOpt);
      params[s] = tuned.params;
      const r = runMM(series.slice(split), tuned.params, fees, per, { ...mmOpt, seed: si + 1 }, 60);
      fills += r.fills;
      volume += r.volume;
      feesPaid += r.fees;
      stops += r.stops;
      combined = combined.length ? combined.map((p, j) => ({ t: p.t, v: p.v + (r.equity[j]?.v ?? r.final) })) : r.equity.map((p) => ({ ...p }));
    }
    let peak = opt.capital;
    let maxDd = 0;
    for (const p of combined) {
      peak = Math.max(peak, p.v);
      maxDd = Math.max(maxDd, 1 - p.v / peak);
    }
    results.push({
      name: `MM · maker ${maker < 0 ? 'rebate ' : ''}${(Math.abs(maker) * 100).toFixed(3)}%`,
      maker,
      equity: combined,
      start: opt.capital,
      final: combined.length ? combined[combined.length - 1].v : opt.capital,
      fills,
      volume,
      fees: feesPaid,
      maxDrawdown: maxDd,
      stops,
      params,
    });
  }
  opt.onProgress?.({ stage: 'done', pct: 1, text: 'done' });
  return { results, note, source };
}
