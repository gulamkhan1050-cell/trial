import type { Settings } from '../core/engine';
import type { LiveSettings } from './liveController';

/**
 * THE trading profile — fixed. Classic grid at 3x on up to 8 coins (5x ran green on Demo but lost
 * on the next real week: the optimizer report in reports/ shows why), crash guard on, reinvest on, a 20% loss limit, and the
 * profit taken (everything sold, new round started) each time a round makes ~6.7% of capital
 * ($20 per $300). Only the network, the API keys and the capital are the user's to choose.
 */
export const PROFILE = {
  // 3x: the 9-day real-price optimizer (Sep 27 - Oct 6, $200) — the only setting that made money in both the
  // tune week and the unseen 2 days, with half the worst drop of 5x (13.4% vs 25.9%). 5x lost $14.60 there.
  leverage: 3,
  maxCoins: 8,
  dailyLossLimit: 0.2,
  compound: true,
  afterTarget: 'restart' as const,
  /** Round target as a share of capital: $20 on $300. */
  targetShare: 20 / 300,
};

export const PROFILE_LABEL = '3× classic grid · 8 coins · crash guard · reinvest · take profit & restart at +6.7% · 20% loss limit';

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
    slices: undefined,
    maxSpacing: undefined,
    dailyTarget: undefined,
    afterTarget: undefined,
  };
}
