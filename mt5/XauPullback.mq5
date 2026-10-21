//+------------------------------------------------------------------+
//| XauPullback.mq5                                                  |
//| XAUUSD trend-pullback EA for MetaTrader 5.                       |
//|                                                                  |
//| Trend:  higher timeframe EMA fast vs slow, fast EMA sloping.     |
//| Entry:  closed bar on the chart timeframe dips into the pullback |
//|         EMA and closes back on the trend side.                   |
//| Stop:   ATR-based; breakeven at +1R, then ATR trailing stop.     |
//| Guards: risk % per trade, daily loss stop, loss-streak stop,     |
//|         max entries per day (a ceiling, not a target), spread,   |
//|         session hours, high-impact USD news, Friday close.       |
//| Panel:  live on-chart status of all of the above.                |
//+------------------------------------------------------------------+
#property copyright "trial"
#property version   "1.00"
#property description "XAUUSD trend pullback with ATR stops, trailing and hard risk limits"

#include <Trade\Trade.mqh>

input group "Risk"
input double InpRiskPct       = 1.0;    // Risk per trade, % of equity
input double InpMaxRiskPct    = 3.0;    // Skip trade if the minimum lot would risk more than this %
input double InpDailyLossPct  = 3.0;    // Close all and stop for the day at this loss %
input int    InpMaxTradesDay  = 6;      // Max entries per day (ceiling, not a target)
input int    InpMaxLossStreak = 3;      // Stop for the day after this many losses in a row

input group "Strategy"
input ENUM_TIMEFRAMES InpTrendTF = PERIOD_H1; // Trend timeframe
input int    InpTrendFast     = 50;     // Trend fast EMA
input int    InpTrendSlow     = 200;    // Trend slow EMA
input int    InpPullbackEMA   = 20;     // Pullback EMA on the chart timeframe
input int    InpAtrPeriod     = 14;     // ATR period (chart timeframe)
input double InpSlAtr         = 1.5;    // Stop distance in ATRs
input double InpTpR           = 2.0;    // Take profit in R (0 = no TP, trailing only)
input double InpBeAtR         = 1.0;    // Move stop to breakeven at this many R
input double InpTrailAtr      = 2.0;    // Trailing distance in ATRs (after breakeven)

input group "Filters"
input double InpMaxSpread     = 0.40;   // Max spread in price ($ per ounce)
input int    InpSessionStart  = 10;     // Session start hour (server time)
input int    InpSessionEnd    = 22;     // Session end hour (server time)
input int    InpFridayCutoff  = 20;     // No new entries on Friday from this hour
input bool   InpCloseFriday   = true;   // Close positions before the weekend
input int    InpFridayClose   = 23;     // Friday close hour (server time)
input bool   InpNewsFilter    = true;   // Block entries around high-impact USD news (live only)
input int    InpNewsBeforeMin = 30;     // Minutes before news
input int    InpNewsAfterMin  = 30;     // Minutes after news

input group "Misc"
input ulong  InpMagic         = 26102001; // Magic number
input bool   InpShowPanel     = true;     // Show the live panel

CTrade   trade;
int      hFast = INVALID_HANDLE, hSlow = INVALID_HANDLE, hPull = INVALID_HANDLE, hAtr = INVALID_HANDLE;
datetime gLastBar = 0;
string   gSignal  = "waiting for first closed bar";
string   gSkip    = "-";
string   gHalt    = "";

struct DayStats
  {
   double            realized;
   int               entries;
   int               lossStreak;
  };

