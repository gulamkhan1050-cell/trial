# Swarm Desk

A multi-agent crypto trading desk that runs on your phone (Android APK). Four agents split the work,
modelled on the "agent trading floor" dashboards (JEV Desk, FOMO × Grok, Sets Machine):

| Agent | Job |
|-------|-----|
| **SCOUT** | Reads every closed 1-minute bar on each market and reports setups from that market's current champion strategy. |
| **SENTRY** | Has the last word before money moves. Three checks must pass (**confidence**, **liquidity**, **signals agree** on a higher timeframe), plus book-level vetoes: max open positions, a daily loss limit that halts all entries, and a cooldown after a loss (no revenge entries). |
| **HAWK** | The only agent that trades. Sizes each trade with half-Kelly from out-of-sample stats (capped by *max risk per trade* and *max leverage*), enters, trails the stop and exits on stop/target. |
| **FORGE** | Self-evolving strategy search (genetic algorithm): a population of 40 strategy configs per market (trend / mean-revert / breakout families) is backtested every generation; only configs that are profitable on data they were **not** trained on survive. The champion is re-tested each generation and retired if it stops passing. |

Screens: **Desk** (balance, PnL, pipeline, SENTRY checks, positions, log) · **Markets** (live candles with entry/stop/target) ·
**Forge** (generation, kill rate, fitness curve, selection funnel, Kelly curve, genome) · **Log** · **Setup**.

## Modes

- **Binance live prices (default)** — real-time 1m candles from Binance's public market-data endpoints
  (`data-api.binance.vision`, no API key). Orders are **paper** fills with fees and slippage. The book is saved on the device.
- **Simulator** — offline, sped-up synthetic market (1 bar every 1.5s by default) to watch the agents work.
  It is used automatically if Binance cannot be reached. Simulator profits mean nothing about real markets.

There is no live-order execution. `Broker` in `src/core/types.ts` is the seam where an exchange
adapter would plug in; it is intentionally not implemented.

## Get the APK

Every push runs `.github/workflows/android-apk.yml`, which tests, builds and uploads `swarm-desk-debug.apk`
as a workflow artifact (Actions tab → latest run → *swarm-desk-apk*). Pushing a `v*` tag also attaches it to a release.
Install it on Android by allowing "install unknown apps" for your browser/file manager.

## Develop

```bash
npm install
npm run dev        # open in a browser (phone-sized window recommended)
npm test           # unit + engine tests
npm run apk        # needs Android SDK + JDK 21 locally: builds android/app/build/outputs/apk/debug/app-debug.apk
```

Layout: `src/core` (indicators, strategies, backtester, evolver, Kelly, market feeds, paper broker, engine),
`src/agents` (scout, sentry, hawk), `src/ui` (dashboard + canvas charts), `android/` (Capacitor project).

## Honest caveats

The dashboards in those videos show replays and cherry-picked sessions; nothing here predicts returns.
Backtests on 1-minute data overfit easily — that is why FORGE judges strategies only on out-of-sample data and
SENTRY can bench a market entirely. Run it on paper for a long time before trusting any of it with money.
