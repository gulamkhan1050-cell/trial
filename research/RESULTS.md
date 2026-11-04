# Gold strategy research — walk-forward results

Data: Binance PAXG/USDT 1-minute bars (1 PAXG = 1 oz of gold, trades within cents of XAUUSD), 2024-01 to 2026-11,
1.49 million bars; cent-priced from June 2025. Cross-check: XAUT/USDT (a second gold token) from April 2026.
Costs: $0.30 spread, $0.05 slippage on entries and stops, broker swap on overnight holds, stop assumed hit first
when stop and target fall in the same minute. Code: `engine.py`, `strategies.py`, `search.py`, `robust.py`.

## The backtester reproduces MT5

The failed pullback strategy, same dates (2025-06-01 → 2026-10-01):

| | MT5 Strategy Tester (real ticks) | This backtester |
|---|---|---|
| Profit factor | 0.93 | 0.945 |
| Return at 1% risk | −36% | −33% |
| Max drawdown | 54% | 46% |

## Search: 1,332 settings over 8 strategy families

Settings chosen on **train** (2025-06 → 2026-01) only, then scored once on **test** (2026-02 → 2026-10).

| Family | Train PF | Test PF | Test trades | Verdict |
|---|---|---|---|---|
| Asian-range breakout (EA v2 default) | 1.37 | 0.77 | 99 | no edge |
| Previous-day high/low breakout | 1.79 | 0.78 | 149 | no edge |
| H1 Donchian trend | 2.93 | 0.79 | 82 | no edge |
| M15 Donchian trend | 1.17 | 0.97 | 256 | no edge |
| Volatility squeeze | 1.52 | 0.82 | 106 | no edge |
| Trend pullback (EA v1) | 1.40 | 1.01 | 181 | no edge |
| NY opening-range breakout | 1.89 | 1.20 | 74 | train did not predict test (rank corr 0.1) |
| **Asian-session fade** | **1.46** | **1.37** | **100** | **passed** (rank corr 0.70) |

## Asian-session fade

Between 02:00 and 10:00 server time, when a closed M15 bar is more than 3 standard deviations from the mean of
the last 20 closes, trade back toward the mean. Stop 1.5 × ATR(14, M15), target 1R, close after 4 hours.

| Check | PF | Win | Trades | Return (1% risk) | Max DD |
|---|---|---|---|---|---|
| Train 2025-06 → 2026-01 | 1.46 | 60.5% | 38 | +6.9% | 4.0% |
| Test 2026-02 → 2026-10 | 1.37 | 58.0% | 100 | +16.3% | 3.1% |
| 2024-01 → 2025-05 (unused, $1-tick data) | 1.20 | 55.3% | 76 | +6.3% | 10.7% |
| XAUT token 2026-04 → 2026-10 | 1.38 | 57.6% | 66 | +10.6% | 4.0% |
| Spread $0.50 instead of $0.30 | 1.31 | 57.2% | 138 | +19.4% | 5.0% |
| Spread $0.70 | 1.16 | 53.6% | 138 | +10.2% | 7.9% |

Seven neighbouring settings (k 2.75/3.25, stop 2.0/2.5 ATR, target 0.5/1.25R, hours 1–10 / 2–8) all have
PF 1.15–1.67. 12 of 18 months green. About 8 trades a month, median hold 18 minutes.

**In money, 2025-06 → 2026-10:** $25,000 at 1% risk per trade → $30,776 (+$5,776, about +1.2% a month,
worst drawdown 4.1%). At 2% risk → $37,368 (about +2.4% a month, worst drawdown 8.2%).

**$100 at 0.01 lot does not fit:** the median stop is $9.50 per ounce, so one trade at 0.01 lot risks about 9.5%
of $100 (worst single loss $63). Use a cent account or a larger balance.