DayStats gDay;
bool     gDayDirty = true;   // set when a deal is added; history is re-read only then
int      gDayKey   = -1;
datetime gLastPanel = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   hFast = iMA(_Symbol, InpTrendTF, InpTrendFast, 0, MODE_EMA, PRICE_CLOSE);
   hSlow = iMA(_Symbol, InpTrendTF, InpTrendSlow, 0, MODE_EMA, PRICE_CLOSE);
   hPull = iMA(_Symbol, _Period, InpPullbackEMA, 0, MODE_EMA, PRICE_CLOSE);
   hAtr  = iATR(_Symbol, _Period, InpAtrPeriod);
   if(hFast == INVALID_HANDLE || hSlow == INVALID_HANDLE || hPull == INVALID_HANDLE || hAtr == INVALID_HANDLE)
     {
      Print("XauPullback: failed to create indicator handles");
      return INIT_FAILED;
     }
   if(StringFind(_Symbol, "XAU") < 0 && StringFind(_Symbol, "GOLD") < 0)
      Print("XauPullback: built and tuned for XAUUSD, attached to ", _Symbol);
   if(PeriodSeconds(_Period) >= PeriodSeconds(InpTrendTF))
      Print("XauPullback: chart timeframe should be lower than the trend timeframe (use M5 or M15)");

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetDeviationInPoints(30);

   if(!MQLInfoInteger(MQL_TESTER))
      ChartIndicatorAdd(0, 0, hPull);
   gLastBar = iTime(_Symbol, _Period, 0);
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   // Keep the panel and arrows on the tester chart so the finished run can be inspected.
   if(!MQLInfoInteger(MQL_TESTER))
      ObjectsDeleteAll(0, "XP_");
   IndicatorRelease(hFast);
   IndicatorRelease(hSlow);
   IndicatorRelease(hPull);
   IndicatorRelease(hAtr);
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   double atr = Buf(hAtr, 1);

   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   if(gDayDirty || t.day_of_year != gDayKey)
     {
      GetDay(gDay);
      gDayDirty = false;
      gDayKey = t.day_of_year;
     }
   DayStats d = gDay;
   double floating = Floating();
   double startBal = AccountInfoDouble(ACCOUNT_BALANCE) - d.realized;
   double dayPnl   = d.realized + floating;
   double dayPct   = startBal > 0 ? dayPnl / startBal * 100.0 : 0.0;

   gHalt = "";
   if(dayPct <= -InpDailyLossPct)
      gHalt = "daily loss limit";
   else
      if(d.lossStreak >= InpMaxLossStreak)
         gHalt = StringFormat("%d losses in a row", d.lossStreak);
   if(gHalt == "daily loss limit" && HasPosition())
      CloseAll("daily loss limit");

   if(InpCloseFriday && t.day_of_week == 5 && t.hour >= InpFridayClose && HasPosition())
      CloseAll("weekend close");

   if(atr != EMPTY_VALUE)
      ManagePositions(atr);

   datetime bar = iTime(_Symbol, _Period, 0);
   if(bar != gLastBar)
     {
      gLastBar = bar;
      EvaluateEntry(atr, d);
     }

   // The panel is skipped in non-visual tests and redrawn at most once a second.
   bool canShow = !MQLInfoInteger(MQL_TESTER) || MQLInfoInteger(MQL_VISUAL_MODE);
   if(InpShowPanel && canShow && TimeCurrent() != gLastPanel)
     {
      gLastPanel = TimeCurrent();
      UpdatePanel(atr, d, dayPnl, dayPct);
     }
  }

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
      gDayDirty = true;
  }

//+------------------------------------------------------------------+
double Buf(int handle, int shift)
  {
   double v[];
   if(CopyBuffer(handle, 0, shift, 1, v) != 1)
      return EMPTY_VALUE;
   return v[0];
  }

//+------------------------------------------------------------------+
//| +1 up, -1 down, 0 no trend                                       |
//+------------------------------------------------------------------+
int TrendDir()
  {
   double f1 = Buf(hFast, 1), f4 = Buf(hFast, 4), s1 = Buf(hSlow, 1);
   if(f1 == EMPTY_VALUE || f4 == EMPTY_VALUE || s1 == EMPTY_VALUE)
      return 0;
   if(f1 > s1 && f1 > f4)
      return 1;
   if(f1 < s1 && f1 < f4)
      return -1;
   return 0;
  }

//+------------------------------------------------------------------+
//| Pullback signal on the last closed bar, in the trend direction   |
//+------------------------------------------------------------------+
int PullbackSignal(int trend)
  {
   double e = Buf(hPull, 1);
   if(e == EMPTY_VALUE)
      return 0;
   double o = iOpen(_Symbol, _Period, 1), c = iClose(_Symbol, _Period, 1);
   double h = iHigh(_Symbol, _Period, 1), l = iLow(_Symbol, _Period, 1);
   if(trend > 0 && l <= e && c > e && c > o)
      return 1;
   if(trend < 0 && h >= e && c < e && c < o)
      return -1;
   return 0;
  }

