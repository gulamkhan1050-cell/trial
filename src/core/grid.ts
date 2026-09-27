import { gauss, uid } from './rng';
import type { Candle } from './types';

/**
 * GRID — the micro-trading engine. A long-only ladder of resting limit orders:
 * buys below the price; each filled buy immediately gets a take-profit sell one
 * step higher. Every buy→sell round trip books a small profit, paying maker fees.
 * A hard stop under the ladder liquidates inventory if the market breaks down.
 */

export interface GridGenome {
  id: string;
  spacing: number; // step between levels as a fraction (0.002 = 0.2%)
  levels: number; // number of buy levels under the price
  stop: number; // liquidate if price falls this far below the lowest level
}

export interface GridFees {
  maker: number; // resting limit orders (grid fills)
  taker: number; // market orders (stop-outs)
}

export const DEFAULT_GRID_FEES: GridFees = { maker: 0.0002, taker: 0.0005 };

export interface GridOrder {
  lvl: number;
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  buyPrice?: number; // for sells: the fill price of the buy it closes
}

export interface GridFill {
  kind: 'buy' | 'sell' | 'stop';
  price: number;
  qty: number;
  fee: number;
  cash: number; // change to account cash from this fill (fees and realized PnL)
  roundTrip?: { buy: number; sell: number; pnl: number }; // pnl net of both legs' fees
}

export interface GridState {
  genome: GridGenome;
  orders: GridOrder[];
  center: number;
  capital: number;
  armed: boolean;
}

export class GridBot {
  orders: GridOrder[] = [];
  center = 0;
  capital = 0;
  armed = false;

  constructor(
    public genome: GridGenome,
    public fees: GridFees = DEFAULT_GRID_FEES,
  ) {}

  static restore(s: GridState, fees: GridFees): GridBot {
    const b = new GridBot(s.genome, fees);
    Object.assign(b, { orders: s.orders, center: s.center, capital: s.capital, armed: s.armed });
    return b;
  }

  snapshot(): GridState {
    return { genome: this.genome, orders: this.orders, center: this.center, capital: this.capital, armed: this.armed };
  }

  /** Lay the ladder under `price`, splitting `capital` (quote currency) evenly across levels. */
  arm(price: number, capital: number) {
    const g = this.genome;
    this.center = price;
    this.capital = capital;
    this.armed = true;
    this.orders = [];
    for (let k = 1; k <= g.levels; k++) {
      const p = price * (1 - k * g.spacing);
      this.orders.push({ lvl: k, side: 'buy', price: p, qty: capital / g.levels / p });
    }
  }

  disarm() {
    this.armed = false;
    this.orders = [];
  }

  inventory(): { qty: number; cost: number } {
    let qty = 0;
    let cost = 0;
    for (const o of this.orders) {
      if (o.side === 'sell') {
        qty += o.qty;
        cost += o.qty * (o.buyPrice ?? o.price);
      }
    }
    return { qty, cost };
  }

  unrealized(price: number): number {
    const inv = this.inventory();
    return inv.qty * price - inv.cost;
  }

  stopPrice(): number {
    return this.center * (1 - this.genome.levels * this.genome.spacing) * (1 - this.genome.stop);
  }

  /** Market moved from `a` to `b` (one straight segment). Returns fills in the order they happen. */
  move(a: number, b: number): GridFill[] {
    if (!this.armed || a === b) return [];
    const fills: GridFill[] = [];
    const g = this.genome;
    if (b < a) {
      for (const o of this.orders.filter((o) => o.side === 'buy' && o.price < a && o.price >= b).sort((x, y) => y.price - x.price)) {
        const fee = o.price * o.qty * this.fees.maker;
        fills.push({ kind: 'buy', price: o.price, qty: o.qty, fee, cash: -fee });
        o.side = 'sell';
        o.buyPrice = o.price;
        o.price = o.price * (1 + g.spacing);
      }
      if (b <= this.stopPrice()) fills.push(this.liquidate(b));
    } else {
      for (const o of this.orders.filter((o) => o.side === 'sell' && o.price > a && o.price <= b).sort((x, y) => x.price - y.price)) {
        const buy = o.buyPrice!;
        const fee = o.price * o.qty * this.fees.maker;
        const gross = (o.price - buy) * o.qty;
        const buyFee = buy * o.qty * this.fees.maker;
        fills.push({
          kind: 'sell',
          price: o.price,
          qty: o.qty,
          fee,
          cash: gross - fee,
          roundTrip: { buy, sell: o.price, pnl: gross - fee - buyFee },
        });
        o.side = 'buy';
        o.price = buy;
        delete o.buyPrice;
      }
      // Trail the ladder up when flat and the market leaves it behind.
      if (this.inventory().qty === 0 && b > this.center * (1 + g.spacing)) this.arm(b, this.capital);
    }
    return fills;
  }

