import { BinanceError } from './binance';
import { BOT_TAG, type ExchangeClient, type ExOrder, type ExPosition, type SymbolRules } from './types';

interface MockOrder extends ExOrder {
  reduceOnly: boolean;
}

/**
 * In-memory futures exchange used by tests (and handy for dry runs): resting limit orders
 * fill at their price when the market trades through them, post-only orders that would
 * cross are expired, reduce-only orders can't open positions, fees come off the wallet.
 */
export class MockExchange implements ExchangeClient {
  readonly name = 'mock';
  wallet: number;
  orders = new Map<number, MockOrder>();
  stops = new Map<number, { symbol: string; stopPrice: number }>();
  positions: Record<string, { qty: number; entry: number }> = {};
  px: Record<string, number> = {};
  leverage: Record<string, number> = {};
  calls: string[] = [];
  hedgeMode = false;
  /** Real Binance answers a crossing post-only order with error -5022 instead of an EXPIRED order. */
  postOnlyThrows = false;
  private next = 1;

  constructor(
    private rulesMap: Record<string, SymbolRules>,
    wallet = 100,
    private maker = 0.0002,
    private taker = 0.0005,
  ) {
    this.wallet = wallet;
  }

  setPrice(symbol: string, price: number) {
    this.px[symbol] = price;
    for (const o of [...this.orders.values()].filter((x) => x.symbol === symbol && x.status === 'NEW').sort((a, b) => (a.side === 'BUY' ? b.price - a.price : a.price - b.price))) {
      const hit = o.side === 'BUY' ? price <= o.price : price >= o.price;
      if (!hit) continue;
      if (o.reduceOnly && !this.canReduce(o)) {
        o.status = 'EXPIRED';
        continue;
      }
      this.fill(o.symbol, o.side, o.origQty, o.price, this.maker);
      o.executedQty = o.origQty;
      o.avgPrice = o.price;
      o.status = 'FILLED';
    }
    for (const [id, s] of this.stops) {
      if (s.symbol === symbol && price <= s.stopPrice && (this.positions[symbol]?.qty ?? 0) > 0) {
        this.fill(symbol, 'SELL', this.positions[symbol].qty, price, this.taker);
        this.stops.delete(id);
      }
    }
  }

  private canReduce(o: MockOrder): boolean {
    const q = this.positions[o.symbol]?.qty ?? 0;
    return o.side === 'SELL' ? q >= o.origQty - 1e-12 : -q >= o.origQty - 1e-12;
  }

  private fill(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, fee: number) {
    const p = (this.positions[symbol] ??= { qty: 0, entry: 0 });
    const signed = side === 'BUY' ? qty : -qty;
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signed)) {
      p.entry = (p.entry * Math.abs(p.qty) + price * qty) / (Math.abs(p.qty) + qty);
      p.qty += signed;
    } else {
      const closing = Math.min(Math.abs(p.qty), qty);
      this.wallet += closing * (price - p.entry) * Math.sign(p.qty);
      p.qty += signed;
      if (Math.abs(p.qty) < 1e-12) p.qty = 0;
    }
    this.wallet -= qty * price * fee;
  }

  async rules(symbols: string[]) {
    return Object.fromEntries(symbols.filter((s) => this.rulesMap[s]).map((s) => [s, this.rulesMap[s]]));
  }

  async prices() {
    return { ...this.px };
  }

  async balance() {
    let locked = 0;
    for (const [s, p] of Object.entries(this.positions)) locked += (Math.abs(p.qty) * (this.px[s] ?? p.entry)) / (this.leverage[s] ?? 1);
    return { wallet: this.wallet, available: this.wallet - locked };
  }

  async ensureOneWay() {
    if (this.hedgeMode && [...this.orders.values()].some((o) => o.status === 'NEW'))
      throw new BinanceError(-4067, 'Position side cannot be changed if there exists open orders.');
    this.hedgeMode = false;
  }

  /** Place an order as if a person (not the bot) did it in the Binance app. */
  manualOrder(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number) {
    const o: MockOrder = { orderId: this.next++, symbol, side, price, origQty: qty, executedQty: 0, avgPrice: 0, status: 'NEW', reduceOnly: false, clientOrderId: 'web_manual' };
    this.orders.set(o.orderId, o);
    return o;
  }

  async setup(symbol: string, leverage: number) {
    this.calls.push(`setup ${symbol} ${leverage}x`);
    this.leverage[symbol] = leverage;
  }

  async limitMaker(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, reduceOnly: boolean): Promise<ExOrder> {
    this.calls.push(`${side} ${symbol} ${qty}@${price}${reduceOnly ? ' RO' : ''}`);
    const r = this.rulesMap[symbol];
    if (qty * price < r.minNotional - 1e-9) throw new BinanceError(-4164, 'Order notional must be no smaller than minimum');
    const o: MockOrder = { orderId: this.next++, symbol, side, price, origQty: qty, executedQty: 0, avgPrice: 0, status: 'NEW', reduceOnly, clientOrderId: `${BOT_TAG}${this.next}` };
    const px = this.px[symbol];
    if (px !== undefined && (side === 'BUY' ? price >= px : price <= px)) o.status = 'EXPIRED'; // post-only would cross
    if (o.status === 'EXPIRED' && this.postOnlyThrows)
      throw new BinanceError(-5022, 'Due to the order could not be executed as maker, the Post Only order will be rejected.');
    if (reduceOnly && o.status === 'NEW' && !this.canReduce(o)) throw new BinanceError(-2022, 'ReduceOnly Order is rejected.');
    this.orders.set(o.orderId, o);
    return { ...o };
  }

  async stopClose(symbol: string, stopPrice: number) {
    const id = this.next++;
    this.stops.set(id, { symbol, stopPrice });
    return { id, algo: false };
  }

  async cancelStop(_symbol: string, stop: { id: number }) {
    this.stops.delete(stop.id);
  }

  async marketClose(symbol: string) {
    const p = this.positions[symbol];
    if (!p || p.qty === 0) return;
    this.calls.push(`CLOSE ${symbol}`);
    this.fill(symbol, p.qty > 0 ? 'SELL' : 'BUY', Math.abs(p.qty), this.px[symbol], this.taker);
  }

  async cancel(_symbol: string, orderId: number) {
    const o = this.orders.get(orderId);
    if (o && o.status === 'NEW') o.status = 'CANCELED';
  }

  async cancelAll(symbol: string) {
    if (!this.orders.size && !this.stops.size) return;
    this.calls.push(`CANCEL-ALL ${symbol}`);
    for (const o of this.orders.values()) if (o.symbol === symbol && o.status === 'NEW') o.status = 'CANCELED';
    for (const [id, s] of this.stops) if (s.symbol === symbol) this.stops.delete(id);
  }

  async openOrders(symbol?: string) {
    this.calls.push(`OPEN-ORDERS ${symbol ?? 'ALL'}`);
    return [...this.orders.values()].filter((o) => o.status === 'NEW' && (!symbol || o.symbol === symbol)).map((o) => ({ ...o }));
  }

  async order(_symbol: string, orderId: number) {
    const o = this.orders.get(orderId);
    if (!o) throw new BinanceError(-2013, 'Order does not exist.');
    return { ...o };
  }

  async position(symbol: string): Promise<ExPosition> {
    const p = this.positions[symbol] ?? { qty: 0, entry: 0 };
    return { qty: p.qty, entry: p.entry, unrealized: p.qty * ((this.px[symbol] ?? p.entry) - p.entry) };
  }
}
