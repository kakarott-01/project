import pandas as pd
import logging
from typing import Optional, Dict

from ta.trend import EMAIndicator, MACD
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands

from algorithms.base_algo import BaseAlgo

class CryptoAlgo(BaseAlgo):

    @property
    def market_type(self) -> str:
        return "crypto"

    def config_filename(self) -> str:
        return "crypto.json"

    def default_config(self) -> Dict:
        return {
            "symbols": ["BTC/USDT", "ETH/USDT"],
            "timeframe": "15m",
            "trend_timeframe": "4h",
        }

    def get_symbols(self) -> list[str]:
        return self.config.get("symbols", ["BTC/USDT"])

    async def generate_signal(self, symbol: str) -> Optional[str]:
        df_trend = await self.connector.fetch_ohlcv(symbol, "4h", limit=250)
        df = await self.connector.fetch_ohlcv(symbol, "15m", limit=100)

        if len(df) < 30 or len(df_trend) < 210:
            return None

        # EMA Trend
        df_trend["ema200"] = EMAIndicator(df_trend["close"], window=200).ema_indicator()
        trend_up = df_trend["close"].iloc[-1] > df_trend["ema200"].iloc[-1]

        # RSI
        df["rsi"] = RSIIndicator(df["close"], window=14).rsi()

        # Bollinger Bands
        bb = BollingerBands(df["close"], window=20, window_dev=2)
        df["bb_lower"] = bb.bollinger_lband()
        df["bb_upper"] = bb.bollinger_hband()

        curr = df.iloc[-1]

        if pd.isna(curr["rsi"]) or pd.isna(curr["bb_lower"]):
            return None

        if trend_up and curr["rsi"] < 30 and curr["close"] <= curr["bb_lower"] * 1.005:
            return "buy"

        if not trend_up and curr["rsi"] > 70 and curr["close"] >= curr["bb_upper"] * 0.995:
            return "sell"

        return None