"""
bot-engine/algorithms/indian_markets.py — v2
=============================================
FIX E: self._open() replaced with self._stage_open() for new entries.
       self._confirm_staged_open() / self._discard_staged_open() added.
       base_algo._process_symbol() calls these after the DB save result.

All algorithm logic unchanged.
"""

import pandas as pd
import logging
from typing import Optional, Dict
from datetime import datetime
import pytz

from ta.trend import EMAIndicator
from ta.momentum import RSIIndicator
from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)
IST = pytz.timezone("Asia/Kolkata")


class IndianMarketsAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced:      set = set()
        self._staged_open:    Dict[str, Dict] = {}

    @property
    def market_type(self) -> str:
        return "indian"

    def config_filename(self) -> str:
        return "indian_markets.json"

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["RELIANCE"])

    def _is_trading_time(self):
        now = datetime.now(IST).strftime("%H:%M")
        if now >= "15:15":
            return False, True
        if now < "09:20":
            return False, False
        return True, False

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

    def _stage_open(self, symbol: str, signal: str, price: float):
        """Stage a pending open. Does NOT touch _open_positions."""
        self._staged_open[symbol] = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
        }
        logger.info(f"📋 Open staged (pending DB): {signal} {symbol} @ {price:.4f}")

    def _confirm_staged_open(self, symbol: str):
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending
            logger.info(
                f"📂 Position confirmed: {pending['signal']} {symbol} "
                f"@ {pending['entry_price']:.4f}"
            )

    def _discard_staged_open(self, symbol: str):
        discarded = self._staged_open.pop(symbol, None)
        if discarded:
            logger.warning(f"🚫 Staged open discarded for {symbol} (duplicate blocked)")

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        if pos:
            logger.info(
                f"📁 Position closed: {pos['signal']} {symbol} "
                f"entry={pos['entry_price']:.4f} reason={reason}"
            )

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)

        can_trade, square_off = self._is_trading_time()

        if square_off:
            if self._has_position(symbol):
                pos = self._open_positions[symbol]
                self._close(symbol, "EOD square-off 15:15")
                return "SELL" if pos["signal"] == "BUY" else "BUY"
            return None

        if not can_trade:
            return None

        if self._has_position(symbol):
            return await self._check_exit(symbol)

        df = await self.connector.fetch_ohlcv(symbol, "5m", limit=60)
        if len(df) < 25:
            return None

        df["ema_fast"] = EMAIndicator(df["close"], window=9).ema_indicator()
        df["ema_slow"] = EMAIndicator(df["close"], window=21).ema_indicator()
        df["rsi"]      = RSIIndicator(df["close"], window=14).rsi()
        df["vol_avg"]  = df["volume"].rolling(20).mean()

        curr = df.iloc[-1]
        prev = df.iloc[-2]

        if any(pd.isna([curr["ema_fast"], curr["ema_slow"], curr["rsi"]])):
            return None

        cross_up   = prev["ema_fast"] <= prev["ema_slow"] and curr["ema_fast"] > curr["ema_slow"]
        cross_down = prev["ema_fast"] >= prev["ema_slow"] and curr["ema_fast"] < curr["ema_slow"]
        vol_spike  = curr["volume"] > curr["vol_avg"] * 1.5

        if cross_up and curr["rsi"] > 50 and vol_spike:
            self._stage_open(symbol, "BUY", float(curr["close"]))  # FIX E
            return "BUY"
        if cross_down and curr["rsi"] < 50:
            self._stage_open(symbol, "SELL", float(curr["close"]))  # FIX E
            return "SELL"

        return None

    async def _check_exit(self, symbol: str) -> Optional[str]:
        pos   = self._open_positions[symbol]
        side  = pos["signal"]
        entry = pos["entry_price"]

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
                self._close(symbol, f"TP +{pnl_pct:.2f}%"); return "SELL"
            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%"); return "SELL"
        elif side == "SELL":
            pnl_pct = ((entry - close) / entry) * 100
            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%"); return "BUY"
            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%"); return "BUY"

        return None