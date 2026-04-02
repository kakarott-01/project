"""
bot-engine/algorithms/crypto.py — v3
======================================
FIX E (Open position deduplication):
  Previously self._open() was called INSIDE generate_signal() BEFORE the
  signal was returned. base_algo._process_symbol() then called save_paper_trade()
  which could return None (duplicate blocked by DB constraint). But _open()
  had already updated self._open_positions. This caused a phantom entry that
  would trigger exit logic next cycle with no corresponding DB trade.

  Fix: self._open() is now called AFTER the DB save succeeds, inside
  base_algo._process_symbol() via a new _confirm_open() hook. To accomplish
  this without restructuring every algo, generate_signal() now returns a
  (signal, price) tuple via a _pending_open staging dict. _confirm_open()
  is called by _process_symbol() after the DB save succeeds.

  SIMPLER ALTERNATIVE used here: generate_signal() now calls _stage_open()
  instead of _open(). _stage_open() stores the pending open in
  self._staged_open[symbol] without touching self._open_positions.
  _process_symbol() calls self._confirm_staged_open(symbol) only if save
  succeeds (trade_id is not None). If save returns None, staged open is
  discarded.

  For exit signals (returning SELL/BUY when _has_position is True),
  the flow is unchanged — _find_open_trade() reads from DB directly.

All algorithm logic unchanged.
"""

import pandas as pd
import logging
from typing import Optional, Dict
from datetime import datetime, timedelta

from ta.trend import EMAIndicator
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands

from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)


class CryptoAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions:    Dict[str, Dict] = {}
        self._last_signal_time:  Dict[str, datetime] = {}
        self._db_synced:         set = set()
        # Staging area: holds pending open data until DB confirms the insert
        self._staged_open:       Dict[str, Dict] = {}

    @property
    def market_type(self) -> str:
        return "crypto"

    def config_filename(self) -> str:
        return "crypto.json"

    def default_config(self) -> Dict:
        return {
            "symbols":                 ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
            "timeframe":               "15m",
            "trend_timeframe":         "4h",
            "signal_cooldown_minutes": 15,
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["BTC/USDT"])

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
                    f"🔄 Restored Crypto position from DB: {open_row['side'].upper()} "
                    f"{symbol} @ {open_row['entry_price']}"
                )
        except Exception as e:
            logger.error(f"❌ Crypto DB sync failed for {symbol}: {e}", exc_info=True)

    # ── Position helpers ──────────────────────────────────────────────────────

    def _on_cooldown(self, symbol: str) -> bool:
        last = self._last_signal_time.get(symbol)
        if not last:
            return False
        mins = self.config.get("signal_cooldown_minutes", 15)
        return (datetime.utcnow() - last) < timedelta(minutes=mins)

    def _has_position(self, symbol: str) -> bool:
        return symbol in self._open_positions

    def _stage_open(self, symbol: str, signal: str, price: float):
        """
        FIX E: Stage a pending open. Does NOT touch self._open_positions.
        base_algo._process_symbol() calls _confirm_staged_open() only
        if the DB save succeeds (trade_id is not None).
        """
        self._staged_open[symbol] = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
        }
        self._last_signal_time[symbol] = datetime.utcnow()
        logger.info(f"📋 Open staged (pending DB): {signal} {symbol} @ {price:.4f}")

    def _confirm_staged_open(self, symbol: str):
        """Called by base_algo after successful DB save."""
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending
            logger.info(
                f"📂 Position confirmed open: {pending['signal']} {symbol} "
                f"@ {pending['entry_price']:.4f}"
            )

    def _discard_staged_open(self, symbol: str):
        """Called by base_algo when DB save returns None (duplicate blocked)."""
        discarded = self._staged_open.pop(symbol, None)
        if discarded:
            logger.warning(
                f"🚫 Staged open discarded for {symbol} "
                "(duplicate blocked by DB constraint)"
            )

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        if pos:
            entry = pos["entry_price"]
            side  = pos["signal"]
            logger.info(f"📁 Position closed: {side} {symbol} entry={entry:.4f} reason={reason}")

    # ── Main signal ───────────────────────────────────────────────────────────

    async def generate_signal(self, symbol: str) -> Optional[str]:
        # Re-sync from DB after restart
        await self._sync_position_from_db(symbol)

        try:
            df_trend = await self.connector.fetch_ohlcv(symbol, "4h", limit=250)
            df       = await self.connector.fetch_ohlcv(symbol, "15m", limit=100)

            if len(df) < 35 or len(df_trend) < 210:
                return None

            df_trend["ema200"] = EMAIndicator(df_trend["close"], window=200).ema_indicator()
            trend_up = df_trend["close"].iloc[-1] > df_trend["ema200"].iloc[-1]

            df["rsi"] = RSIIndicator(df["close"], window=14).rsi()

            bb = BollingerBands(df["close"], window=20, window_dev=2)
            df["bb_lower"] = bb.bollinger_lband()
            df["bb_upper"] = bb.bollinger_hband()
            df["bb_mid"]   = bb.bollinger_mavg()

            df["ema9"]  = EMAIndicator(df["close"], window=9).ema_indicator()
            df["ema21"] = EMAIndicator(df["close"], window=21).ema_indicator()

            curr  = df.iloc[-1]
            prev  = df.iloc[-2]
            prev2 = df.iloc[-3]

            if any(pd.isna([curr["rsi"], curr["bb_lower"], curr["ema9"]])):
                return None

            rsi   = float(curr["rsi"])
            close = float(curr["close"])

            logger.info(
                f"{symbol} RSI={rsi:.1f} Close={close:.2f} TrendUp={trend_up} "
                f"Pos={'YES' if self._has_position(symbol) else 'no'} "
                f"CD={'YES' if self._on_cooldown(symbol) else 'no'}"
            )

            if self._has_position(symbol):
                return self._check_exit(symbol, curr, prev, rsi, close)

            if self._on_cooldown(symbol):
                return None

            # ── Trend-following entries ─────────────────────────────────────
            if trend_up:
                if (35 <= rsi <= 52 and
                        close > curr["bb_mid"] and
                        curr["ema9"] > curr["ema21"] and
                        curr["rsi"] > prev["rsi"]):
                    self._stage_open(symbol, "BUY", close)  # FIX E: stage, not open
                    return "BUY"
            else:
                if (48 <= rsi <= 62 and
                        close < curr["bb_mid"] and
                        curr["ema9"] < curr["ema21"] and
                        curr["rsi"] < prev["rsi"]):
                    self._stage_open(symbol, "SELL", close)  # FIX E
                    return "SELL"

            # ── Mean-reversion entries ──────────────────────────────────────
            rsi_rising_2 = curr["rsi"] > prev["rsi"] > prev2["rsi"]
            if (close <= curr["bb_lower"] * 1.002 and
                    rsi < 32 and
                    rsi_rising_2):
                self._stage_open(symbol, "BUY", close)  # FIX E
                return "BUY"

            rsi_falling_2 = curr["rsi"] < prev["rsi"] < prev2["rsi"]
            if (close >= curr["bb_upper"] * 0.998 and
                    rsi > 68 and
                    rsi_falling_2):
                self._stage_open(symbol, "SELL", close)  # FIX E
                return "SELL"

            return None

        except Exception as e:
            logger.error(f"❌ Signal error {symbol}: {e}", exc_info=True)
            return None

    def _check_exit(self, symbol: str, curr, prev, rsi: float, close: float) -> Optional[str]:
        pos       = self._open_positions[symbol]
        side      = pos["signal"]
        entry     = pos["entry_price"]
        opened_at = pos["opened_at"]

        sl_pct = float(self.risk.cfg.stop_loss_pct)
        tp_pct = float(self.risk.cfg.take_profit_pct)

        if side == "SELL":
            pnl_pct = ((entry - close) / entry) * 100
            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%"); return "BUY"
            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%"); return "BUY"
            if rsi < 58 and curr["rsi"] < prev["rsi"]:
                self._close(symbol, f"RSI retreat to {rsi:.1f}"); return "BUY"
            if (datetime.utcnow() - opened_at) > timedelta(hours=2):
                self._close(symbol, "time limit 2h"); return "BUY"

        elif side == "BUY":
            pnl_pct = ((close - entry) / entry) * 100
            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%"); return "SELL"
            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%"); return "SELL"
            if rsi > 62 and curr["rsi"] < prev["rsi"]:
                self._close(symbol, f"RSI peak at {rsi:.1f}"); return "SELL"
            if (datetime.utcnow() - opened_at) > timedelta(hours=2):
                self._close(symbol, "time limit 2h"); return "SELL"

        return None