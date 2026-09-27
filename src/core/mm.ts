import { mulberry32 } from './rng';
import type { Candle } from './types';

/**
 * MM — a two-sided market maker for 1-second bars. Every second it rests a bid just
 * under the mid and an ask just over it, earns the spread when both sides fill, and
 * skews its quotes against its inventory so it keeps flipping back toward flat.
 *
 * Fill model: a quote fills only when price trades *through* it (a touch is not enough),
 * and then only with probability `fillProb` — standing in for queue position we can't see.
 */

export interface MMParams {
  halfSpread: number; // quote distance from mid, fraction (0.0001 = 0.01%)
  skew: number; // how far quotes shift per unit of inventory, in half-spreads
  maxInv: number; // max inventory in quote-size units, each side
  size: number; // notional per quote as a fraction of equity (with leverage)
}

export interface MMFees {
  maker: number; // negative = rebate
  taker: number;
}

export interface MMOptions {
  fillProb: number;
  stop: number; // flatten and pause if open inventory loses this fraction of equity
  pauseBars: number;
  seed: number;
}

export const DEFAULT_MM_OPTIONS: MMOptions = { fillProb: 0.5, stop: 0.02, pauseBars: 300, seed: 1 };

export interface MMResult {
  equity: { t: number; v: number }[];
  start: number;
  final: number;
  fills: number;
  roundTrips: number;
  volume: number; // traded notional
  fees: number; // net fees paid (negative = rebates earned)
  maxDrawdown: number;
  stops: number;
}

export function runMM(candles: Candle[], p: MMParams, fees: MMFees, capital = 1000, opt: MMOptions = DEFAULT_MM_OPTIONS, sampleEvery = 60): MMResult {
  const rand = mulberry32(opt.seed);
  let cash = capital;
  let inv = 0; // coin quantity, can be negative (perp-style short)
  let fills = 0;
  let volume = 0;
  let feesPaid = 0;
  let pause = 0;
  let stops = 0;
  let peak = capital;
  let maxDd = 0;
  let crossings = 0; // inventory sign flips ≈ completed round trips
  const equity: { t: number; v: number }[] = [];

  for (let i = 1; i < candles.length; i++) {
    const k = candles[i];
    const mid = candles[i - 1].c;
    const eqNow = cash + inv * mid;
    const unit = (eqNow * p.size) / mid; // coin qty per quote
    const units = unit > 0 ? inv / unit : 0;

    if (pause > 0) pause--;
    else {
      // Inventory skew: long → both quotes move down (sell sooner, buy later), and vice versa.
      const shift = -p.skew * units * p.halfSpread;
      const bid = mid * (1 - p.halfSpread + shift);
      const ask = mid * (1 + p.halfSpread + shift);
      const path = k.c < k.o ? [k.o, k.h, k.l, k.c] : [k.o, k.l, k.h, k.c];
      let bidDone = false;
      let askDone = false;
      for (let j = 1; j < path.length; j++) {
        const lo = Math.min(path[j - 1], path[j]);
        const hi = Math.max(path[j - 1], path[j]);
        if (!bidDone && lo < bid && units < p.maxInv) {
          bidDone = true;
          if (rand() < opt.fillProb) {
            const before = inv;
            inv += unit;
            cash -= unit * bid;
            const fee = unit * bid * fees.maker;
            cash -= fee;
            feesPaid += fee;
            volume += unit * bid;
            fills++;
            if (before < 0 && inv >= 0) crossings++;
          }
        }
        if (!askDone && hi > ask && units > -p.maxInv) {
          askDone = true;
          if (rand() < opt.fillProb) {
            const before = inv;
            inv -= unit;
            cash += unit * ask;
            const fee = unit * ask * fees.maker;
            cash -= fee;
            feesPaid += fee;
            volume += unit * ask;
            fills++;
            if (before > 0 && inv <= 0) crossings++;
          }
        }
      }
    }

    // Risk: while holding inventory, if equity falls `stop` below its peak, dump it at market.
    const eq = cash + inv * k.c;
    const invValue = inv * k.c;
    const drawFromPeak = peak > 0 ? 1 - eq / peak : 0;
    if (inv !== 0 && drawFromPeak > opt.stop && pause === 0) {
      const fee = Math.abs(invValue) * fees.taker;
      cash += invValue - fee;
      feesPaid += fee;
      volume += Math.abs(invValue);
      inv = 0;
      stops++;
      pause = opt.pauseBars;
    }
    const v = cash + inv * k.c;
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, 1 - v / peak);
    if (i % sampleEvery === 0 || i === candles.length - 1) equity.push({ t: k.t, v });
  }
  return {
    equity,
    start: capital,
    final: cash + inv * candles[candles.length - 1].c,
    fills,
    roundTrips: Math.max(crossings, Math.floor(fills / 2)),
    volume,
    fees: feesPaid,
    maxDrawdown: maxDd,
    stops,
  };
}

/** Candidate settings the tuner searches over. */
export function mmGrid(): MMParams[] {
  const out: MMParams[] = [];
  for (const halfSpread of [0.00005, 0.0001, 0.0002, 0.0003, 0.0005, 0.001])
    for (const skew of [0.5, 1, 2])
      for (const maxInv of [3, 6]) out.push({ halfSpread, skew, maxInv, size: 0.1 });
  return out;
}

/** Pick the settings that did best on the training slice (profit minus half the drawdown). */
export function tuneMM(train: Candle[], fees: MMFees, opt: MMOptions = DEFAULT_MM_OPTIONS): { params: MMParams; score: number } {
  let best = { params: mmGrid()[0], score: -Infinity };
  for (const params of mmGrid()) {
    const r = runMM(train, params, fees, 1000, opt, 1e9);
    const score = (r.final - r.start) / r.start - 0.5 * r.maxDrawdown;
    if (score > best.score) best = { params, score };
  }
  return best;
}