  /** Sell all inventory at market (taker fee) and stand the grid down. */
  liquidate(price: number): GridFill {
    const inv = this.inventory();
    const fee = price * inv.qty * this.fees.taker;
    const gross = inv.qty * price - inv.cost;
    const buyFees = inv.cost * this.fees.maker;
    this.disarm();
    return {
      kind: 'stop',
      price,
      qty: inv.qty,
      fee,
      cash: gross - fee,
      roundTrip: { buy: inv.qty ? inv.cost / inv.qty : price, sell: price, pnl: gross - fee - buyFees },
    };
  }
}

/** The intrabar path a candle most likely took: open → first extreme → second extreme → close. */
export function barPath(k: Candle): number[] {
  return k.c < k.o ? [k.o, k.h, k.l, k.c] : [k.o, k.l, k.h, k.c];
}

/**
 * SENTRY's rule for grids: don't lay a long ladder into a sell-off. If the last hour
 * fell by more than 60% of the ladder's depth, wait. Rising markets are fine — the
 * ladder trails up while flat.
 */
export function gridSafe(candles: Candle[], i: number, g: GridGenome, lookback = 60): boolean {
  if (i < lookback) return false;
  const drop = (candles[i - lookback].c - candles[i].c) / candles[i].c;
  return drop < g.spacing * g.levels * 0.6;
}

// ---------------------------------------------------------------- backtest

export interface GridResult {
  profit: number; // fraction of capital, marked to market at the end
  roundTrips: number;
  stops: number;
  maxDrawdown: number;
  fitness: number;
}

