import { ema, resample } from '../core/indicators';
import type { Position, Trade } from '../core/types';
import type { Candidate } from './scout';

export interface SentryConfig {
  minConfidence: number; // 0..1 signal strength
  minBarVolume: number; // average quote volume per 1-minute bar (USDT); scaled for other timeframes
  maxAtrPct: number; // reject when a single bar's ATR exceeds this % of price
  maxOpen: number;
  dailyLossLimit: number; // fraction of day-start equity; breach halts all entries
  cooldownBars: number; // after a losing trade on a symbol — no revenge entries
}

export const DEFAULT_SENTRY: SentryConfig = {
  minConfidence: 0.55,
  minBarVolume: 50_000,
  maxAtrPct: 1.5,
  maxOpen: 3,
  dailyLossLimit: 0.05,
  cooldownBars: 10,
};

export interface Check {
  name: 'Confidence' | 'Liquidity' | 'Signals agree';
  score: number; // 0..1 (for the meter)
  pass: boolean;
  detail: string;
}

export interface Verdict {
  pass: boolean;
  checks: Check[];
  blockedBy?: string; // portfolio-level veto
}

export interface BookState {
  positions: Position[];
  recentTrades: Trade[];
  dayStartEquity: number;
  dayPnl: number;
  now: number;
  barMs: number; // wall-clock length of one bar (the simulator runs faster than real time)
  barMinutes: number; // market time one bar represents, for scaling the liquidity floor
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** SENTRY has the last word before money moves: three checks on the setup, plus book-level vetoes. */
export function sentry(c: Candidate, book: BookState, cfg: SentryConfig = DEFAULT_SENTRY): Verdict {
  const checks = [confidence(c, cfg), liquidity(c, cfg, book.barMinutes), agreement(c)];
  const blockedBy = bookVeto(c, book, cfg);
  return { pass: !blockedBy && checks.every((k) => k.pass), checks, blockedBy };
}

export function bookVeto(c: Candidate, book: BookState, cfg: SentryConfig): string | undefined {
  if (book.dayPnl <= -cfg.dailyLossLimit * book.dayStartEquity) return 'daily loss limit hit — all entries halted';
  if (book.positions.some((p) => p.symbol === c.symbol)) return 'already in position';
  if (book.positions.length >= cfg.maxOpen) return `max ${cfg.maxOpen} open positions`;
  const lastLoss = book.recentTrades.find((t) => t.symbol === c.symbol && t.pnl < 0);
  if (lastLoss && book.now - lastLoss.closedAt < cfg.cooldownBars * book.barMs) return 'cooldown after loss (no revenge entries)';
  return undefined;
}

function confidence(c: Candidate, cfg: SentryConfig): Check {
  const edge = c.champion.test.expectancyR;
  const edgeScore = clamp01(edge / 0.5);
  const score = clamp01(0.6 * c.signal.strength + 0.4 * edgeScore);
  const pass = c.signal.strength >= cfg.minConfidence && edge > 0;
  return { name: 'Confidence', score, pass, detail: `strength ${(c.signal.strength * 100).toFixed(0)}% · edge ${edge.toFixed(2)}R` };
}

function liquidity(c: Candidate, cfg: SentryConfig, barMinutes: number): Check {
  const recent = c.candles.slice(-20);
  const avgVol = recent.reduce((s, k) => s + k.v, 0) / recent.length;
  const atrPct = (c.atr / c.price) * 100;
  const floor = cfg.minBarVolume * barMinutes;
  const volOk = avgVol >= floor;
  const atrOk = atrPct <= cfg.maxAtrPct;
  const score = clamp01(avgVol / (floor * 2)) * (atrOk ? 1 : 0.3);
  return {
    name: 'Liquidity',
    score,
    pass: volOk && atrOk,
    detail: `${fmtCompact(avgVol)}/bar · ATR ${atrPct.toFixed(2)}%`,
  };
}

function agreement(c: Candidate): Check {
  const dir = c.signal.dir;
  const closes = c.candles.map((k) => k.c);
  const n = closes.length - 1;
  const htf = resample(c.candles, 5).map((k) => k.c);
  const htfEma = ema(htf, 20);
  const slope = htfEma[htfEma.length - 1] - htfEma[htfEma.length - 4];
  const lastBar = c.candles[n];

  const votes: boolean[] = [];
  if (c.champion.genome.regime === 'meanRevert') {
    // Counter-trend by design: only require the higher timeframe not to be running hard against us.
    const htfStrength = Math.abs(slope) / (c.atr * 3 || 1);
    votes.push(Math.sign(slope) === dir || htfStrength < 0.5);
  } else {
    votes.push(Math.sign(slope) === dir);
  }
  votes.push(Math.sign(closes[n] - closes[n - 3]) === dir);
  votes.push(Math.sign(lastBar.c - lastBar.o) === dir);

  const agree = votes.filter(Boolean).length;
  return { name: 'Signals agree', score: agree / votes.length, pass: agree >= 2, detail: `${agree}/${votes.length} agree` };
}

export function fmtCompact(x: number): string {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
}
