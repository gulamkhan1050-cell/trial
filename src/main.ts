import './styles.css';
import { Engine, WIDE_MARKETS } from './core/engine';
import { Dashboard } from './ui/dashboard';
import { LiveController, loadLiveSettings, shouldAutoStart } from './exchange/liveController';
import { profileGrid, withProfile } from './exchange/profile';

const engine = new Engine();
// The app runs one fixed strategy: the grid on live Binance prices, 15 coins, with the profile's settings.
const g = profileGrid(engine.settings.grid);
if (
  engine.settings.feed !== 'binance' ||
  engine.settings.strategy !== 'grid' ||
  engine.settings.symbols.length < WIDE_MARKETS.length ||
  JSON.stringify(engine.settings.grid) !== JSON.stringify(g)
)
  engine.updateSettings({ feed: 'binance', strategy: 'grid', interval: '1m', symbols: WIDE_MARKETS, grid: g });
// Handy for debugging from the browser console: swarm.log, swarm.grids, …
(window as unknown as { swarm: Engine }).swarm = engine;
const live = new LiveController(engine);
new Dashboard(document.getElementById('app')!, engine, live);
void engine.start();

// Trading was started and never killed: carry on by itself (orders and coins are picked back up).
const saved = loadLiveSettings();
if (shouldAutoStart() && saved.apiKey && saved.apiSecret) void live.start(withProfile(saved));

// On a phone the app only trades while it is on screen (Android/iOS pause hidden apps), so while
// live trading runs, keep the screen awake. Leave the phone on the charger with the app open.
let wake: WakeLockSentinel | null = null;
async function keepAwake() {
  if (wake || live.status !== 'running' || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => (wake = null));
  } catch {
    /* not allowed right now (battery saver) — try again shortly */
  }
}
setInterval(() => void keepAwake(), 10_000);

// Persist the book when the app is backgrounded; re-take the screen lock when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') engine.save();
  else void keepAwake();
});
