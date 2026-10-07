import type { Settings } from '../core/engine';
import type { LiveSettings } from './liveController';

/**
 * THE trading profile — fixed. One long grid on all 15 coins at 5x: 8 buys 2% apart under the price, each sold
 * one step up, a stop one step under the lowest buy. No FORGE search (its tuned grids lost on real weeks).
 * Crash guard on, reinvest on, a 10% loss limit, and the profit taken (everything sold, new round started)
 * each time a round makes 8% of capital ($40 per $500). Only the network, the API keys and the capital are the user's to choose.
 */
export const PROFILE = {
  // Engine replay of 16 real weeks Jun 16 - Oct 6 ($500 a week, reports/): +$17 a week, worst week -$16,
  // 12 of 16 green, 14% worst drop. The FORGE grid at 3x it replaces: -$11 a week, worst -$93, 6 of 16 green, 21% drop.
  // Both-direction (long + short) grids lost on average over 16 weeks at every leverage, so this stays long-only.
  leverage: 5,
  maxCoins: 15,
  grid: { spacing: 0.02, levels: 8, stop: 0.02 },
  dailyLossLimit: 0.1,
  compound: true,
  afterTarget: 'restart' as const,
  /** Round target as a share of capital: $40 on $500 (the 16-week replay: 12 of 16 weeks green vs 11 at +6.7%). */
  targetShare: 40 / 500,
};

export const PROFILE_LABEL = '5× fixed grid (8 buys 2% apart) · 15 coins · crash guard · reinvest · take profit & restart at +8% · 10% loss limit';

/** Fill the fixed fields into whatever was saved; keeps network, keys and capital. */
export function withProfile(s: LiveSettings): LiveSettings {
  return {
    ...s,
    leverage: PROFILE.leverage,
    maxCoins: PROFILE.maxCoins,
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
