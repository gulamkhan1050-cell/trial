import { describe, expect, it } from 'vitest';
import { breadth, readRegime } from '../src/core/regime';
import type { Candle } from '../src/core/types';

const bars = (fn: (i: number) => number, n = 300, vol = () => 1000): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const o = fn(i - 1);
    const c = fn(i);
    return { t: i * 60_000, o, c, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, v: vol() };
  });

describe('regime', () => {
  it('reads a steady 4 h decline as DOWN, a rise as UP, a range as CHOP', () => {
    expect(readRegime(bars((i) => 100 * (1 - 0.0001 * i))).regime).toBe('down');
    expect(readRegime(bars((i) => 100 * (1 + 0.0001 * i))).regime).toBe('up');
    expect(readRegime(bars((i) => 100 * (1 + 0.004 * Math.sin(i / 10)))).regime).toBe('chop');
  });

  it('flags a sharp sell-off on heavy volume as DOWN before the 4 h trend turns', () => {
    let k = 0;
    const c = bars((i) => (i < 260 ? 100 : 100 * (1 - 0.0003 * (i - 260))), 300, () => (k++ > 240 ? 5000 : 1000));
    const r = readRegime(c);
    expect(r.trend).toBeGreaterThan(-0.015);
    expect(r.regime).toBe('down');
  });

  it('measures market breadth', () => {
    const up = readRegime(bars((i) => 100 * (1 + 0.0001 * i)));
    const dn = readRegime(bars((i) => 100 * (1 - 0.0001 * i)));
    expect(breadth([up, dn, dn, dn])).toBe(0.25);
    expect(breadth([])).toBe(1);
  });
});
