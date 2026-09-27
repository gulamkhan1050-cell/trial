/** Exchange-side contract for live trading (implemented by Binance futures and by the test mock). */

export interface SymbolRules {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';

export interface ExOrder {
  orderId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  origQty: number;
  executedQty: number;
  avgPrice: number;
  status: OrderStatus;
}

export interface ExPosition {
  qty: number; // signed: + long, − short
  entry: number;
  unrealized: number;
}

export interface ExchangeClient {
  readonly name: string;
  rules(symbols: string[]): Promise<Record<string, SymbolRules>>;
  /** Last traded price for every symbol on this venue. */
  prices(): Promise<Record<string, number>>;
  /** USDT wallet balance and what's free for new orders. */
  balance(): Promise<{ wallet: number; available: number }>;
  /** Isolated margin + leverage for a symbol (idempotent). */
  setup(symbol: string, leverage: number): Promise<void>;
  /** Post-only limit order (maker or nothing: rejected instead of crossing the book). */
  limitMaker(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, reduceOnly: boolean): Promise<ExOrder>;
  /** Best-effort exchange-side stop that closes the whole position if price falls to `stopPrice`. */
  stopClose(symbol: string, stopPrice: number): Promise<{ id: number; algo: boolean }>;
  cancelStop(symbol: string, stop: { id: number; algo: boolean }): Promise<void>;
  /** Close the whole position at market (reduce-only). */
  marketClose(symbol: string): Promise<void>;
  cancel(symbol: string, orderId: number): Promise<void>;
  cancelAll(symbol: string): Promise<void>;
  openOrders(): Promise<ExOrder[]>;
  order(symbol: string, orderId: number): Promise<ExOrder>;
  position(symbol: string): Promise<ExPosition>;
}

export function roundDown(x: number, step: number): number {
  const d = decimals(step);
  return +(Math.floor(x / step + 1e-9) * step).toFixed(d);
}

export function roundTo(x: number, step: number): number {
  const d = decimals(step);
  return +(Math.round(x / step) * step).toFixed(d);
}

function decimals(step: number): number {
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