//+------------------------------------------------------------------+
void EvaluateEntry(double atr, DayStats &d)
  {
   int trend = TrendDir();
   if(trend == 0)
     {
      gSignal = "no trend - standing aside";
      return;
     }
   int sig = PullbackSignal(trend);
   if(sig == 0)
     {
      gSignal = StringFormat("trend %s, waiting for pullback to EMA%d", trend > 0 ? "UP" : "DOWN", InpPullbackEMA);
      return;
     }

   string side = sig > 0 ? "BUY" : "SELL";
   string when = TimeToString(TimeCurrent(), TIME_MINUTES);
   gSignal = side + " setup at " + when;
   DrawArrow(sig);

   string why = "";
   if(gHalt != "")
      why = "halted: " + gHalt;
   else
      if(HasPosition())
         why = "already in a position";
      else
         if(d.entries >= InpMaxTradesDay)
            why = StringFormat("max %d entries today reached", InpMaxTradesDay);
         else
            if(!InSession(why))
              {}
            else
               if(NewsBlocked(why))
                  why = "news: " + why;
               else
                 {
                  double spread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
                  if(spread > InpMaxSpread)
                     why = StringFormat("spread %.2f > max %.2f", spread, InpMaxSpread);
                  else
                     if(atr == EMPTY_VALUE || atr <= 0)
                        why = "ATR not ready";
                 }
   if(why != "")
     {
      gSkip = side + " skipped " + when + ": " + why;
      return;
     }
   Enter(sig, atr, when);
  }

//+------------------------------------------------------------------+
void Enter(int dir, double atr, string when)
  {
   string side = dir > 0 ? "BUY" : "SELL";
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double price = dir > 0 ? ask : bid;
   double dist = InpSlAtr * atr;
   double minDist = (SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) + 1) * _Point;
   if(dist < minDist)
     {
      gSkip = side + " skipped " + when + ": stop closer than broker minimum";
      return;
     }
   double sl = NormPrice(dir > 0 ? price - dist : price + dist);
   double tp = InpTpR > 0 ? NormPrice(dir > 0 ? price + InpTpR * dist : price - InpTpR * dist) : 0.0;

   double riskPct;
   double lots = LotsForRisk(dist, riskPct);
   if(lots <= 0)
     {
      gSkip = side + " skipped " + when + ": could not size the trade";
      return;
     }
   if(riskPct > InpMaxRiskPct)
     {
      gSkip = StringFormat("%s skipped %s: min lot risks %.1f%% (cap %.1f%%) - use a cent account", side, when, riskPct, InpMaxRiskPct);
      return;
     }
   double margin = 0;
   if(OrderCalcMargin(dir > 0 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, _Symbol, lots, price, margin)
      && margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     {
      gSkip = side + " skipped " + when + ": not enough free margin";
      return;
     }

   bool ok = dir > 0 ? trade.Buy(lots, _Symbol, 0.0, sl, tp, "XauPullback")
             : trade.Sell(lots, _Symbol, 0.0, sl, tp, "XauPullback");
   if(ok && (trade.ResultRetcode() == TRADE_RETCODE_DONE || trade.ResultRetcode() == TRADE_RETCODE_PLACED))
     {
      // Remember the initial risk so breakeven/trailing measure R correctly after the stop moves.
      GlobalVariableSet(RKey(trade.ResultOrder()), dist);
      gSkip = StringFormat("%s %.2f lot sent %s, risk %.1f%%", side, lots, when, riskPct);
     }
   else
      gSkip = StringFormat("%s failed %s: %u %s", side, when, trade.ResultRetcode(), trade.ResultRetcodeDescription());
  }

//+------------------------------------------------------------------+
//| Breakeven at InpBeAtR, then trail InpTrailAtr ATRs behind price  |
//+------------------------------------------------------------------+
void ManagePositions(double atr)
  {
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID), ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double minDist = (SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) + 1) * _Point;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !IsOurs())
         continue;
      double open = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
      double r = InitialRisk(open, sl);
      if(r <= 0)
         continue;
      double step = MathMax(_Point, 0.02 * r);

      if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
        {
         if(bid - open < InpBeAtR * r)
            continue;
         double newSl = MathMax(open + 0.1 * r, bid - InpTrailAtr * atr);
         newSl = NormPrice(newSl);
         if((sl == 0 || newSl >= sl + step) && bid - newSl >= minDist)
            trade.PositionModify(tk, newSl, tp);
        }
      else
        {
         if(open - ask < InpBeAtR * r)
            continue;
         double newSl = MathMin(open - 0.1 * r, ask + InpTrailAtr * atr);
         newSl = NormPrice(newSl);
         if((sl == 0 || newSl <= sl - step) && newSl - ask >= minDist)
            trade.PositionModify(tk, newSl, tp);
        }
     }
  }

//+------------------------------------------------------------------+
double InitialRisk(double open, double sl)
  {
   string key = RKey((ulong)PositionGetInteger(POSITION_IDENTIFIER));
   if(GlobalVariableCheck(key))
      return GlobalVariableGet(key);
   return sl > 0 ? MathAbs(open - sl) : 0.0;
  }

string RKey(ulong id) { return "XP_R_" + IntegerToString((long)InpMagic) + "_" + IntegerToString((long)id); }

