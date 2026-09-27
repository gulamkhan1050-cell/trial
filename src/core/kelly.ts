/**
 * Kelly fraction for a bet that wins `payoff` R with prob `w` and loses 1R otherwise.
 * Returned value is the fraction of equity to put at risk (i.e. lose at the stop).
 */
export function kelly(w: number, payoff: number): number {
  if (payoff <= 0) return 0;
  return w - (1 - w) / payoff;
}

/** Expected log growth per bet at risk fraction f. */
export function logGrowth(f: number, w: number, payoff: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return -Infinity;
  return w * Math.log(1 + f * payoff) + (1 - w) * Math.log(1 - f);
}

/**
 * Win probability and payoff ratio estimated from backtest trades (R multiples).
 * Win rate gets a Laplace prior so a lucky 8/8 sample is not read as certainty,
 * and a sample with no losses assumes the nominal 1R stop loss.
 */
export function edgeStats(t: { trades: { r: number }[]; avgWinR: number; avgLossR: number }): { w: number; payoff: number } {
  const n = t.trades.length;
  const wins = t.trades.filter((x) => x.r > 0).length;
  const w = (wins + 1) / (n + 2);
  const payoff = t.avgWinR / (t.avgLossR > 0 ? t.avgLossR : 1);
  return { w, payoff };
}

/** Half-Kelly clamped to [0, cap] — full Kelly is far too aggressive on noisy estimates. */
export function sizedRisk(w: number, payoff: number, cap: number): number {
  return Math.max(0, Math.min(cap, kelly(w, payoff) / 2));
}
