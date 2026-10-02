import './styles.css';
import { Engine, WIDE_MARKETS } from './core/engine';
import { Dashboard } from './ui/dashboard';
import { LiveController } from './exchange/liveController';

const engine = new Engine();
// The app is the live grid: real-time Binance prices, grid strategy, 15 coins.
if (engine.settings.feed !== 'binance' || engine.settings.strategy !== 'grid' || engine.settings.symbols.length < WIDE_MARKETS.length)
  engine.updateSettings({ feed: 'binance', strategy: 'grid', interval: '1m', symbols: WIDE_MARKETS });
// Handy for debugging from the browser console: swarm.log, swarm.grids, …
(window as unknown as { swarm: Engine }).swarm = engine;
const live = new LiveController(engine);
new Dashboard(document.getElementById('app')!, engine, live);
void engine.start();

// Persist the book when the app is backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') engine.save();
});
