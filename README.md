# Swarm Desk

A multi-agent crypto trading desk that runs on your phone (Android APK). Four agents split the work,
modelled on the "agent trading floor" dashboards (JEV Desk, FOMO × Grok, Sets Machine):

| Agent | Job |
|-------|-----|
| **SCOUT** | Reads every closed 1-minute bar on each market and reports setups from that market's current champion strategy. |
| **SENTRY** | Has the last word before money moves. Three checks must pass (**confidence**, **liquidity**, **signals agree** on a higher timeframe), plus book-level vetoes: max open positions, a daily loss limit that halts all entries, and a cooldown after a loss (no revenge entries). |
| **HAWK** | The only agent that trades. Sizes each trade with half-Kelly from out-of-sample stats (capped by *max risk per trade* and *max leverage*), enters, trails the stop and exits on stop/target. |
| **FORGE** | Self-evolving strategy search (genetic algorithm): a population of 40 strategy configs per market (trend / mean-revert / breakout families) is backtested every generation; only configs that are profitable on data they were **not** trained on survive. The champion is re-tested each generation and retired if it stops passing. |

**GRID micro-trading** (Setup → *▦ Grid micro-trading*) swaps the directional agents for a ladder of resting limit
buys under one market; every filled buy gets a take-profit one step higher, so each small bounce books a small profit at
maker fees. FORGE evolves the step, number of levels and stop, and only grids profitable on unseen data are traded;
SENTRY won't lay a ladder into a sell-off and liquidates below the stop. It earns in ranges and loses in hard sell-offs.
Grid profit only exists if the step clears round-trip fees — set your exchange's maker/taker fees in Setup.

Screens: **Desk** (balance, PnL, pipeline, SENTRY checks, positions, log) · **Markets** (live candles with entry/stop/target) ·
**Grid** (order ladder, grid levels, genome) · **Forge** (generation, kill rate, fitness curve, selection funnel, Kelly curve, genome) · **Log** · **Setup**.

## Arena

The **Arena** tab replays the last 1, 3 or 7 days of real Binance 1m prices (or the offline simulator) through
**NORMAL** (directional agents) and **MICRO** (a grid on every market) side by side, each with its own paper account,
as fast as the device can compute, and shows final balance, trades, win rate, drawdown and best/worst day.
Offline-simulator results are not achievable in real markets; judge strategies on real history.

### Market maker · 1-second

Also in the Arena: a two-sided market maker that rests a bid and an ask around the price on each coin every second,
earns the spread and skews quotes to shed inventory. It downloads real Binance **1-second** bars (1, 6 or 24 hours),
tunes the spread per coin on the first quarter, tests on the rest, and compares four maker-fee levels (a rebate, 0%,
0.01% and your own). A quote fills only when price trades through it, and only with the chosen probability, to stand in
for queue position.

## The trading profile (fixed)

The app runs one strategy, set in `src/exchange/profile.ts`, not in the UI:

- **fixed long grid** on all 15 liquid coins at **5×**: 8 buys 1.2% apart under the price, each sold one step (1.2%) up,
  a stop one step under the lowest buy. FORGE no longer searches for grids; it only rates the coins.
- crash guard on, reinvest on
- **take profit & restart**: each time a round makes 8% of capital ($40 per $500) everything is sold and a new round starts
- **loss limit 10%** of capital → the bot closes everything and stops

Replayed through the engine on 16 real weeks Jun 16 – Oct 6 ($500 each week, `reports/engine-16wk-2026-10-07-500usd.txt`):
**+$17 a week**, worst week −$16, 12 of 16 weeks green, 14% worst drop. The FORGE-tuned 3× grid it replaces made
−$11 a week (worst −$93, 6 of 16 green, 21% drop). Grids that buy and short (both directions) lost money on average
over the same 16 weeks at every leverage tried.

The step was then cut from 2% to 1.2% so it trades more (`reports/steps-16wk-2026-10-07-300usd.txt`, $300 a week):
about 45 trades a day instead of 15 at the same average (+$11 vs +$10 a week), with a worse worst week (−$34 vs −$10).

Setup only asks for the account (Demo or real money), the API key and secret, and the money to trade. Once
started, the app resumes trading by itself when reopened, until KILL is pressed or the loss limit fires.
The Race, Arena and settings switches used to find this profile are gone from the app; their code
(`src/core/race.ts`, `src/core/arena.ts`) and tests remain.

## Live trading (Binance USDⓈ-M futures)

**Setup → Binance futures account** runs the grid as real orders:

- Only with the ★ Live grid preset (grid strategy on the live Binance feed).
- Trades up to *Max coins* of the coins FORGE currently rates best **and** whose Binance minimum order fits the
  per-coin budget (`max capital × leverage ÷ max coins`); BTC's $100 minimum, for example, needs a bigger budget.
- Every grid order is post-only (maker fee); each filled buy gets a take-profit one step up. Isolated margin per coin.
- Safety: a capital cap regardless of wallet size, an app-side stop below each ladder plus a best-effort stop order held
  by Binance, the crash guard, a loss limit that trips the kill switch, and a **KILL** button (cancel all orders, close
  all positions at market) in the header and on the Grid tab.
- API keys are stored only in the browser on that device. Create a key with **only "Enable Futures"** (never
  withdrawals) and restrict it to your IP. Start on **Testnet** (keys from testnet.binancefuture.com) before Mainnet.
- In the browser (`npm run dev` / `npm run preview`) requests go through the Vite proxy at `/bx/...`; the Android app
  calls Binance directly.

- **Restarts keep the trades.** The running grid is saved after every sync; the next Start (same network and key)
  picks up its orders, bought coins and stats instead of selling at market. If the Binance-held stop fired while the
  app was off, that coin is re-armed fresh. Only **KILL** closes everything.

Code: `src/exchange/` — `binance.ts` (signed REST client), `liveGrid.ts` (order lifecycle), `liveController.ts`
(engine ↔ live wiring), `mock.ts` (in-memory exchange used by the tests).

### Headless bot — 24/7 on an Android phone (Termux)

Android pauses apps in the background, so for a week-long run use the headless bot: the same engine and live grid,
no screen, run by Node inside [Termux](https://f-droid.org/packages/com.termux/) (install it from F-Droid; the Play
Store version is outdated).

```sh
pkg update && pkg install -y nodejs-lts git termux-api
git clone https://github.com/gulamkhan1050-cell/trial.git && cd trial
npm install
npm run bot            # first run asks for network (demo/mainnet), key, secret, capital…
```

- Settings are saved to `bot.config.json` (owner-only), state to `bot-state.json`; both stay on the phone.
- The console prints each LIVE buy/sell and a status line every minute.
- `Ctrl+C` stops the bot but **leaves orders and positions on Binance**; `npm run bot` again resumes them.
- `npm run bot:kill` cancels every bot order and closes every bot position.
- `run-bot.sh` holds a Termux wake lock and restarts the bot after a crash or network drop (not after Ctrl+C,
  the kill switch or the loss limit).
- Android settings → Apps → Termux → Battery → **Unrestricted**, keep the phone on the charger, and don't swipe
  Termux away from recent apps.
- A Binance key restricted to one IP won't work on mobile data (the IP changes); on mainnet use home Wi-Fi with a
  fixed IP, or run the same commands on a small cloud server.

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
