"""
bot-engine/algorithms/commodities.py — v3
==========================================
Two strategies for commodities (MCX: Gold, Silver, Crude, NatGas):

  1. BOLLINGER_SQUEEZE — Bollinger Band contraction then expansion breakout
     When the band narrows (low volatility), a breakout follows. Trade the
     direction of the breakout with RSI confirmation.

  2. VWAP_MACD — price reclaims VWAP + MACD crossover confirmation
     VWAP is the fair-value anchor. MACD confirms directional momentum.

SL = min(2×ATR, hard_limit_sl_pct)   — tighter wins.
TP = max(3.5×ATR, hard_limit_tp_pct) — wider wins.
Trailing stop: 1.5×ATR behind high-water mark (if Bot Settings enabled).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

import pandas as pd
import pytz
from ta.momentum import RSIIndicator
from ta.trend import MACD
from ta.volatility import AverageTrueRange, BollingerBands

from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)

IST = pytz.timezone("Asia/Kolkata")
ATR_SL_MULT = 2.0
ATR_TP_MULT = 3.5
ATR_TRAIL   = 1.5


def _atr_levels(entry: float, side: str, atr: float,
                hard_sl_pct: float, hard_tp_pct: float) -> Tuple[float, float]:
    sl_dist = min(atr * ATR_SL_MULT, entry * hard_sl_pct / 100.0)
    tp_dist = max(atr * ATR_TP_MULT, entry * hard_tp_pct / 100.0)
    if side.upper() == "BUY":
        return round(entry - sl_dist, 4), round(entry + tp_dist, 4)
    return round(entry + sl_dist, 4), round(entry - tp_dist, 4)


def _bb_bandwidth(close: pd.Series, window: int = 20) -> pd.Series:
    bb = BollingerBands(close, window=window, window_dev=2)
    return (bb.bollinger_hband() - bb.bollinger_lband()) / bb.bollinger_mavg()


class CommoditiesAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced:      set = set()
        self._staged_open:    Dict[str, Dict] = {}
        self._trail_high:     Dict[str, float] = {}
        self._trail_low:      Dict[str, float] = {}

    @property
    def market_type(self) -> str:
        return "commodities"

    def config_filename(self) -> str:
        return "commodities.json"

    def default_config(self) -> Dict:
        return {
            "symbols":            ["GOLD", "SILVER", "CRUDEOIL", "NATURALGAS"],
            "timeframe":          "15m",
            "risk_pct_per_trade": 5.0,
            "trading_hours":      {"start": "09:00", "end": "23:25"},
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["GOLD", "SILVER", "CRUDEOIL"])

    def _is_trading_time(self) -> bool:
        now   = datetime.now(IST).strftime("%H:%M")
        hours = self.config.get("trading_hours", {})
        return hours.get("start", "09:00") <= now <= hours.get("end", "23:25")

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
                self._trail_high[symbol] = ep
                self._trail_low[symbol]  = ep
                logger.info("🔄 Restored Commodities: %s %s @ %.4f",
                            row["side"].upper(), symbol, ep)
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
            logger.info("📁 Closed Commodities %s %s reason=%s", pos["signal"], symbol, reason)

    # ── Main signal ───────────────────────────────────────────────────────────

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)

        if not self._is_trading_time():
            return None

        df = await self.connector.fetch_ohlcv_cached(symbol, "15m", limit=120)
        if len(df) < 40:
            return None

        atr   = float(AverageTrueRange(df["high"], df["low"], df["close"], window=14)
                      .average_true_range().iloc[-1])
        close = float(df["close"].iloc[-1])

        if self._has_position(symbol):
            return self._check_exit(symbol, df, atr)

        # Strategy 1: Bollinger Band Squeeze Breakout
        bw     = _bb_bandwidth(df["close"])
        bw_avg = bw.rolling(50).mean()
        in_squeeze = (
            len(bw) >= 50 and
            float(bw.iloc[-6:-1].mean()) < float(bw_avg.iloc[-1]) * 0.8
        )

        if in_squeeze:
            bb     = BollingerBands(df["close"], window=20, window_dev=2)
            bb_up  = float(bb.bollinger_hband().iloc[-1])
            bb_dn  = float(bb.bollinger_lband().iloc[-1])
            rsi    = float(RSIIndicator(df["close"], window=14).rsi().iloc[-1])

            if close > bb_up and rsi < 70:
                self._stage_open(symbol, "BUY",  close, atr, "BB_SQUEEZE"); return "BUY"
            if close < bb_dn and rsi > 30:
                self._stage_open(symbol, "SELL", close, atr, "BB_SQUEEZE"); return "SELL"

        # Strategy 2: VWAP + MACD Momentum
        vwap = (df["close"] * df["volume"]).cumsum() / df["volume"].cumsum()
        mo   = MACD(df["close"], window_slow=26, window_fast=12, window_sign=9)
        ml   = mo.macd()
        ms   = mo.macd_signal()

        cross_up   = ml.iloc[-2] <= ms.iloc[-2] and ml.iloc[-1] > ms.iloc[-1]
        cross_down = ml.iloc[-2] >= ms.iloc[-2] and ml.iloc[-1] < ms.iloc[-1]
        curr_vwap  = float(vwap.iloc[-1])

        if cross_up   and close > curr_vwap:
            self._stage_open(symbol, "BUY",  close, atr, "VWAP_MACD"); return "BUY"
        if cross_down and close < curr_vwap:
            self._stage_open(symbol, "SELL", close, atr, "VWAP_MACD"); return "SELL"

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

        return None