export function gridBacktest(candles: Candle[], g: GridGenome, fees: GridFees = DEFAULT_GRID_FEES, cooldown = 30): GridResult {
  const bot = new GridBot(g, fees);
  let cash = 0; // realized PnL relative to capital 1
  let roundTrips = 0;
  let stops = 0;
  let peak = 0;
  let maxDd = 0;
  let wait = 0;
  for (let i = 61; i < candles.length; i++) {
    const k = candles[i];
    if (bot.armed) {
      const path = barPath(k);
      for (let j = 1; j < path.length; j++) {
        for (const f of bot.move(path[j - 1], path[j])) {
          cash += f.cash;
          if (f.kind === 'sell') roundTrips++;
          if (f.kind === 'stop') {
            stops++;
            wait = cooldown;
          }
        }
      }
    } else if (wait > 0) wait--;
    else if (gridSafe(candles, i, g)) bot.arm(k.c, 1);
    const eq = cash + bot.unrealized(k.c);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const profit = cash + bot.unrealized(candles[candles.length - 1].c);
  const sample = Math.min(1, roundTrips / 12);
  // Grids sit on open inventory by design, so drawdown is weighted lighter than for directional trades.
  const fitness = roundTrips < 3 ? -1 : (profit - 0.5 * maxDd) * sample;
  return { profit, roundTrips, stops, maxDrawdown: maxDd, fitness };
}

// ---------------------------------------------------------------- FORGE for grids

export interface GridScored {
  genome: GridGenome;
  train: GridResult;
  test: GridResult;
}

export interface GridForge {
  generation: number;
  population: GridGenome[];
  tested: number;
  killed: number;
  champion: GridScored | null;
  history: { gen: number; best: number; mean: number; passed: number }[];
}

const RANGES = { spacing: [0.0008, 0.012], levels: [3, 16], stop: [0.004, 0.05] } as const;
const POP = 30;

function clampG(g: GridGenome): GridGenome {
  g.spacing = Math.round(Math.max(RANGES.spacing[0], Math.min(RANGES.spacing[1], g.spacing)) * 1e5) / 1e5;
  g.levels = Math.round(Math.max(RANGES.levels[0], Math.min(RANGES.levels[1], g.levels)));
  g.stop = Math.round(Math.max(RANGES.stop[0], Math.min(RANGES.stop[1], g.stop)) * 1e4) / 1e4;
  return g;
}

export function randomGridGenome(rand: () => number): GridGenome {
  const pick = (r: readonly [number, number]) => r[0] + rand() * (r[1] - r[0]);
  // Spacing is sampled log-uniformly: tight and wide grids are equally likely.
  const spacing = Math.exp(Math.log(RANGES.spacing[0]) + rand() * Math.log(RANGES.spacing[1] / RANGES.spacing[0]));
  return clampG({ id: uid('G'), spacing, levels: pick(RANGES.levels), stop: pick(RANGES.stop) });
}

function mutateGrid(a: GridGenome, b: GridGenome, rand: () => number): GridGenome {
  const g: GridGenome = {
    id: uid('G'),
    spacing: (rand() < 0.5 ? a : b).spacing * Math.exp(gauss(rand) * 0.15),
    levels: (rand() < 0.5 ? a : b).levels + Math.round(gauss(rand) * 1.2),
    stop: (rand() < 0.5 ? a : b).stop * Math.exp(gauss(rand) * 0.15),
  };
  return clampG(g);
}

export function newGridForge(rand: () => number): GridForge {
  return { generation: 0, population: Array.from({ length: POP }, () => randomGridGenome(rand)), tested: 0, killed: 0, champion: null, history: [] };
}

export function scoreGrid(g: GridGenome, candles: Candle[], fees: GridFees): GridScored {
  const split = Math.floor(candles.length * 0.6);
  return { genome: g, train: gridBacktest(candles.slice(0, split), g, fees), test: gridBacktest(candles.slice(split - 61), g, fees) };
}

/** `slack` lets a sitting champion keep its crown while it hovers around break-even (hysteresis). */
export function gridPasses(s: GridScored, slack = 0): boolean {
  const minTrips = slack > 0 ? 1 : 3;
  return s.train.profit > -slack && s.test.profit > -slack && s.test.roundTrips >= minTrips && s.test.maxDrawdown < 0.08;
}

const rankOf = (s: GridScored) => (s.train.fitness < 0 || s.test.fitness < 0 ? Math.min(s.train.fitness, s.test.fitness) : 0.4 * s.train.fitness + 0.6 * s.test.fitness);

export function stepGridForge(f: GridForge, candles: Candle[], fees: GridFees, rand: () => number): GridForge {
  const scored = f.population.map((g) => scoreGrid(g, candles, fees)).sort((a, b) => rankOf(b) - rankOf(a));
  const passed = scored.filter((s) => gridPasses(s));
  let champion = f.champion ? scoreGrid(f.champion.genome, candles, fees) : null;
  if (champion && !gridPasses(champion, 0.003)) champion = null;
  // A challenger must clearly beat the incumbent to take over, so the live grid isn't reshuffled on noise.
  if (passed[0] && (!champion || rankOf(passed[0]) > rankOf(champion) * 1.2 + 0.001)) champion = passed[0];

  const next = scored.slice(0, 6).map((s) => s.genome);
  const pick = () => {
    const a = scored[Math.floor(rand() * scored.length)];
    const b = scored[Math.floor(rand() * scored.length)];
    return (rankOf(a) > rankOf(b) ? a : b).genome;
  };
  while (next.length < POP) next.push(rand() < 0.15 ? randomGridGenome(rand) : mutateGrid(pick(), pick(), rand));
  const fits = scored.map(rankOf);
  return {
    generation: f.generation + 1,
    population: next,
    tested: f.tested + scored.length,
    killed: f.killed + scored.length - passed.length,
    champion,
    history: [...f.history, { gen: f.generation + 1, best: Math.max(...fits), mean: fits.reduce((s, x) => s + x, 0) / fits.length, passed: passed.length }].slice(-120),
  };
}
