import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinanceError, BinanceFutures } from '../src/exchange/binance';
import { roundDown, roundTo } from '../src/exchange/types';

describe('Binance futures client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs exactly like Binance's documented HMAC-SHA256 example", async () => {
    // From Binance's API docs (SIGNED endpoint examples).
    const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
    const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
    const client = new BinanceFutures('key', secret, 'testnet', 'https://example.invalid');
    const sig = await (client as unknown as { sign(m: string): Promise<string> }).sign(query);
    expect(sig).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
  });

  it('sends a signed post-only order with the API key header and a server-synced timestamp', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/fapi/v1/time')) return new Response(JSON.stringify({ serverTime: Date.now() + 1500 }));
      return new Response(
        JSON.stringify({ orderId: 7, symbol: 'DOGEUSDT', side: 'BUY', price: '0.099', origQty: '121', executedQty: '0', avgPrice: '0', status: 'NEW' }),
      );
    });
    const client = new BinanceFutures('my-key', 'my-secret', 'mainnet', 'https://fapi.test');
    const o = await client.limitMaker('DOGEUSDT', 'BUY', 121, 0.099, false);
    expect(o).toMatchObject({ orderId: 7, status: 'NEW', price: 0.099, origQty: 121 });
    const order = calls.find((c) => c.url.includes('/fapi/v1/order'))!;
    expect(order.init?.method).toBe('POST');
    expect((order.init?.headers as Record<string, string>)['X-MBX-APIKEY']).toBe('my-key');
    const q = new URL(order.url).searchParams;
    expect(q.get('timeInForce')).toBe('GTX');
    expect(q.get('type')).toBe('LIMIT');
    expect(q.get('reduceOnly')).toBeNull();
    expect(q.get('signature')).toMatch(/^[0-9a-f]{64}$/);
    // Timestamp follows the server clock (1.5 s ahead here), not the local one.
    expect(Number(q.get('timestamp'))).toBeGreaterThan(Date.now() + 1000);
    // The secret itself is never sent.
    expect(order.url).not.toContain('my-secret');
  });

  it('turns Binance error bodies into BinanceError with the code', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/time')
        ? new Response(JSON.stringify({ serverTime: Date.now() }))
        : new Response(JSON.stringify({ code: -2019, msg: 'Margin is insufficient.' }), { status: 400 }),
    );
    const client = new BinanceFutures('k', 's', 'testnet', 'https://fapi.test');
    await expect(client.balance()).rejects.toMatchObject({ code: -2019 });
    await expect(client.balance()).rejects.toBeInstanceOf(BinanceError);
  });

  it('treats "already isolated" as success when setting up a symbol', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      paths.push(new URL(url).pathname);
      if (url.includes('/time')) return new Response(JSON.stringify({ serverTime: Date.now() }));
      if (url.includes('marginType')) return new Response(JSON.stringify({ code: -4046, msg: 'No need to change margin type.' }), { status: 400 });
      return new Response(JSON.stringify({ leverage: 3, symbol: 'DOGEUSDT' }));
    });
    await new BinanceFutures('k', 's', 'testnet', 'https://fapi.test').setup('DOGEUSDT', 3);
    expect(paths).toContain('/fapi/v1/leverage');
  });

  it('rounds prices and quantities to the exchange steps', () => {
    expect(roundTo(0.0990004, 0.00001)).toBe(0.099);
    expect(roundDown(121.97, 1)).toBe(121);
    expect(roundDown(0.12345, 0.001)).toBe(0.123);
    expect(roundTo(60123.46, 0.1)).toBe(60123.5);
  });
});
