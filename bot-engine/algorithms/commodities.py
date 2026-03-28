"""
bot-engine/algorithms/commodities.py
======================================
Fixed CommoditiesAlgo.

Added restart recovery: re-syncs open positions from DB on first
cycle per symbol so Render restarts don't cause duplicate opens.
"""

import pandas as pd
import logging
from typing import Optional, Dict
from datetime import datetime, timedelta
import pytz

from ta.trend import MACD
from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)
IST = pytz.timezone("Asia/Kolkata")


class CommoditiesAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced: set = set()

    @property
    def market_type(self) -> str:
        return "commodities"

    def config_filename(self) -> str:
        return "commodities.json"

    def default_config(self) -> Dict:
        return {
            "symbols": ["GOLD", "SILVER", "CRUDEOIL"],
            "timeframe": "15m",
            "trading_hours": {"start": "09:00", "end": "23:25"},
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["GOLD"])

    def _is_trading_time(self) -> bool:
        now   = datetime.now(IST).strftime("%H:%M")
        hours = self.config.get("trading_hours", {})
        return hours.get("start", "09:00") <= now <= hours.get("end", "23:25")

    # ── DB re-sync after restart ──────────────────────────────────────────────

    async def _sync_position_from_db(self, symbol: str):
        if symbol in self._db_synced:
            return
        self._db_synced.add(symbol)

        try:
            open_row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if open_row and symbol not in self._open_positions:
                opened_at = open_row["opened_at"]
                if hasattr(opened_at, "tzinfo") and opened_at.tzinfo is not None:
                    opened_at = opened_at.replace(tzinfo=None)

                self._open_positions[symbol] = {
                    "signal":      open_row["side"].upper(),
                    "entry_price": float(open_row["entry_price"]),
                    "opened_at":   opened_at,
                }
                logger.info(
                    f"🔄 Restored position from DB: {open_row['side'].upper()} "
                    f"{symbol} @ {open_row['entry_price']}"
                )
        except Exception as e:
            logger.error(f"❌ DB sync failed for {symbol}: {e}", exc_info=True)

    # ── Position helpers ──────────────────────────────────────────────────────

    def _has_position(self, symbol: str) -> bool:
        return symbol in self._open_positions

    def _open(self, symbol: str, signal: str, price: float):
        self._open_positions[symbol] = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
        }
        logger.info(f"📂 Position opened: {signal} {symbol} @ {price:.4f}")

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        if pos:
            logger.info(
                f"📁 Position closed: {pos['signal']} {symbol} "
                f"entry={pos['entry_price']:.4f} reason={reason}"
            )

    async def generate_signal(self, symbol: str) -> Optional[str]:
        # ── Step 0: Re-sync from DB after restart ─────────────────────────
        await self._sync_position_from_db(symbol)

        if not self._is_trading_time():
            return None

        # ── Exit check for open positions ──────────────────────────────────
        if self._has_position(symbol):
            return await self._check_exit(symbol)

        df = await self.connector.fetch_ohlcv(symbol, "15m", limit=100)
        if len(df) < 35:
            return None

        macd_obj = MACD(df["close"], window_slow=26, window_fast=12, window_sign=9)
        df["macd"]      = macd_obj.macd()
        df["macd_sig"]  = macd_obj.macd_signal()
        df["macd_hist"] = macd_obj.macd_diff()
        df["vwap"]      = (df["close"] * df["volume"]).cumsum() / df["volume"].cumsum()

        curr = df.iloc[-1]
        prev = df.iloc[-2]

        if any(pd.isna([curr["macd"], curr["macd_sig"], curr["vwap"]])):
            return None

        crossed_up   = prev["macd"] <= prev["macd_sig"] and curr["macd"] > curr["macd_sig"]
        crossed_down = prev["macd"] >= prev["macd_sig"] and curr["macd"] < curr["macd_sig"]

        close = float(curr["close"])

        if crossed_up and close > curr["vwap"] and curr["macd_hist"] > 0:
            self._open(symbol, "BUY", close)
            return "BUY"
        if crossed_down and close < curr["vwap"]:
            self._open(symbol, "SELL", close)
            return "SELL"

        return None

    async def _check_exit(self, symbol: str) -> Optional[str]:
        pos       = self._open_positions[symbol]
        side      = pos["signal"]
        entry     = pos["entry_price"]
        opened_at = pos["opened_at"]

        sl_pct = float(self.risk.cfg.stop_loss_pct)
        tp_pct = float(self.risk.cfg.take_profit_pct)

        try:
            ticker = await self.connector.fetch_ticker(symbol)
            close  = float(ticker.get("last", 0))
            if not close:
                return None
        except Exception:
            return None

        if side == "BUY":
            pnl_pct = ((close - entry) / entry) * 100
            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%")
                return "SELL"
            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%")
                return "SELL"
            # Time limit: 4h
            if (datetime.utcnow() - opened_at) > timedelta(hours=4):
                self._close(symbol, "time limit 4h")
                return "SELL"

        elif side == "SELL":
            pnl_pct = ((entry - close) / entry) * 100
            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%")
                return "BUY"
            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%")
                return "BUY"
            if (datetime.utcnow() - opened_at) > timedelta(hours=4):
                self._close(symbol, "time limit 4h")
                return "BUY"

        return None