//+------------------------------------------------------------------+
double LotsForRisk(double dist, double &riskPct)
  {
   riskPct = 0;
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tv <= 0)
      tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(ts <= 0 || tv <= 0 || eq <= 0)
      return 0;
   double perLot = dist / ts * tv;
   double lots = NormLots(eq * InpRiskPct / 100.0 / perLot);
   riskPct = lots * perLot / eq * 100.0;
   return lots;
  }

//+------------------------------------------------------------------+
double NormLots(double lots)
  {
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      step = 0.01;
   lots = MathFloor(lots / step + 1e-9) * step;
   lots = MathMax(minL, MathMin(maxL, lots));
   int dg = 0;
   for(double s = step; s < 1.0 - 1e-9 && dg < 8; s *= 10)
      dg++;
   return NormalizeDouble(lots, dg);
  }

//+------------------------------------------------------------------+
double NormPrice(double p)
  {
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(ts > 0)
      p = MathRound(p / ts) * ts;
   return NormalizeDouble(p, _Digits);
  }

//+------------------------------------------------------------------+
//| Today's closed P/L, entries and current loss streak (this EA)    |
//+------------------------------------------------------------------+
void GetDay(DayStats &d)
  {
   d.realized = 0;
   d.entries = 0;
   d.lossStreak = 0;
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   t.hour = 0;
   t.min = 0;
   t.sec = 0;
   if(!HistorySelect(StructToTime(t), TimeCurrent() + 60))
      return;
   int n = HistoryDealsTotal();
   for(int i = 0; i < n; i++)
     {
      ulong tk = HistoryDealGetTicket(i);
      if(tk == 0 || (ulong)HistoryDealGetInteger(tk, DEAL_MAGIC) != InpMagic || HistoryDealGetString(tk, DEAL_SYMBOL) != _Symbol)
         continue;
      double p = HistoryDealGetDouble(tk, DEAL_PROFIT) + HistoryDealGetDouble(tk, DEAL_SWAP)
                 + HistoryDealGetDouble(tk, DEAL_COMMISSION) + HistoryDealGetDouble(tk, DEAL_FEE);
      d.realized += p;
      if(HistoryDealGetInteger(tk, DEAL_ENTRY) == DEAL_ENTRY_IN)
         d.entries++;
      else
         d.lossStreak = p < 0 ? d.lossStreak + 1 : 0;
     }
  }

//+------------------------------------------------------------------+
bool IsOurs()
  {
   return PositionGetString(POSITION_SYMBOL) == _Symbol && (ulong)PositionGetInteger(POSITION_MAGIC) == InpMagic;
  }

bool HasPosition()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(PositionGetTicket(i) != 0 && IsOurs())
         return true;
   return false;
  }

double Floating()
  {
   double f = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(PositionGetTicket(i) != 0 && IsOurs())
         f += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
   return f;
  }

void CloseAll(string reason)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk != 0 && IsOurs())
         trade.PositionClose(tk);
     }
   gSkip = "closed all: " + reason;
  }

//+------------------------------------------------------------------+
bool InSession(string &why)
  {
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   if(t.day_of_week == 0 || t.day_of_week == 6)
     {
      why = "weekend";
      return false;
     }
   if(t.day_of_week == 5 && t.hour >= InpFridayCutoff)
     {
      why = "Friday cutoff";
      return false;
     }
   if(t.hour < InpSessionStart || t.hour >= InpSessionEnd)
     {
      why = StringFormat("outside session %02d-%02d", InpSessionStart, InpSessionEnd);
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| High-impact USD event within the window. The economic calendar   |
//| is not available in the Strategy Tester, so it is off there.    |
//+------------------------------------------------------------------+
bool NewsBlocked(string &what)
  {
   static datetime lastCheck = 0;
   static bool     blocked = false;
   static string   name = "";
   what = "";
   if(!InpNewsFilter || MQLInfoInteger(MQL_TESTER))
      return false;
   datetime now = TimeTradeServer();
   if(now - lastCheck >= 60)
     {
      lastCheck = now;
      blocked = false;
      name = "";
      MqlCalendarValue vals[];
      CalendarValueHistory(vals, now - InpNewsAfterMin * 60, now + InpNewsBeforeMin * 60, NULL, "USD");
      for(int i = 0; i < ArraySize(vals); i++)
        {
         MqlCalendarEvent ev;
         if(!CalendarEventById(vals[i].event_id, ev) || ev.importance != CALENDAR_IMPORTANCE_HIGH)
            continue;
         blocked = true;
         name = ev.name + " " + TimeToString(vals[i].time, TIME_MINUTES);
         break;
        }
     }
   what = name;
   return blocked;
  }

//+------------------------------------------------------------------+
//| Live panel                                                       |
//+------------------------------------------------------------------+
void DrawArrow(int dir)
  {
   datetime t = iTime(_Symbol, _Period, 1);
   string name = "XP_a" + IntegerToString((long)t);
   double price = dir > 0 ? iLow(_Symbol, _Period, 1) : iHigh(_Symbol, _Period, 1);
   if(ObjectCreate(0, name, dir > 0 ? OBJ_ARROW_BUY : OBJ_ARROW_SELL, 0, t, price))
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
  }

void Row(int row, string text, color clr)
  {
   string name = "XP_r" + IntegerToString(row);
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, 14);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, 28 + row * 17);
      ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
     }
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
  }

