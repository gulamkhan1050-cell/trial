import { logGrowth } from '../core/kelly';
import type { Candle, Position, Trade } from '../core/types';

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setup(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `10px ${css('--mono')}`;
  return { ctx, w, h };
}

function gridY(ctx: CanvasRenderingContext2D, w: number, top: number, bottom: number, min: number, max: number, fmt: (v: number) => string) {
  ctx.strokeStyle = css('--grid');
  ctx.fillStyle = css('--muted');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = Math.round(top + ((bottom - top) * i) / 3) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(fmt(max - ((max - min) * i) / 3), 4, y - 3);
  }
}

export interface Series {
  values: number[];
  color: string; // css var name
  fill?: boolean;
  width?: number;
}

export function lineChart(canvas: HTMLCanvasElement, series: Series[], fmt: (v: number) => string, baseline?: number) {
  const { ctx, w, h } = setup(canvas);
  const all = series.flatMap((s) => s.values).concat(baseline !== undefined ? [baseline] : []);
  if (all.length < 2) return;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < 1e-9) {
    max += 1;
    min -= 1;
  }
  const pad = (max - min) * 0.1;
  min -= pad;
  max += pad;
  const top = 16;
  const bottom = h - 6;
  gridY(ctx, w, top, bottom, min, max, fmt);
  const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);

  if (baseline !== undefined) {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = css('--muted');
    ctx.beginPath();
    ctx.moveTo(0, y(baseline));
    ctx.lineTo(w, y(baseline));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const s of series) {
    const n = s.values.length;
    if (n < 2) continue;
    const x = (i: number) => (i / (n - 1)) * (w - 2) + 1;
    const color = css(s.color);
    ctx.beginPath();
    s.values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    if (s.fill) {
      ctx.save();
      ctx.lineTo(x(n - 1), bottom);
      ctx.lineTo(x(0), bottom);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, color + '55');
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      s.values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = s.width ?? 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // End-point marker.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x(n - 1), y(s.values[n - 1]), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function candleChart(
  canvas: HTMLCanvasElement,
  candles: Candle[],
  position: Position | undefined,
  trades: Trade[],
  fmt: (v: number) => string,
) {
  const { ctx, w, h } = setup(canvas);
  if (candles.length < 2) return;
  const volH = 34;
  const top = 16;
  const bottom = h - volH - 6;
  const levels = position ? [position.stop, position.take, position.entry] : [];
  let min = Math.min(...candles.map((c) => c.l), ...levels);
  let max = Math.max(...candles.map((c) => c.h), ...levels);
  const pad = (max - min) * 0.06 || 1;
  min -= pad;
  max += pad;
  gridY(ctx, w, top, bottom, min, max, fmt);
  const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
  const step = (w - 50) / candles.length;
  const bw = Math.max(1, step * 0.65);
  const up = css('--up');
  const dn = css('--down');
  const vmax = Math.max(...candles.map((c) => c.v)) || 1;

  candles.forEach((c, i) => {
    const x = i * step + step / 2;
    const color = c.c >= c.o ? up : dn;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, y(c.h));
    ctx.lineTo(Math.round(x) + 0.5, y(c.l));
    ctx.stroke();
    const yo = y(c.o);
    const yc = y(c.c);
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    ctx.globalAlpha = 0.35;
    const vh = (c.v / vmax) * volH;
    ctx.fillRect(x - bw / 2, h - vh, bw, vh);
    ctx.globalAlpha = 1;
  });

  // Trade markers for trades inside the visible window.
  const t0 = candles[0].t;
  const span = candles[candles.length - 1].t - t0 || 1;
  const xAt = (t: number) => ((t - t0) / span) * (candles.length - 1) * step + step / 2;
  for (const t of trades) {
    if (t.closedAt < t0) continue;
    const col = t.pnl >= 0 ? up : dn;
    marker(ctx, xAt(Math.max(t.openedAt, t0)), y(t.entry), t.dir === 1 ? '▲' : '▼', css('--accent'));
    marker(ctx, xAt(t.closedAt), y(t.exit), '●', col);
  }

  const last = candles[candles.length - 1];
  label(ctx, w, y(last.c), fmt(last.c), last.c >= last.o ? up : dn);
  if (position) {
    hline(ctx, w, y(position.entry), css('--accent'), 'ENTRY');
    hline(ctx, w, y(position.stop), dn, 'STOP');
    hline(ctx, w, y(position.take), up, 'TP');
  }
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, ch: string, color: string) {
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(ch, x, y + 3);
  ctx.textAlign = 'left';
}

function hline(ctx: CanvasRenderingContext2D, w: number, y: number, color: string, text: string) {
  ctx.strokeStyle = color;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w - 48, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.fillText(text, w - 46, y + 3);
}

function label(ctx: CanvasRenderingContext2D, w: number, y: number, text: string, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(w - 50, y - 8, 50, 16);
  ctx.fillStyle = css('--bg');
  ctx.fillText(text, w - 47, y + 3);
}

export function kellyChart(canvas: HTMLCanvasElement, w: number, payoff: number, chosen: number) {
  const { ctx, w: W, h } = setup(canvas);
  const pts: number[] = [];
  const N = 80;
  for (let i = 0; i <= N; i++) pts.push(logGrowth((i / N) * 0.6, w, payoff));
  const finite = pts.filter(isFinite);
  const max = Math.max(...finite, 1e-6);
  const min = Math.min(...finite, -max);
  const top = 10;
  const bottom = h - 14;
  const y = (v: number) => bottom - ((Math.max(v, min) - min) / (max - min)) * (bottom - top);
  const x = (f: number) => (f / 0.6) * (W - 4) + 2;
  ctx.strokeStyle = css('--grid');
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(W, y(0));
  ctx.stroke();
  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(x((i / N) * 0.6), y(v)) : ctx.moveTo(x(0), y(v))));
  ctx.stroke();
  ctx.fillStyle = css('--up');
  ctx.beginPath();
  ctx.arc(x(chosen), y(logGrowth(chosen, w, payoff)), 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css('--muted');
  ctx.fillText('bet fraction →', W - 80, h - 2);
  ctx.fillText('growth', 4, 10);
}

export function barsChart(canvas: HTMLCanvasElement, values: number[], colors: string[]) {
  const { ctx, w, h } = setup(canvas);
  if (!values.length) return;
  const max = Math.max(...values.map(Math.abs)) || 1;
  const bw = w / values.length;
  values.forEach((v, i) => {
    ctx.fillStyle = css(colors[i] ?? '--accent');
    const bh = Math.max(2, (Math.abs(v) / max) * (h - 2));
    ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
  });
}
