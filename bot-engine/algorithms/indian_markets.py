"""
bot-engine/algorithms/indian_markets.py — v3
============================================
Two proven strategies for Indian equity markets (NSE/BSE):

  1. OPENING_RANGE_BREAKOUT (ORB) — primary
     First 30 min (9:15–9:45 IST) defines today's range.
     Trade breakout above/below with volume confirmation.
     Used by professional Indian intraday traders and prop firms.

  2. SUPERTREND_MACD — secondary
     Supertrend (ATR-based trend indicator) must agree with MACD
     signal line crossover. Both must confirm before entry.

SL = min(1.5×ATR, hard_limit_sl_pct)   — tighter wins.
TP = max(3.0×ATR, hard_limit_tp_pct)   — wider wins.
Trailing stop: follows 1×ATR behind high-water mark (if Bot Settings enabled).
EOD square-off at 15:15 unchanged.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

import pandas as pd
import pytz
from ta.momentum import RSIIndicator
from ta.trend import EMAIndicator, MACD
from ta.volatility import AverageTrueRange

from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)

IST = pytz.timezone("Asia/Kolkata")
MARKET_OPEN  = "09:15"
ORB_END      = "09:45"
MARKET_CLOSE = "15:10"   # no new entries after this
SQUARE_OFF   = "15:15"   # force-close all

ATR_SL_MULT = 1.5
ATR_TP_MULT = 3.0
ATR_TRAIL   = 1.0


def _atr_levels(entry: float, side: str, atr: float,
                hard_sl_pct: float, hard_tp_pct: float) -> Tuple[float, float]:
    sl_dist = min(atr * ATR_SL_MULT, entry * hard_sl_pct / 100.0)
    tp_dist = max(atr * ATR_TP_MULT, entry * hard_tp_pct / 100.0)
    if side.upper() == "BUY":
        return round(entry - sl_dist, 4), round(entry + tp_dist, 4)
    return round(entry + sl_dist, 4), round(entry - tp_dist, 4)


def _supertrend(df: pd.DataFrame, period: int = 10, mult: float = 3.0) -> pd.Series:
    """Returns direction series: +1.0 = bullish, -1.0 = bearish."""
    atr = AverageTrueRange(df["high"], df["low"], df["close"], window=period).average_true_range()
    hl2 = (df["high"] + df["low"]) / 2
    upper_raw = hl2 + mult * atr
    lower_raw = hl2 - mult * atr

    direction = pd.Series(1.0, index=df.index)
    st_upper  = upper_raw.copy()
    st_lower  = lower_raw.copy()

    for i in range(1, len(df)):
        prev_u = st_upper.iloc[i - 1]
        prev_l = st_lower.iloc[i - 1]
        close_prev = df["close"].iloc[i - 1]
        st_upper.iloc[i] = upper_raw.iloc[i] if upper_raw.iloc[i] < prev_u or close_prev > prev_u else prev_u
        st_lower.iloc[i] = lower_raw.iloc[i] if lower_raw.iloc[i] > prev_l or close_prev < prev_l else prev_l
        if df["close"].iloc[i] > st_upper.iloc[i]:
            direction.iloc[i] = 1.0
        elif df["close"].iloc[i] < st_lower.iloc[i]:
            direction.iloc[i] = -1.0
        else:
            direction.iloc[i] = direction.iloc[i - 1]

    return direction


class IndianMarketsAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced:      set = set()
        self._staged_open:    Dict[str, Dict] = {}
        self._orb:            Dict[str, Dict] = {}
        self._trail_high:     Dict[str, float] = {}
        self._trail_low:      Dict[str, float] = {}

    @property
    def market_type(self) -> str:
        return "indian"

    def config_filename(self) -> str:
        return "indian_markets.json"

    def default_config(self) -> Dict:
        return {
            "symbols":            ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
                                   "WIPRO", "AXISBANK", "SBIN", "LT", "MARUTI"],
            "timeframe":          "5m",
            "risk_pct_per_trade": 5.0,
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["RELIANCE", "TCS", "INFY"])

    # ── Time helpers ──────────────────────────────────────────────────────────

    def _ist(self) -> str:
        return datetime.now(IST).strftime("%H:%M")

    def _is_trading_time(self):
        t = self._ist()
        if t >= SQUARE_OFF:
            return False, True    # (can_trade, is_square_off)
        if t < MARKET_OPEN or t >= MARKET_CLOSE:
            return False, False
        return True, False

    # ── DB sync ───────────────────────────────────────────────────────────────

    async def _sync_position_from_db(self, symbol: str):
        if symbol in self._db_synced:
            return
        self._db_synced.add(symbol)
        try:
            row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if row and symbol not in self._open_positions:
                opened_at = row["opened_at"]
                if hasattr(opened_at, "tzinfo") and opened_at.tzinfo is not None:
                    opened_at = opened_at.astimezone(timezone.utc).replace(tzinfo=None)
                meta = row.get("metadata") or {}
                self._open_positions[symbol] = {
                    "signal":      row["side"].upper(),
                    "entry_price": float(row["entry_price"]),
                    "opened_at":   opened_at,
                    "stop_loss":   float(row["stop_loss"])   if row.get("stop_loss")   else None,
                    "take_profit": float(row["take_profit"]) if row.get("take_profit") else None,
                    "atr":         float(meta.get("atr", 0)) if isinstance(meta, dict) else 0.0,
                }
                ep = float(row["entry_price"])
                self._trail_high[symbol] = ep if row["side"].upper() == "BUY" else 0.0
                self._trail_low[symbol]  = ep if row["side"].upper() == "SELL" else float("inf")
                logger.info("🔄 Restored Indian: %s %s @ %.4f", row["side"].upper(), symbol, ep)
        except Exception as e:
            logger.error("❌ DB sync %s: %s", symbol, e, exc_info=True)

    # ── Position helpers ──────────────────────────────────────────────────────

    def _has_position(self, symbol: str) -> bool:
        return symbol in self._open_positions

    def _stage_open(self, symbol: str, signal: str, price: float, atr: float, strategy: str):
        sl, tp = _atr_levels(price, signal, atr,
                             float(self.risk.cfg.stop_loss_pct),
                             float(self.risk.cfg.take_profit_pct))
        self._staged_open[symbol] = {
            "signal": signal, "entry_price": price,
            "opened_at": datetime.utcnow(),
            "stop_loss": sl, "take_profit": tp,
            "atr": atr, "strategy": strategy,
        }
        logger.info("📋 STAGE %s: %s @ %.4f SL=%.4f TP=%.4f [%s]",
                    symbol, signal, price, sl, tp, strategy)

    def _confirm_staged_open(self, symbol: str):
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending
            ep = pending["entry_price"]
            self._trail_high[symbol] = ep
            self._trail_low[symbol]  = ep

    def _discard_staged_open(self, symbol: str):
        self._staged_open.pop(symbol, None)

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        self._trail_high.pop(symbol, None)
        self._trail_low.pop(symbol, None)
        if pos:
            logger.info("📁 Closed Indian %s %s reason=%s", pos["signal"], symbol, reason)

    # ── Main signal ───────────────────────────────────────────────────────────

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)

        can_trade, is_square_off = self._is_trading_time()

        # EOD force-close
        if is_square_off:
            if self._has_position(symbol):
                pos = self._open_positions[symbol]
                self._close(symbol, "EOD_SQUARE_OFF")
                return "SELL" if pos["signal"] == "BUY" else "BUY"
            return None

        if not can_trade:
            return None

        df = await self.connector.fetch_ohlcv_cached(symbol, "5m", limit=100)
        if len(df) < 30:
            return None

        atr = float(AverageTrueRange(df["high"], df["low"], df["close"], window=14)
                    .average_true_range().iloc[-1])

        if self._has_position(symbol):
            return self._check_exit(symbol, df, atr)

        ist_now = self._ist()
        close   = float(df["close"].iloc[-1])

        # Strategy 1: Opening Range Breakout (after ORB window closes)
        if ist_now >= ORB_END:
            sig = self._signal_orb(symbol, df)
            if sig:
                self._stage_open(symbol, sig, close, atr, "ORB")
                return sig

        # Strategy 2: Supertrend + MACD (any time after ORB window)
        if len(df) >= 35:
            sig = self._signal_supertrend_macd(df)
            if sig:
                self._stage_open(symbol, sig, close, atr, "SUPERTREND_MACD")
                return sig

        return None

    def _signal_orb(self, symbol: str, df: pd.DataFrame) -> Optional[str]:
        """First 6 bars of 5m = first 30 minutes = the opening range."""
        try:
            today = datetime.now(IST).date()
            mask  = df.index.tz_localize("UTC").tz_convert(IST).date == today if df.index.tzinfo is None else \
                    pd.DatetimeIndex(df.index).tz_convert(IST).date == today
            today_bars = df[mask] if mask.sum() >= 6 else df.iloc[-78:]
        except Exception:
            today_bars = df.iloc[-78:]

        first_6 = today_bars.iloc[:6] if len(today_bars) >= 6 else df.iloc[:6]
        if len(first_6) < 6:
            return None

        orb_high = float(first_6["high"].max())
        orb_low  = float(first_6["low"].min())
        self._orb[symbol] = {"high": orb_high, "low": orb_low}

        curr      = df.iloc[-1]
        close     = float(curr["close"])
        vol_avg   = float(df["volume"].rolling(20).mean().iloc[-1])
        vol_spike = float(curr["volume"]) > vol_avg * 1.2
        rsi       = float(RSIIndicator(df["close"], window=14).rsi().iloc[-1])

        if close > orb_high and vol_spike and rsi < 75:
            return "BUY"
        if close < orb_low  and vol_spike and rsi > 25:
            return "SELL"
        return None

    def _signal_supertrend_macd(self, df: pd.DataFrame) -> Optional[str]:
        """Supertrend direction + MACD signal-line crossover must agree."""
        st  = _supertrend(df, period=10, mult=3.0)
        mo  = MACD(df["close"], window_slow=26, window_fast=12, window_sign=9)
        ml  = mo.macd()
        ms  = mo.macd_signal()
        rsi = RSIIndicator(df["close"], window=14).rsi()

        cross_up   = ml.iloc[-2] <= ms.iloc[-2] and ml.iloc[-1] > ms.iloc[-1]
        cross_down = ml.iloc[-2] >= ms.iloc[-2] and ml.iloc[-1] < ms.iloc[-1]
        curr_rsi   = float(rsi.iloc[-1])

        if st.iloc[-1] == 1.0 and cross_up   and 30 <= curr_rsi <= 65:
            return "BUY"
        if st.iloc[-1] == -1.0 and cross_down and 35 <= curr_rsi <= 70:
            return "SELL"
        return None

    # ── Exit logic ────────────────────────────────────────────────────────────

    def _check_exit(self, symbol: str, df: pd.DataFrame, curr_atr: float) -> Optional[str]:
        pos   = self._open_positions[symbol]
        side  = pos["signal"]
        entry = pos["entry_price"]
        sl    = pos.get("stop_loss")
        tp    = pos.get("take_profit")
        atr   = max(pos.get("atr", curr_atr), curr_atr)

        curr  = df.iloc[-1]
        high  = float(curr["high"])
        low   = float(curr["low"])
        price = float(curr["close"])

        if sl:
            if side == "BUY"  and low  <= sl:
                self._set_exit_price_override(symbol, sl)
                self._close(symbol, f"SL @ {sl:.4f}"); return "SELL"
            if side == "SELL" and high >= sl:
                self._set_exit_price_override(symbol, sl)
                self._close(symbol, f"SL @ {sl:.4f}"); return "BUY"

        if tp:
            if side == "BUY"  and high >= tp:
                self._set_exit_price_override(symbol, tp)
                self._close(symbol, f"TP @ {tp:.4f}"); return "SELL"
            if side == "SELL" and low  <= tp:
                self._set_exit_price_override(symbol, tp)
                self._close(symbol, f"TP @ {tp:.4f}"); return "BUY"

        if self.risk.cfg.trailing_stop and atr > 0:
            if side == "BUY":
                nh = max(self._trail_high.get(symbol, entry), high)
                self._trail_high[symbol] = nh
                trail = nh - atr * ATR_TRAIL
                if trail > entry and price < trail:
                    self._set_exit_price_override(symbol, trail)
                    self._close(symbol, f"TRAIL @ {trail:.4f}"); return "SELL"
            else:
                nl = min(self._trail_low.get(symbol, entry), low)
                self._trail_low[symbol] = nl
                trail = nl + atr * ATR_TRAIL
                if trail < entry and price > trail:
                    self._set_exit_price_override(symbol, trail)
                    self._close(symbol, f"TRAIL @ {trail:.4f}"); return "BUY"

        # Supertrend flip = trend invalidation
        try:
            st = _supertrend(df, period=10, mult=3.0)
            if side == "BUY"  and st.iloc[-1] == -1.0:
                self._close(symbol, "SUPERTREND_FLIP"); return "SELL"
            if side == "SELL" and st.iloc[-1] ==  1.0:
                self._close(symbol, "SUPERTREND_FLIP"); return "BUY"
        except Exception:
            pass

        return None