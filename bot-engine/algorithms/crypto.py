"""
bot-engine/algorithms/crypto.py
================================
Fixed CryptoAlgo.

Root problems fixed:
1. OVERTRADING: mean-rev SELL was firing every cycle because condition was too loose.
   Now requires RSI to be falling for 2 consecutive candles, not just 1.
2. NO EXITS: trades were only ever opened, never closed.
   Added full position tracking with TP/SL/RSI-based/time-based exits.
3. COOLDOWN: won't open a new position on a symbol that just fired a signal
   within the last N minutes (configurable, default 15m).
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
        # {symbol: {"signal": "SELL"|"BUY", "entry_price": float, "opened_at": datetime}}
        self._open_positions: Dict[str, Dict] = {}
        # {symbol: datetime} — when we last opened a position on this symbol
        self._last_signal_time: Dict[str, datetime] = {}

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

    # ── Position helpers ──────────────────────────────────────────────────────

    def _on_cooldown(self, symbol: str) -> bool:
        last = self._last_signal_time.get(symbol)
        if not last:
            return False
        mins = self.config.get("signal_cooldown_minutes", 15)
        return (datetime.utcnow() - last) < timedelta(minutes=mins)

    def _has_position(self, symbol: str) -> bool:
        return symbol in self._open_positions

    def _open(self, symbol: str, signal: str, price: float):
        self._open_positions[symbol]  = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
        }
        self._last_signal_time[symbol] = datetime.utcnow()
        logger.info(f"📂 Position opened: {signal} {symbol} @ {price:.4f}")

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        if pos:
            entry = pos["entry_price"]
            side  = pos["signal"]
            logger.info(f"📁 Position closed: {side} {symbol} entry={entry:.4f} reason={reason}")

    # ── Main signal ───────────────────────────────────────────────────────────

    async def generate_signal(self, symbol: str) -> Optional[str]:
        
        try:
            df_trend = await self.connector.fetch_ohlcv(symbol, "4h", limit=250)
            df       = await self.connector.fetch_ohlcv(symbol, "15m", limit=100)

            if len(df) < 35 or len(df_trend) < 210:
                return None

            # ── Indicators ─────────────────────────────────────────────────
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
                f"BB=[{curr['bb_lower']:.2f}–{curr['bb_upper']:.2f}] "
                f"Pos={'YES' if self._has_position(symbol) else 'no'} "
                f"CD={'YES' if self._on_cooldown(symbol) else 'no'}"
            )

            # ── EXIT logic: check open positions first ─────────────────────
            if self._has_position(symbol):
                return self._check_exit(symbol, curr, prev, rsi, close)

            # ── Don't open if on cooldown ──────────────────────────────────
            if self._on_cooldown(symbol):
                return None

            # ── ENTRY: Trend-following ─────────────────────────────────────
            if trend_up:
                # Long: RSI pulled back to neutral zone, momentum turning up, above BB mid
                if (35 <= rsi <= 52 and
                        close > curr["bb_mid"] and
                        curr["ema9"] > curr["ema21"] and
                        curr["rsi"] > prev["rsi"]):
                    self._open(symbol, "BUY", close)
                    return "BUY"
            else:
                # Short: RSI bounced to neutral in downtrend, momentum turning down
                if (48 <= rsi <= 62 and
                        close < curr["bb_mid"] and
                        curr["ema9"] < curr["ema21"] and
                        curr["rsi"] < prev["rsi"]):
                    self._open(symbol, "SELL", close)
                    return "SELL"

            # ── ENTRY: Mean-reversion (TIGHTENED - 2 candle confirmation) ──
            # BUY: Price touching lower band + RSI deeply oversold + rising for 2 candles
            rsi_rising_2 = curr["rsi"] > prev["rsi"] > prev2["rsi"]
            if (close <= curr["bb_lower"] * 1.002 and
                    rsi < 32 and
                    rsi_rising_2):
                self._open(symbol, "BUY", close)
                return "BUY"

            # SELL: Price touching upper band + RSI deeply overbought + falling for 2 candles
            rsi_falling_2 = curr["rsi"] < prev["rsi"] < prev2["rsi"]
            if (close >= curr["bb_upper"] * 0.998 and
                    rsi > 68 and
                    rsi_falling_2):
                self._open(symbol, "SELL", close)
                return "SELL"

            return None

        except Exception as e:
            logger.error(f"❌ Signal error {symbol}: {e}", exc_info=True)
            return None

    # ── Exit logic ────────────────────────────────────────────────────────────

    def _check_exit(
        self,
        symbol: str,
        curr,
        prev,
        rsi: float,
        close: float,
    ) -> Optional[str]:
        """
        Returns the closing signal (opposite of entry) or None to hold.
        Exits on: take-profit, stop-loss, RSI reversal, or time limit.
        """
        pos       = self._open_positions[symbol]
        side      = pos["signal"]
        entry     = pos["entry_price"]
        opened_at = pos["opened_at"]

        sl_pct = float(self.risk.cfg.stop_loss_pct)
        tp_pct = float(self.risk.cfg.take_profit_pct)

        if side == "SELL":
            pnl_pct = ((entry - close) / entry) * 100  # positive = profit

            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%")
                return "BUY"   # close short by buying back

            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%")
                return "BUY"

            # RSI cooling: short trade worked, RSI retreating from overbought
            if rsi < 58 and curr["rsi"] < prev["rsi"]:
                self._close(symbol, f"RSI retreat to {rsi:.1f}")
                return "BUY"

            # Time limit: 8 × 15m = 2h max hold
            if (datetime.utcnow() - opened_at) > timedelta(hours=2):
                self._close(symbol, "time limit 2h")
                return "BUY"

        elif side == "BUY":
            pnl_pct = ((close - entry) / entry) * 100  # positive = profit

            if pnl_pct >= tp_pct:
                self._close(symbol, f"TP +{pnl_pct:.2f}%")
                return "SELL"

            if pnl_pct <= -sl_pct:
                self._close(symbol, f"SL {pnl_pct:.2f}%")
                return "SELL"

            # RSI overbought: long trade worked, RSI peaking
            if rsi > 62 and curr["rsi"] < prev["rsi"]:
                self._close(symbol, f"RSI peak at {rsi:.1f}")
                return "SELL"

            # Time limit
            if (datetime.utcnow() - opened_at) > timedelta(hours=2):
                self._close(symbol, "time limit 2h")
                return "SELL"

        return None  # hold