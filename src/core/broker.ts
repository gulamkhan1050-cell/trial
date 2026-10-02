import type { Broker, Fill } from './types';

/** Simulated venue: market orders fill at the reference price plus slippage, minus taker fee. */
export class PaperBroker implements Broker {
  readonly name = 'Paper';
  constructor(
    private feeRate = 0.0004,
    private slippage = 0.0002,
  ) {}

  async market(_symbol: string, side: 'buy' | 'sell', qty: number, refPrice: number): Promise<Fill> {
    const price = refPrice * (side === 'buy' ? 1 + this.slippage : 1 - this.slippage);
    return { price, fee: price * qty * this.feeRate };
  }
}
