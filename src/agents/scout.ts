import type { Scored } from '../core/evolver';
import { prepare, signalAt } from '../core/strategy';
import type { Candle, Signal } from '../core/types';

export interface Candidate {
  symbol: string;
  signal: Signal;
  champion: Scored;
  price: number;
  atr: number;
  candles: Candle[];
}

/** SCOUT reads every closed bar with the symbol's current champion strategy and reports setups. */
export function scout(symbol: string, candles: Candle[], champion: Scored | null): Candidate | null {
  if (!champion || candles.length < 50) return null;
  const g = champion.genome;
  // Only the recent window is needed for a signal; keeps per-bar cost flat.
  const window = candles.slice(-Math.max(200, g.slow * 3));
  const p = prepare(window, g);
  const i = window.length - 1;
  const signal = signalAt(p, g, i);
  if (signal.dir === 0) return null;
  return { symbol, signal, champion, price: window[i].c, atr: p.atr[i], candles: window };
}
