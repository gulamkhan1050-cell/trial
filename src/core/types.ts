export interface Candle {
  t: number; // open time (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // quote volume (USDT)
}

export type Dir = 1 | -1; // 1 = long, -1 = short
export type AgentId = 'SCOUT' | 'SENTRY' | 'HAWK' | 'FORGE';

export type Regime = 'trend' | 'meanRevert' | 'breakout';

/** A strategy configuration. FORGE evolves these; HAWK trades the best survivor. */
export interface Genome {
  id: string;
  regime: Regime;
  fast: number; // fast EMA length
  slow: number; // slow EMA length
  rsiLen: number;
  rsiEdge: number; // distance from 50 that counts as stretched (mean revert)
  lookback: number; // breakout channel length
  volMult: number; // breakout volume confirmation
  stopAtr: number;
  takeAtr: number;
  trailAtr: number;
}

export interface Signal {
  dir: Dir | 0;
  strength: number; // 0..1
  reason: string;
}

export interface Position {
  id: string;
  symbol: string;
  dir: Dir;
  qty: number;
  entry: number;
  stop: number;
  take: number;
  trailAtr: number;
  atr: number;
  best: number; // best price since entry (for trailing)
  openedAt: number;
  genomeId: string;
}

export interface Trade {
  id: string;
  symbol: string;
  dir: Dir;
  qty: number;
  entry: number;
  exit: number;
  pnl: number; // net of fees
  fees: number;
  openedAt: number;
  closedAt: number;
  reason: string;
}

export interface LogEntry {
  t: number;
  agent: AgentId;
  kind: 'info' | 'pass' | 'veto' | 'entry' | 'exit' | 'evolve' | 'warn';
  text: string;
  pnl?: number;
}

export interface Fill {
  price: number;
  fee: number;
}

/** Execution venue. PaperBroker simulates fills; a live broker would implement the same contract. */
export interface Broker {
  readonly name: string;
  market(symbol: string, side: 'buy' | 'sell', qty: number, refPrice: number): Promise<Fill>;
}
