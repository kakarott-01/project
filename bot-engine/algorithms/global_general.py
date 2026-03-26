import pandas as pd
import logging
from typing import Optional, Dict

from ta.trend import EMAIndicator, MACD
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands
from algorithms.base_algo import BaseAlgo


class GlobalAlgo(BaseAlgo):

    @property
    def market_type(self) -> str:
        return "global"

    def config_filename(self) -> str:
        return "global_general.json"

    def get_symbols(self) -> list[str]:
        return self.config.get("symbols", ["BTC/USDT"])

    async def generate_signal(self, symbol: str) -> Optional[str]:
        df = await self.connector.fetch_ohlcv(symbol, "1h", limit=250)

        if len(df) < 210:
            return None

        df["ema_fast"] = EMAIndicator(df["close"], window=50).ema_indicator()
        df["ema_slow"] = EMAIndicator(df["close"], window=200).ema_indicator()
        df["rsi"] = RSIIndicator(df["close"], window=14).rsi()

        curr = df.iloc[-1]
        prev = df.iloc[-2]

        if any(pd.isna([curr["ema_fast"], curr["ema_slow"], curr["rsi"]])):
            return None

        bullish = curr["ema_fast"] > curr["ema_slow"]

        if bullish and 40 <= curr["rsi"] <= 55 and curr["rsi"] > prev["rsi"]:
            return "buy"

        if not bullish and 45 <= curr["rsi"] <= 60 and curr["rsi"] < prev["rsi"]:
            return "sell"

        return None