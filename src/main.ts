import './styles.css';
import { Engine } from './core/engine';
import { Dashboard } from './ui/dashboard';

const engine = new Engine();
// Handy for debugging from the browser console: swarm.log, swarm.grids, …
(window as unknown as { swarm: Engine }).swarm = engine;
new Dashboard(document.getElementById('app')!, engine);
void engine.start();

// Persist the book when the app is backgrounded.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') engine.save();
});
