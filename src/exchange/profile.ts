import type { Settings } from '../core/engine';
import type { LiveSettings } from './liveController';
import { DEFAULT_PANIC } from './panic';

/**
 * THE trading profile — fixed. One long grid on all 15 coins at 5x: 8 buys 1.2% apart under the price, each sold
 * one step up, a stop one step under the lowest buy. No FORGE search (its tuned grids lost on real weeks).
 * Crash guard on, reinvest on, a 10% loss limit, and the profit taken (everything sold, new round started)
 * each time a round makes 8% of capital ($40 per $500). Only the network, the API keys and the capital are the user's to choose.
 *
 * Half the money runs the grid on 8 coins; the other half runs PANIC BUY (src/exchange/panic.ts) on the 7 coins that
 * moved most last week: buy a sharp dip (3.6 standard deviations under the 8-hour average), sell back at the average.
 */
export const PROFILE = {
  // Engine replay of 16 real weeks Jun 16 - Oct 6 ($500 a week, reports/): +$17 a week, worst week -$16,
  // 12 of 16 green, 14% worst drop. The FORGE grid at 3x it replaces: -$11 a week, worst -$93, 6 of 16 green, 21% drop.
  // Both-direction (long + short) grids lost on average over 16 weeks at every leverage, so this stays long-only.
  // Step 1.2% (was 2%): ~3x the trades at the same average ($300 replay: 45 vs 15 trades a day, +$11 vs +$10 a week),
  // but a worse worst week (-$34 vs -$10, 22% vs 14% drop). 1.0% traded more still but lost $54 in a week.
  leverage: 5,
  // 16 real weeks, $1000 (reports/combo-...): grid on 8 coins + panic buy at 5x on the 7 most active: +$36 a week,
  // worst week -$30, 13 of 16 green — vs the grid alone on 15 coins: +$20 a week, worst -$78, 11 of 16 green.
  maxCoins: 8,
  panic: DEFAULT_PANIC,
  grid: { spacing: 0.012, levels: 8, stop: 0.012 },
  dailyLossLimit: 0.1,
  compound: true,
  afterTarget: 'restart' as const,
  /** Round target as a share of capital: $40 on $500 (the 16-week replay: 12 of 16 weeks green vs 11 at +6.7%). */
  targetShare: 40 / 500,
};

export const PROFILE_LABEL = '5× · ½ grid (8 buys 1.2% apart, 8 coins) + ½ panic buy (7 most active coins) · reinvest · take profit & restart at +8% · 10% loss limit';

/** Fill the fixed fields into whatever was saved; keeps network, keys and capital. */
export function withProfile(s: LiveSettings): LiveSettings {
  return {
    ...s,
    leverage: PROFILE.leverage,
    maxCoins: PROFILE.maxCoins,
    panic: PROFILE.panic,
    dailyLossLimit: PROFILE.dailyLossLimit,
    compound: PROFILE.compound,
    afterTarget: PROFILE.afterTarget,
    dailyTarget: Math.max(1, Math.round(s.maxCapital * PROFILE.targetShare)),
  };
}

/** The coin picker's settings for this profile (live Binance prices, the 15 liquid coins). */
export function profileGrid(g: Settings['grid']): Settings['grid'] {
  return {
    ...g,
    leverage: PROFILE.leverage,
    crashGuard: true,
    crashDrop: 0.025,
    crashBars: 30,
    crashShare: 0.67,
    classicTp: true,
    regime: false,
    fixed: PROFILE.grid,
    slices: undefined,
    maxSpacing: undefined,
    dailyTarget: undefined,
    afterTarget: undefined,
  };
}