void Background(int rows)
  {
   string name = "XP_bg";
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, 6);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, 20);
      ObjectSetInteger(0, name, OBJPROP_XSIZE, 560);
      ObjectSetInteger(0, name, OBJPROP_BGCOLOR, C'18,22,30');
      ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, name, OBJPROP_COLOR, C'60,70,90');
      ObjectSetInteger(0, name, OBJPROP_BACK, false);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
     }
   ObjectSetInteger(0, name, OBJPROP_YSIZE, rows * 17 + 14);
  }

void UpdatePanel(double atr, DayStats &d, double dayPnl, double dayPct)
  {
   color txt = C'210,215,225', good = C'80,200,120', bad = C'235,90,90', warn = C'240,190,70';
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID), ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double spread = ask - bid;
   int trend = TrendDir();
   string sessWhy = "", newsWhat = "";
   bool inSess = InSession(sessWhy);
   bool news = NewsBlocked(newsWhat);
   int row = 0;

   Background(11);
   Row(row++, "XAU PULLBACK  " + _Symbol + "  " + (gHalt == "" ? "[ACTIVE]" : "[HALTED: " + gHalt + "]"),
       gHalt == "" ? good : bad);
   Row(row++, StringFormat("Trend %-5s  %s  (EMA%d vs EMA%d)", EnumToString(InpTrendTF), trend > 0 ? "UP" : trend < 0 ? "DOWN" : "NONE",
                           InpTrendFast, InpTrendSlow), trend > 0 ? good : trend < 0 ? bad : warn);
   Row(row++, "Signal      " + gSignal, txt);
   Row(row++, atr == EMPTY_VALUE ? "ATR         not ready" :
       StringFormat("ATR(%d)     %.2f   stop distance %.2f", InpAtrPeriod, atr, InpSlAtr * atr), txt);
   Row(row++, StringFormat("Spread      %.2f / max %.2f", spread, InpMaxSpread), spread > InpMaxSpread ? bad : good);
   Row(row++, "Session     " + (inSess ? StringFormat("open (%02d-%02d server)", InpSessionStart, InpSessionEnd) : sessWhy),
       inSess ? good : warn);
   Row(row++, "News        " + (!InpNewsFilter ? "filter off" : MQLInfoInteger(MQL_TESTER) ? "not available in tester" :
                                news ? "BLOCKED: " + newsWhat : "clear"), news ? bad : txt);

   string pos = "Position    flat";
   color posClr = txt;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetTicket(i) == 0 || !IsOurs())
         continue;
      bool buy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double open = PositionGetDouble(POSITION_PRICE_OPEN), sl = PositionGetDouble(POSITION_SL);
      double r = InitialRisk(open, sl);
      double nowR = r > 0 ? (buy ? bid - open : open - ask) / r : 0;
      double p = PositionGetDouble(POSITION_PROFIT);
      pos = StringFormat("Position    %s %.2f @ %.2f  SL %.2f  TP %.2f  %+.2fR  %+.2f",
                         buy ? "BUY" : "SELL", PositionGetDouble(POSITION_VOLUME), open, sl,
                         PositionGetDouble(POSITION_TP), nowR, p);
      posClr = p >= 0 ? good : bad;
      break;
     }
   Row(row++, pos, posClr);
   Row(row++, StringFormat("Today       %+.2f (%+.2f%%)  entries %d/%d  loss streak %d/%d",
                           dayPnl, dayPct, d.entries, InpMaxTradesDay, d.lossStreak, InpMaxLossStreak), dayPnl >= 0 ? good : bad);
   Row(row++, StringFormat("Limits      risk %.1f%%/trade  daily stop -%.1f%%  equity %.2f",
                           InpRiskPct, InpDailyLossPct, AccountInfoDouble(ACCOUNT_EQUITY)), txt);
   Row(row++, "Last        " + gSkip, txt);
   ChartRedraw();
  }
//+------------------------------------------------------------------+
