# XauPullback — XAUUSD EA for MetaTrader 5

One strategy, testable end to end, with risk limits the strategy cannot override. Uses only MT5's built-in EMA and ATR.

## What it does

| Part | Rule |
|------|------|
| Trend | H1 EMA50 above EMA200 and rising → longs only; below and falling → shorts only; otherwise no trades |
| Entry | On the chart timeframe (M5 or M15): last closed bar dips into EMA20 and closes back on the trend side |
| Stop | 1.5 × ATR(14) |
| Target | 2R (set `InpTpR = 0` for trailing only) |
| Breakeven | at +1R the stop moves to entry + 0.1R |
| Trailing | after breakeven, 2 × ATR behind price |
| Size | 1% of equity at risk. If the broker's minimum lot would risk more than 3%, the trade is **skipped** |
| Day stops | −3% for the day → close all, no more entries; 3 losses in a row → no more entries |
| Ceiling | at most 6 entries a day. This is a limit, not a target: on a quiet day the bot may trade zero times |
| Filters | spread > $0.40, outside 10:00–22:00 server time, Friday after 20:00, ±30 min around high-impact USD news |

The panel in the top-left corner shows trend, signal, ATR, spread, session, news, the open position (entry, SL, TP, current R),
today's P/L, entry count, loss streak and the reason for the last skipped trade. Buy and sell arrows mark each setup on the chart.

## Install

1. MT5 → File → Open Data Folder → `MQL5/Experts/` → copy `XauPullback.mq5` there.
2. Open it in MetaEditor (F4), press F7 to compile. **It was written without access to a compiler**; send any errors back to Claude to fix.
3. Attach it to an **XAUUSD M5** chart, tick "Allow Algo Trading". For the news filter, the economic calendar must be enabled (it is by default).
4. Session hours are in **server time**. Most brokers run GMT+2 in winter and GMT+3 in summer, so 10:00–22:00 server is about London open to
   mid New York. Check your broker's clock (Market Watch shows server time) and adjust.

## About $100 and 0.01 lot

On a standard account, 0.01 lot of gold is 1 ounce: each $1 move is $1. A 1.5×ATR stop on M5 is often $5–10, so one trade risks 5–10%
of $100. With the default 3% cap, **the EA will skip most trades on a $100 standard account**. That is intentional. Use a cent account
(10,000 cents), where 1% risk can be sized correctly, or raise `InpMaxRiskPct` knowing what it costs you.

## Before real money

1. **Backtest:** Strategy Tester → "Every tick based on real ticks", XAUUSD M5, at least 2 years, your broker's spread and commission.
   The news filter is off in the tester (MT5 has no calendar history there), so the backtest is somewhat optimistic.
2. **Walk-forward:** optimise on one period only (e.g. 2024), then run the chosen settings unchanged on the next (2025–2026).
   If the second period loses money, the strategy has no edge — do not go live.
3. **Demo for 4–8 weeks**, then a cent account.

Send the tester report (right-click → Report → HTML) back for review.
