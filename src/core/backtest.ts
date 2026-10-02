import { prepare, signalAt, warmup } from './strategy';
import type { Candle, Dir, Genome } from './types';

export interface BtTrade {
  dir: Dir;
  entry: number;
  exit: number;
  ret: number; // net return as fraction of risked notional (price move * dir - fees)
  r: number; // result in R multiples (1R = stop distance)
  bars: number;
}

export interface BtResult {
  trades: BtTrade[];
  totalReturn: number; // compounded, risking `riskPerTrade` of equity each trade
  maxDrawdown: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  fitness: number;
}

export interface BtOptions {
  feeRate: number; // per side, e.g. 0.0004
  riskPerTrade: number; // fraction of equity lost at stop, e.g. 0.01
  minTrades: number;
}

export const DEFAULT_BT: BtOptions = { feeRate: 0.0004, riskPerTrade: 0.01, minTrades: 4 };

/**
 * Bar-by-bar simulation: signal on close of bar i, fill at open of bar i+1,
 * stops/targets checked against each later bar's high/low (stop assumed first — conservative).
 */
export function backtest(candles: Candle[], g: Genome, opt: BtOptions = DEFAULT_BT): BtResult {
  const p = prepare(candles, g);
  const trades: BtTrade[] = [];
  let pos: { dir: Dir; entry: number; stop: number; take: number; best: number; risk: number; at: number } | null = null;

  for (let i = warmup(g); i < candles.length - 1; i++) {
    const bar = candles[i];
    if (pos) {
      const a = p.atr[i];
      let exit: number | null = null;
      if (pos.dir === 1) {
        if (bar.l <= pos.stop) exit = Math.min(pos.stop, bar.o);
        else if (bar.h >= pos.take) exit = Math.max(pos.take, bar.o);
        else {
          pos.best = Math.max(pos.best, bar.h);
          pos.stop = Math.max(pos.stop, pos.best - g.trailAtr * a);
        }
      } else {
        if (bar.h >= pos.stop) exit = Math.max(pos.stop, bar.o);
        else if (bar.l <= pos.take) exit = Math.min(pos.take, bar.o);
        else {
          pos.best = Math.min(pos.best, bar.l);
          pos.stop = Math.min(pos.stop, pos.best + g.trailAtr * a);
        }
      }
      if (exit !== null) {
        const move = ((exit - pos.entry) / pos.entry) * pos.dir;
        const ret = move - 2 * opt.feeRate;
        trades.push({ dir: pos.dir, entry: pos.entry, exit, ret, r: (ret * pos.entry) / pos.risk, bars: i - pos.at });
        pos = null;
      }
    }
    if (!pos) {
      const s = signalAt(p, g, i);
      if (s.dir !== 0) {
        const entry = candles[i + 1].o;
        const a = p.atr[i];
        const risk = g.stopAtr * a;
        pos = {
          dir: s.dir,
          entry,
          stop: entry - s.dir * risk,
          take: entry + s.dir * g.takeAtr * a,
          best: entry,
          risk,
          at: i + 1,
        };
      }
    }
  }
  return summarize(trades, opt);
}

export function summarize(trades: BtTrade[], opt: BtOptions = DEFAULT_BT): BtResult {
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of trades) {
    eq *= 1 + opt.riskPerTrade * t.r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
  }
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.r, 0) / wins.length : 0;
  const avgLossR = losses.length ? -losses.reduce((s, t) => s + t.r, 0) / losses.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const expectancyR = trades.length ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0;
  const totalReturn = eq - 1;
  // Reward return and consistency, punish drawdown and tiny samples.
  const sample = Math.min(1, trades.length / (opt.minTrades * 3));
  const fitness = trades.length < opt.minTrades ? -1 : (totalReturn - 1.5 * maxDd) * sample + expectancyR * 0.01;
  return { trades, totalReturn, maxDrawdown: maxDd, winRate, avgWinR, avgLossR, expectancyR, fitness };
}
