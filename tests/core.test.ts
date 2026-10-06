import { describe, expect, it } from 'vitest';
import { ema, rsi, atr, resample } from '../src/core/indicators';
import { backtest } from '../src/core/backtest';
import { edgeStats, kelly, sizedRisk } from '../src/core/kelly';
import { mulberry32 } from '../src/core/rng';
import { newEvolver, passesGate, step, DEFAULT_EVOLVER, randomGenome } from '../src/core/evolver';
import { prepare, signalAt } from '../src/core/strategy';
import { SimFeed } from '../src/core/market';
import type { Candle, Genome, Position } from '../src/core/types';
import { manage } from '../src/agents/hawk';
import { sentry, DEFAULT_SENTRY } from '../src/agents/sentry';
import type { Candidate } from '../src/agents/scout';

function series(fn: (i: number) => number, n = 400): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = fn(i - 1 < 0 ? 0 : i - 1);
    const c = fn(i);
    return { t: i * 60000, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1e6 };
  });
}

async function simCandles(n: number, seed = 42): Promise<Candle[]> {
  let out: Candle[] = [];
  await new SimFeed(1000, seed, n).start(['BTCUSDT'], {
    onHistory: (_s, c) => (out = c),
    onCandle: () => {},
    onStatus: () => {},
  }).then(() => undefined);
  return out;
}

const trendGenome: Genome = {
  id: 'test', regime: 'trend', fast: 5, slow: 20, rsiLen: 14, rsiEdge: 20,
  lookback: 20, volMult: 1, stopAtr: 2, takeAtr: 4, trailAtr: 2,
};

describe('indicators', () => {
  it('ema converges to a constant series', () => {
    expect(ema(Array(50).fill(10), 9).at(-1)).toBeCloseTo(10);
  });
  it('rsi is 100 on a monotonic rise and ~0 on a fall', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(up.slice().reverse(), 14).at(-1)).toBeLessThan(1);
  });
  it('atr is positive and resample merges bars', () => {
    const c = series((i) => 100 + Math.sin(i / 5) * 3, 100);
    expect(atr(c, 14).at(-1)).toBeGreaterThan(0);
    const r = resample(c, 5);
    expect(r).toHaveLength(20);
    expect(r[0].h).toBe(Math.max(...c.slice(0, 5).map((k) => k.h)));
  });
});

describe('strategy + backtest', () => {
  it('signals do not change when future bars are appended (no look-ahead)', () => {
    const c = series((i) => 100 + Math.sin(i / 9) * 8 + i * 0.02, 300);
    const a = prepare(c.slice(0, 200), trendGenome);
    const b = prepare(c, trendGenome);
    for (let i = 30; i < 200; i++) expect(signalAt(a, trendGenome, i)).toEqual(signalAt(b, trendGenome, i));
  });

  it('a trend strategy makes money on a clean oscillating uptrend and pays fees', () => {
    const c = series((i) => 100 * Math.exp(i * 0.001) + Math.sin(i / 15) * 6, 600);
    const r = backtest(c, trendGenome);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.totalReturn).toBeGreaterThan(0);
    // Fees make a flat round trip a loss.
    const flat = series(() => 100, 200);
    expect(backtest(flat, trendGenome).trades.every((t) => t.ret <= 0)).toBe(true);
  });
});

describe('kelly', () => {
  it('matches the textbook formula and is capped at half-Kelly', () => {
    expect(kelly(0.6, 1)).toBeCloseTo(0.2);
    expect(kelly(0.4, 1)).toBeLessThan(0);
    expect(sizedRisk(0.6, 1, 1)).toBeCloseTo(0.1);
    expect(sizedRisk(0.6, 1, 0.02)).toBe(0.02);
    expect(sizedRisk(0.3, 1, 0.02)).toBe(0);
  });
  it('does not treat a small perfect sample as certainty', () => {
    const t = { trades: Array(8).fill({ r: 2 }), avgWinR: 2, avgLossR: 0 };
    const { w, payoff } = edgeStats(t);
    expect(w).toBeCloseTo(0.9);
    expect(payoff).toBe(2);
    expect(kelly(w, payoff)).toBeLessThan(1);
  });
});

