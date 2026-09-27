import { backtest, type BtOptions, type BtResult, DEFAULT_BT } from './backtest';
import { gauss, uid } from './rng';
import type { Candle, Genome, Regime } from './types';

export interface Scored {
  genome: Genome;
  train: BtResult;
  test: BtResult; // out-of-sample — the only numbers that decide survival
}

export interface GenStats {
  gen: number;
  generated: number;
  backtested: number;
  passedGate: number;
  survivors: number;
  best: number;
  mean: number;
}

export interface EvolverState {
  generation: number;
  population: Genome[];
  tested: number;
  killed: number;
  champion: Scored | null;
  history: GenStats[];
}

export interface EvolverConfig {
  populationSize: number;
  elite: number;
  mutationRate: number;
  trainFraction: number;
  bt: BtOptions;
}

export const DEFAULT_EVOLVER: EvolverConfig = {
  populationSize: 40,
  elite: 6,
  mutationRate: 0.25,
  trainFraction: 0.65,
  bt: DEFAULT_BT,
};

const REGIMES: Regime[] = ['trend', 'meanRevert', 'breakout'];

type NumKey = Exclude<keyof Genome, 'id' | 'regime'>;
export const GENE_RANGES: Record<NumKey, [number, number, boolean]> = {
  // [min, max, integer]
  fast: [3, 30, true],
  slow: [15, 120, true],
  rsiLen: [5, 24, true],
  rsiEdge: [8, 30, false],
  lookback: [8, 80, true],
  volMult: [0.8, 3, false],
  stopAtr: [0.8, 4, false],
  takeAtr: [1, 8, false],
  trailAtr: [0.6, 4, false],
};

const NUM_KEYS = Object.keys(GENE_RANGES) as NumKey[];

function clampGene(k: NumKey, v: number): number {
  const [lo, hi, int] = GENE_RANGES[k];
  const x = Math.max(lo, Math.min(hi, v));
  return int ? Math.round(x) : Math.round(x * 100) / 100;
}

function repair(g: Genome): Genome {
  if (g.slow <= g.fast + 2) g.slow = clampGene('slow', g.fast + 5 + g.slow / 4);
  if (g.slow <= g.fast) g.fast = clampGene('fast', g.slow - 3);
  return g;
}

export function randomGenome(rand: () => number): Genome {
  const g = { id: uid('g'), regime: REGIMES[Math.floor(rand() * REGIMES.length)] } as Genome;
  for (const k of NUM_KEYS) {
    const [lo, hi] = GENE_RANGES[k];
    g[k] = clampGene(k, lo + rand() * (hi - lo));
  }
  return repair(g);
}

export function mutate(g: Genome, rate: number, rand: () => number): Genome {
  const m: Genome = { ...g, id: uid('g') };
  if (rand() < rate / 4) m.regime = REGIMES[Math.floor(rand() * REGIMES.length)];
  for (const k of NUM_KEYS) {
    if (rand() < rate) {
      const [lo, hi] = GENE_RANGES[k];
      m[k] = clampGene(k, m[k] + gauss(rand) * (hi - lo) * 0.12);
    }
  }
  return repair(m);
}

export function crossover(a: Genome, b: Genome, rand: () => number): Genome {
  const c: Genome = { ...a, id: uid('g'), regime: rand() < 0.5 ? a.regime : b.regime };
  for (const k of NUM_KEYS) c[k] = rand() < 0.5 ? a[k] : b[k];
  return repair(c);
}

export function newEvolver(rand: () => number, cfg: EvolverConfig = DEFAULT_EVOLVER): EvolverState {
  return {
    generation: 0,
    population: Array.from({ length: cfg.populationSize }, () => randomGenome(rand)),
    tested: 0,
    killed: 0,
    champion: null,
    history: [],
  };
}

/** Survival gate: must be profitable, with positive expectancy, on data it never trained on. */
export function passesGate(s: Scored, cfg: EvolverConfig): boolean {
  return (
    s.train.fitness > 0 &&
    s.test.trades.length >= Math.max(2, Math.floor(cfg.bt.minTrades / 2)) &&
    s.test.totalReturn > 0 &&
    s.test.expectancyR > 0 &&
    s.test.maxDrawdown < 0.25
  );
}

export function score(g: Genome, candles: Candle[], cfg: EvolverConfig): Scored {
  const split = Math.floor(candles.length * cfg.trainFraction);
  // The test slice keeps some history before the split for indicator warmup; the strategy
  // can only trade bars after warmup, so overlap is limited to indicator context.
  const warm = Math.min(split, 130);
  return {
    genome: g,
    train: backtest(candles.slice(0, split), g, cfg.bt),
    test: backtest(candles.slice(split - warm), g, cfg.bt),
  };
}

/**
 * One generation: observe → hypothesize → backtest → select → mutate.
 * The champion is re-validated on the latest data every generation and dethroned if it fails.
 */
export function step(state: EvolverState, candles: Candle[], rand: () => number, cfg: EvolverConfig = DEFAULT_EVOLVER): EvolverState {
  const scored = state.population.map((g) => score(g, candles, cfg));
  const ranked = [...scored].sort((a, b) => combined(b) - combined(a));
  const survivors = ranked.filter((s) => passesGate(s, cfg));

  let champion = state.champion ? score(state.champion.genome, candles, cfg) : null;
  if (champion && !passesGate(champion, cfg)) champion = null;
  const top = survivors[0];
  if (top && (!champion || combined(top) > combined(champion))) champion = top;

  // Breed the next generation from the elite (tournament selection over the ranked list).
  const elite = ranked.slice(0, cfg.elite).map((s) => s.genome);
  const next: Genome[] = [...elite];
  if (champion && !next.some((g) => g.id === champion!.genome.id)) next[next.length - 1] = champion.genome;
  const pick = () => {
    const a = ranked[Math.floor(rand() * ranked.length)];
    const b = ranked[Math.floor(rand() * ranked.length)];
    return (combined(a) > combined(b) ? a : b).genome;
  };
  while (next.length < cfg.populationSize) {
    // A few fresh immigrants every generation keep diversity up.
    if (rand() < 0.1) next.push(randomGenome(rand));
    else next.push(mutate(crossover(pick(), pick(), rand), cfg.mutationRate, rand));
  }

  const fits = scored.map(combined);
  const stats: GenStats = {
    gen: state.generation + 1,
    generated: cfg.populationSize - cfg.elite,
    backtested: scored.length,
    passedGate: survivors.length,
    survivors: champion ? 1 : 0,
    best: Math.max(...fits),
    mean: fits.reduce((s, x) => s + x, 0) / fits.length,
  };

  return {
    generation: state.generation + 1,
    population: next,
    tested: state.tested + scored.length,
    killed: state.killed + scored.length - survivors.length,
    champion,
    history: [...state.history, stats].slice(-120),
  };
}

export function combined(s: Scored): number {
  if (s.train.fitness < 0 || s.test.fitness < 0) return Math.min(s.train.fitness, s.test.fitness);
  return 0.4 * s.train.fitness + 0.6 * s.test.fitness;
}
