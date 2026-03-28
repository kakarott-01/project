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
            return False, True   # square-off time
        if now < "09:20":
            return False, False  # pre-market
        return True, False

    async def generate_signal(self, symbol: str) -> Optional[str]:
        can_trade, square_off = self._is_trading_time()

        if square_off:
            return "SELL"   # force close all at end of day
        if not can_trade:
            return None

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
            return "BUY"
        if cross_down and curr["rsi"] < 50:
            return "SELL"
        return None