describe('FORGE evolver', () => {
  it('evolves, counts kills, and any champion passes the out-of-sample gate', async () => {
    const candles = await simCandles(600, 7);
    const rand = mulberry32(1);
    let s = newEvolver(rand);
    for (let i = 0; i < 6; i++) s = step(s, candles, rand);
    expect(s.generation).toBe(6);
    expect(s.tested).toBe(6 * DEFAULT_EVOLVER.populationSize);
    expect(s.population).toHaveLength(DEFAULT_EVOLVER.populationSize);
    expect(s.killed).toBeGreaterThan(0);
    if (s.champion) expect(passesGate(s.champion, DEFAULT_EVOLVER)).toBe(true);
  });

  it('random genomes respect gene ranges', () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const g = randomGenome(rand);
      expect(g.slow).toBeGreaterThan(g.fast);
      expect(g.stopAtr).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe('HAWK', () => {
  const pos = (): Position => ({
    id: 'p', symbol: 'BTCUSDT', dir: 1, qty: 1, entry: 100, stop: 98, take: 110,
    trailAtr: 1, atr: 1, best: 100, openedAt: 0, genomeId: 'g',
  });
  const tick = (px: number): Candle => ({ t: 0, o: px, h: px, l: px, c: px, v: 0 });

  it('trails the stop up and never loosens it', () => {
    const p = pos();
    expect(manage(p, tick(105))).toBeNull();
    expect(p.stop).toBe(104);
    expect(manage(p, tick(104.5))).toBeNull();
    expect(p.stop).toBe(104);
    expect(manage(p, tick(103.9))).toEqual({ price: 103.9, reason: 'trail stop' });
  });

  it('takes profit at the target', () => {
    expect(manage(pos(), tick(111))?.reason).toBe('target');
  });
});

describe('SENTRY', () => {
  const cand = (strength: number): Candidate => {
    const candles = series((i) => 100 + i * 0.1, 200);
    return {
      symbol: 'BTCUSDT',
      signal: { dir: 1, strength, reason: 'test' },
      champion: {
        genome: trendGenome,
        train: backtest(candles, trendGenome),
        test: { trades: [], totalReturn: 0.05, maxDrawdown: 0.01, winRate: 0.6, avgWinR: 1.5, avgLossR: 1, expectancyR: 0.5, fitness: 1 },
      },
      price: candles.at(-1)!.c,
      atr: 0.2,
      candles,
    };
  };
  const book = { positions: [], recentTrades: [], dayStartEquity: 1000, dayPnl: 0, now: Date.now(), barMs: 60_000, barMinutes: 1 };

  it('passes a strong, liquid, aligned setup', () => {
    expect(sentry(cand(0.9), book).pass).toBe(true);
  });
  it('vetoes a weak signal', () => {
    const v = sentry(cand(0.2), book);
    expect(v.pass).toBe(false);
    expect(v.checks.find((c) => c.name === 'Confidence')?.pass).toBe(false);
  });
  it('scales the liquidity floor to the candle length', () => {
    // 1e6 per bar passes on 1m candles but is thin for 1s-equivalent floor * 60 (a 60-minute bar).
    expect(sentry(cand(0.9), { ...book, barMinutes: 1 }).checks[1].pass).toBe(true);
    expect(sentry(cand(0.9), { ...book, barMinutes: 60 }).checks[1].pass).toBe(false);
    expect(sentry(cand(0.9), { ...book, barMinutes: 1 / 60 }).checks[1].pass).toBe(true);
  });
  it('halts everything after the daily loss limit', () => {
    const v = sentry(cand(0.9), { ...book, dayPnl: -1000 * DEFAULT_SENTRY.dailyLossLimit });
    expect(v.pass).toBe(false);
    expect(v.blockedBy).toMatch(/daily loss/);
  });
  it('blocks revenge entries after a loss', () => {
    const loss = { id: 't', symbol: 'BTCUSDT', dir: 1 as const, qty: 1, entry: 1, exit: 1, pnl: -5, fees: 0, openedAt: 0, closedAt: Date.now() - 1000, reason: 'stop hit' };
    expect(sentry(cand(0.9), { ...book, recentTrades: [loss] }).blockedBy).toMatch(/cooldown/);
  });
});
