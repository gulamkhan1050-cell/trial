import { BOT_TAG, type ExchangeClient, type ExOrder, type ExPosition, type OrderStatus, type SymbolRules } from './types';
import { roundTo } from './types';

/**
 * Binance USDⓈ-M futures REST client. Requests are HMAC-SHA256 signed with Web Crypto,
 * so the secret never leaves this device except as a signature.
 *
 * In the browser dev server, requests go through the Vite proxy (/bx/...) to avoid CORS;
 * in the Android app, CapacitorHttp performs them natively against the real host.
 */

/** mainnet = real money; demo = Binance Demo Trading (binance.com demo mode); testnet = the older futures testnet. */
export type Network = 'testnet' | 'demo' | 'mainnet';

export const FUTURES_HOSTS: Record<Network, string> = {
  mainnet: 'https://fapi.binance.com',
  testnet: 'https://testnet.binancefuture.com',
  demo: 'https://demo-fapi.binance.com',
};
const PROXY: Record<Network, string> = { mainnet: '/bx/fapi', testnet: '/bx/ftest', demo: '/bx/fdemo' };

export function futuresBase(network: Network): string {
  const w = typeof window !== 'undefined' ? (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }) : null;
  return !w || w.Capacitor?.isNativePlatform?.() ? FUTURES_HOSTS[network] : PROXY[network];
}

export class BinanceError extends Error {
  constructor(
    readonly code: number,
    msg: string,
  ) {
    super(`Binance ${code}: ${msg}`);
  }
}

export class BinanceFutures implements ExchangeClient {
  readonly name: string;
  private base: string;
  private offset: number | null = null; // server time − local time
  private syncedAt = 0;
  private key: CryptoKey | null = null;
  private rulesCache: Record<string, SymbolRules> = {};
  private seq = 0;

  constructor(
    private apiKey: string,
    private apiSecret: string,
    readonly network: Network,
    base?: string,
  ) {
    this.base = base ?? futuresBase(network);
    this.name = `Binance futures ${network}`;
  }

  // ------------------------------------------------------------ transport

