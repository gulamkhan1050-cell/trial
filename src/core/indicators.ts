import type { Candle } from './types';

export function ema(values: number[], len: number): number[] {
  const out = new Array<number>(values.length);
  const k = 2 / (len + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], len: number): number[] {
  const out = new Array<number>(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    out[i] = sum / Math.min(i + 1, len);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(values: number[], len: number): number[] {
  const out = new Array<number>(values.length).fill(50);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= len) {
      gain += g / len;
      loss += l / len;
    } else {
      gain = (gain * (len - 1) + g) / len;
      loss = (loss * (len - 1) + l) / len;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder ATR. */
export function atr(candles: Candle[], len: number): number[] {
  const out = new Array<number>(candles.length);
  let prev = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr =
      i === 0
        ? c.h - c.l
        : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
    prev = i === 0 ? tr : i < len ? (prev * i + tr) / (i + 1) : (prev * (len - 1) + tr) / len;
    out[i] = prev;
  }
  return out;
}

export function stdev(values: number[], len: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - len + 1);
    const n = i - from + 1;
    let m = 0;
    for (let j = from; j <= i; j++) m += values[j];
    m /= n;
    let s = 0;
    for (let j = from; j <= i; j++) s += (values[j] - m) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function highest(values: number[], end: number, len: number): number {
  let h = -Infinity;
  for (let i = Math.max(0, end - len); i < end; i++) h = Math.max(h, values[i]);
  return h;
}

export function lowest(values: number[], end: number, len: number): number {
  let l = Infinity;
  for (let i = Math.max(0, end - len); i < end; i++) l = Math.min(l, values[i]);
  return l;
}

/** Merge every `n` candles into one (used for higher-timeframe confirmation). */
export function resample(candles: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  const start = candles.length % n;
  for (let i = start; i < candles.length; i += n) {
    const chunk = candles.slice(i, i + n);
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map((c) => c.h)),
      l: Math.min(...chunk.map((c) => c.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((s, c) => s + c.v, 0),
    });
  }
  return out;
}
