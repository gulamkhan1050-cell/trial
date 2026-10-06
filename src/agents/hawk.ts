import { edgeStats, sizedRisk } from '../core/kelly';
import { uid } from '../core/rng';
import type { Candle, Position } from '../core/types';
import type { Candidate } from './scout';

export interface HawkConfig {
  maxRiskPerTrade: number; // cap on fraction of equity lost if the stop is hit
  maxLeverage: number; // cap on notional / equity
}

export const DEFAULT_HAWK: HawkConfig = { maxRiskPerTrade: 0.02, maxLeverage: 3 };

export interface Order {
  position: Omit<Position, 'entry' | 'stop' | 'take' | 'best'>;
  riskFraction: number;
  stopDist: number;
  takeDist: number;
}

/** HAWK sizes to the bank (half-Kelly from out-of-sample stats), never to mood. */
export function plan(c: Candidate, equity: number, cfg: HawkConfig = DEFAULT_HAWK): Order | null {
  const g = c.champion.genome;
  const { w, payoff } = edgeStats(c.champion.test);
  const riskFraction = sizedRisk(w, payoff, cfg.maxRiskPerTrade);
  if (riskFraction <= 0) return null;
  const stopDist = g.stopAtr * c.atr;
  let qty = (equity * riskFraction) / stopDist;
  qty = Math.min(qty, (equity * cfg.maxLeverage) / c.price);
  if (!(qty > 0) || !isFinite(qty)) return null;
  return {
    position: {
      id: uid('p'),
      symbol: c.symbol,
      dir: c.signal.dir as 1 | -1,
      qty,
      trailAtr: g.trailAtr,
      atr: c.atr,
      openedAt: Date.now(),
      genomeId: g.id,
    },
    riskFraction,
    stopDist,
    takeDist: g.takeAtr * c.atr,
  };
}

/**
 * Update the trailing stop with the latest candle and report an exit if stop/target was touched.
 * Mutates `p.best` and `p.stop` (the stop only ever tightens).
 */
export function manage(p: Position, k: Candle): { price: number; reason: string } | null {
  if (p.dir === 1) {
    if (k.l <= p.stop) return { price: Math.min(p.stop, k.c), reason: p.stop > p.entry ? 'trail stop' : 'stop hit' };
    if (k.h >= p.take) return { price: p.take, reason: 'target' };
    p.best = Math.max(p.best, k.h);
    p.stop = Math.max(p.stop, p.best - p.trailAtr * p.atr);
  } else {
    if (k.h >= p.stop) return { price: Math.max(p.stop, k.c), reason: p.stop < p.entry ? 'trail stop' : 'stop hit' };
    if (k.l <= p.take) return { price: p.take, reason: 'target' };
    p.best = Math.min(p.best, k.l);
    p.stop = Math.min(p.stop, p.best + p.trailAtr * p.atr);
  }
  return null;
}

export function unrealized(p: Position, price: number): number {
  return (price - p.entry) * p.qty * p.dir;
}