  private async public<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const qs = q.toString();
    const res = await fetch(`${this.base}${path}${qs ? `?${qs}` : ''}`);
    return this.parse<T>(res);
  }

  private async signed<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    // PCs and phones drift by seconds a day: re-sync with Binance's clock every 10 minutes, and at once on
    // -1021 ("timestamp ahead of/behind server time"), retrying that request.
    if (this.offset === null || Date.now() - this.syncedAt > 10 * 60_000) await this.syncTime();
    try {
      return await this.signedOnce<T>(method, path, params);
    } catch (e) {
      if (!(e instanceof BinanceError && e.code === -1021)) throw e;
      await this.syncTime();
      return this.signedOnce<T>(method, path, params);
    }
  }

  private async signedOnce<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number | boolean>): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    q.set('recvWindow', '5000');
    q.set('timestamp', String(Date.now() + (this.offset ?? 0)));
    q.set('signature', await this.sign(q.toString()));
    const res = await fetch(`${this.base}${path}?${q}`, { method, headers: { 'X-MBX-APIKEY': this.apiKey } });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BinanceError(res.status, text.slice(0, 200) || res.statusText);
    }
    const b = body as { code?: number; msg?: string };
    if (!res.ok || (typeof b.code === 'number' && b.code < 0)) throw new BinanceError(b.code ?? res.status, b.msg ?? res.statusText);
    return body as T;
  }

  private async sign(msg: string): Promise<string> {
    const enc = new TextEncoder();
    this.key ??= await crypto.subtle.importKey('raw', enc.encode(this.apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', this.key, enc.encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async syncTime() {
    const t0 = Date.now();
    const r = await this.public<{ serverTime: number }>('/fapi/v1/time');
    this.offset = r.serverTime - Math.round((t0 + Date.now()) / 2);
    this.syncedAt = Date.now();
  }

  // ------------------------------------------------------------ account

  async rules(symbols: string[]): Promise<Record<string, SymbolRules>> {
    if (symbols.every((s) => this.rulesCache[s])) return Object.fromEntries(symbols.map((s) => [s, this.rulesCache[s]]));
    type F = { filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string };
    const info = await this.public<{ symbols: { symbol: string; status: string; filters: F[] }[] }>('/fapi/v1/exchangeInfo');
    for (const s of info.symbols) {
      if (s.status !== 'TRADING') continue;
      const f = (t: string) => s.filters.find((x) => x.filterType === t);
      this.rulesCache[s.symbol] = {
        symbol: s.symbol,
        tickSize: +(f('PRICE_FILTER')?.tickSize ?? 0.01),
        stepSize: +(f('LOT_SIZE')?.stepSize ?? 0.001),
        minQty: +(f('LOT_SIZE')?.minQty ?? 0),
        minNotional: +(f('MIN_NOTIONAL')?.notional ?? 5),
      };
    }
    return Object.fromEntries(symbols.filter((s) => this.rulesCache[s]).map((s) => [s, this.rulesCache[s]]));
  }

  async prices(): Promise<Record<string, number>> {
    const rows = await this.public<{ symbol: string; price: string }[]>('/fapi/v1/ticker/price');
    return Object.fromEntries(rows.map((r) => [r.symbol, +r.price]));
  }

  async balance() {
    const rows = await this.signed<{ asset: string; balance: string; availableBalance: string }[]>('GET', '/fapi/v2/balance');
    const usdt = rows.find((r) => r.asset === 'USDT');
    return { wallet: +(usdt?.balance ?? 0), available: +(usdt?.availableBalance ?? 0) };
  }

  async ensureOneWay() {
    const r = await this.signed<{ dualSidePosition: boolean }>('GET', '/fapi/v1/positionSide/dual');
    if (!r.dualSidePosition) return;
    try {
      await this.signed('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: false });
    } catch (e) {
      throw new Error(
        `your Binance futures account is in Hedge Mode and can't be switched while it has open orders or positions (${(e as Error).message}). ` +
          'In Binance Futures: cancel open orders, close positions, then Preferences → Position Mode → One-way Mode.',
      );
    }
  }

  async setup(symbol: string, leverage: number) {
    try {
      await this.signed('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
    } catch (e) {
      // -4046 already isolated; -4047/-4048/-4067: can't change while this symbol has orders or a
      // position — keep the current margin type rather than fail.
      if (!(e instanceof BinanceError && [-4046, -4047, -4048, -4067].includes(e.code))) throw e;
    }
    await this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  // ------------------------------------------------------------ orders

  async limitMaker(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number, reduceOnly: boolean): Promise<ExOrder> {
    const r = await this.signed<RawOrder>('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      timeInForce: 'GTX', // post-only: rejected rather than filled as taker
      quantity: qty,
      price,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      newClientOrderId: `${BOT_TAG}${Date.now().toString(36)}${(this.seq++).toString(36)}`,
    });
    return toOrder(r);
  }

  async stopClose(symbol: string, stopPrice: number) {
    // Conditional orders live on the algo endpoint in newer API versions; try the classic one first.
    try {
      const r = await this.signed<RawOrder>('POST', '/fapi/v1/order', {
        symbol,
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice,
        closePosition: true,
        workingType: 'MARK_PRICE',
      });
      return { id: r.orderId, algo: false };
    } catch (first) {
      try {
        const r = await this.signed<{ algoId: number }>('POST', '/fapi/v1/algoOrder', {
          algoType: 'CONDITIONAL',
          symbol,
          side: 'SELL',
          type: 'STOP_MARKET',
          triggerPrice: stopPrice,
          closePosition: true,
          workingType: 'MARK_PRICE',
        });
        return { id: r.algoId, algo: true };
      } catch {
        throw first;
      }
    }
  }

  async cancelStop(symbol: string, stop: { id: number; algo: boolean }) {
    if (stop.algo) await this.signed('DELETE', '/fapi/v1/algoOrder', { symbol, algoId: stop.id });
    else await this.signed('DELETE', '/fapi/v1/order', { symbol, orderId: stop.id });
  }

  async marketClose(symbol: string) {
    const p = await this.position(symbol);
    if (p.qty === 0) return;
    const step = (await this.rules([symbol]))[symbol]?.stepSize ?? 0.001;
    await this.signed('POST', '/fapi/v1/order', {
      symbol,
      side: p.qty > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: roundTo(Math.abs(p.qty), step),
      reduceOnly: true,
    });
  }

  async cancel(symbol: string, orderId: number) {
    await this.signed('DELETE', '/fapi/v1/order', { symbol, orderId });
  }

  async cancelAll(symbol: string) {
    await this.signed('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  }

  async openOrders(): Promise<ExOrder[]> {
    return (await this.signed<RawOrder[]>('GET', '/fapi/v1/openOrders')).map(toOrder);
  }

  async order(symbol: string, orderId: number): Promise<ExOrder> {
    return toOrder(await this.signed<RawOrder>('GET', '/fapi/v1/order', { symbol, orderId }));
  }

  async position(symbol: string): Promise<ExPosition> {
    const rows = await this.signed<{ positionAmt: string; entryPrice: string; unRealizedProfit: string }[]>('GET', '/fapi/v2/positionRisk', { symbol });
    const r = rows[0];
    return { qty: +(r?.positionAmt ?? 0), entry: +(r?.entryPrice ?? 0), unrealized: +(r?.unRealizedProfit ?? 0) };
  }
}

interface RawOrder {
  orderId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  status: OrderStatus;
  clientOrderId?: string;
}

function toOrder(r: RawOrder): ExOrder {
  return {
    orderId: r.orderId,
    symbol: r.symbol,
    side: r.side,
    price: +r.price,
    origQty: +r.origQty,
    executedQty: +r.executedQty,
    avgPrice: +r.avgPrice,
    status: r.status,
    clientOrderId: r.clientOrderId,
  };
}
