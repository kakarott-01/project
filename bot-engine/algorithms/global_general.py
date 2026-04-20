"""
bot-engine/algorithms/global_general.py — v3
=============================================
Two proven strategies for global markets (US equities, Forex, ETFs):

  1. EMA_200_PULLBACK — primary
     EMA200 defines the macro trend. EMA50 defines momentum.
     Enter when price pulls back to EMA50 within the EMA200 trend.
     RSI 40-60 confirms the pullback hasn't overextended.
     Works on any liquid instrument; widely used by prop desks.

  2. RSI_2_MEAN_REVERT — secondary (Larry Connors strategy)
     2-period RSI < 5 in an uptrend (extreme oversold) → BUY
     2-period RSI > 95 in a downtrend (extreme overbought) → SELL
     High win rate in trending markets (published academic literature).
     Exit when RSI-2 normalises past 70/30.

SL = min(2×ATR, hard_limit_sl_pct)   — tighter wins.
TP = max(4×ATR, hard_limit_tp_pct)   — wider wins.
Trailing stop: 1.5×ATR (if Bot Settings enabled).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

import pandas as pd
from ta.momentum import RSIIndicator
from ta.trend import EMAIndicator
from ta.volatility import AverageTrueRange

from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)

ATR_SL_MULT = 2.0
ATR_TP_MULT = 4.0
ATR_TRAIL   = 1.5


def _atr_levels(entry: float, side: str, atr: float,
                hard_sl_pct: float, hard_tp_pct: float) -> Tuple[float, float]:
    sl_dist = min(atr * ATR_SL_MULT, entry * hard_sl_pct / 100.0)
    tp_dist = max(atr * ATR_TP_MULT, entry * hard_tp_pct / 100.0)
    if side.upper() == "BUY":
        return round(entry - sl_dist, 8), round(entry + tp_dist, 8)
    return round(entry + sl_dist, 8), round(entry - tp_dist, 8)


class GlobalAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced:      set = set()
        self._staged_open:    Dict[str, Dict] = {}
        self._trail_high:     Dict[str, float] = {}
        self._trail_low:      Dict[str, float] = {}

    @property
    def market_type(self) -> str:
        return "global"

    def config_filename(self) -> str:
        return "global_general.json"

    def default_config(self) -> Dict:
        return {
            "symbols":            ["BTC/USDT", "ETH/USDT"],
            "timeframe":          "1h",
            "risk_pct_per_trade": 5.0,
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["BTC/USDT", "ETH/USDT"])

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
                    "strategy":    meta.get("strategy", "EMA_200_PULLBACK") if isinstance(meta, dict) else "EMA_200_PULLBACK",
                }
                ep = float(row["entry_price"])
                self._trail_high[symbol] = ep
                self._trail_low[symbol]  = ep
                logger.info("🔄 Restored Global: %s %s @ %.4f",
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
            logger.info("📁 Closed Global %s %s reason=%s", pos["signal"], symbol, reason)

    # ── Main signal ───────────────────────────────────────────────────────────

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)

        try:
            df = await self.connector.fetch_ohlcv_cached(symbol, "1h", limit=250)
        except Exception as e:
            logger.error("❌ OHLCV %s: %s", symbol, e)
            return None

        if len(df) < 60:
            return None

        close  = df["close"]
        high   = df["high"]
        low    = df["low"]
        atr_s  = AverageTrueRange(high, low, close, window=14).average_true_range()
        atr    = float(atr_s.iloc[-1])
        ema50  = EMAIndicator(close, window=50).ema_indicator()
        ema200 = EMAIndicator(close, window=min(200, len(df) - 1)).ema_indicator()
        rsi14  = RSIIndicator(close, window=14).rsi()
        rsi2   = RSIIndicator(close, window=2).rsi()

        curr_price  = float(close.iloc[-1])
        curr_ema50  = float(ema50.iloc[-1])
        curr_ema200 = float(ema200.iloc[-1])
        curr_rsi14  = float(rsi14.iloc[-1])
        prev_rsi14  = float(rsi14.iloc[-2])
        curr_rsi2   = float(rsi2.iloc[-1])

        if self._has_position(symbol):
            return self._check_exit(symbol, df, atr)

        # Strategy 1: EMA 200 Pullback
        if curr_ema50 > curr_ema200:
            near = abs(curr_price - curr_ema50) / curr_ema50 <= 0.015
            if near and 40 <= curr_rsi14 <= 60 and curr_rsi14 > prev_rsi14:
                self._stage_open(symbol, "BUY", curr_price, atr, "EMA_200_PULLBACK")
                return "BUY"
        elif curr_ema50 < curr_ema200:
            near = abs(curr_price - curr_ema50) / curr_ema50 <= 0.015
            if near and 40 <= curr_rsi14 <= 60 and curr_rsi14 < prev_rsi14:
                self._stage_open(symbol, "SELL", curr_price, atr, "EMA_200_PULLBACK")
                return "SELL"

        # Strategy 2: RSI-2 Mean Reversion (Connors)
        # Only trade in direction of macro trend
        if curr_ema50 > curr_ema200 and curr_rsi2 < 5:
            self._stage_open(symbol, "BUY",  curr_price, atr, "RSI2_REVERT")
            return "BUY"
        if curr_ema50 < curr_ema200 and curr_rsi2 > 95:
            self._stage_open(symbol, "SELL", curr_price, atr, "RSI2_REVERT")
            return "SELL"

        return None

    # ── Exit logic ────────────────────────────────────────────────────────────

    def _check_exit(self, symbol: str, df: pd.DataFrame, curr_atr: float) -> Optional[str]:
        pos      = self._open_positions[symbol]
        side     = pos["signal"]
        entry    = pos["entry_price"]
        sl       = pos.get("stop_loss")
        tp       = pos.get("take_profit")
        atr      = max(pos.get("atr", curr_atr), curr_atr)
        strategy = pos.get("strategy", "EMA_200_PULLBACK")

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

        # RSI-2 positions exit quickly once RSI normalises
        if strategy == "RSI2_REVERT":
            rsi2 = float(RSIIndicator(df["close"], window=2).rsi().iloc[-1])
            if side == "BUY"  and rsi2 > 70:
                self._close(symbol, f"RSI2_NORMALISED {rsi2:.1f}"); return "SELL"
            if side == "SELL" and rsi2 < 30:
                self._close(symbol, f"RSI2_NORMALISED {rsi2:.1f}"); return "BUY"

        # EMA crossover = trend invalidation (exit EMA pullback trades only)
        if strategy == "EMA_200_PULLBACK":
            ema50  = float(EMAIndicator(df["close"], window=50).ema_indicator().iloc[-1])
            ema200 = float(EMAIndicator(df["close"], window=min(200, len(df)-1)).ema_indicator().iloc[-1])
            if side == "BUY"  and ema50 < ema200:
                self._close(symbol, "EMA_CROSS"); return "SELL"
            if side == "SELL" and ema50 > ema200:
                self._close(symbol, "EMA_CROSS"); return "BUY"

        return None