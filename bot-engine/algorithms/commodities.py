import pandas as pd
import logging
from typing import Optional, Dict

from ta.trend import EMAIndicator, MACD
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands

from datetime import datetime
import pytz
from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)
IST = pytz.timezone("Asia/Kolkata")

class CommoditiesAlgo(BaseAlgo):

    @property
    def market_type(self) -> str:
        return "commodities"

    def config_filename(self) -> str:
        return "commodities.json"

    def default_config(self) -> Dict:
        return {
            "algo_name": "VWAP + MACD Crossover",
            "enabled": True,
            "paper_mode": True,
            "quote_currency": "INR",
            "symbols": ["GOLD", "SILVER", "CRUDEOIL"],
            "timeframe": "15m",
            "indicators": {
                "macd": {"fast": 12, "slow": 26, "signal": 9},
                "vwap": {"enabled": True}
            },
            "trading_hours": {"start": "09:00", "end": "23:25"}
        }

    def get_symbols(self) -> list[str]:
        return self.config.get("symbols", ["GOLD"])

    def _is_trading_time(self) -> bool:
        now = datetime.now(IST).strftime("%H:%M")
        hours = self.config.get("trading_hours", {})
        return hours.get("start", "09:00") <= now <= hours.get("end", "23:25")

    async def generate_signal(self, symbol: str) -> Optional[str]:
        if not self._is_trading_time():
            return None

        df = await self.connector.fetch_ohlcv(symbol, "15m", limit=100)
        if len(df) < 35:
            return None

        # MACD
        macd_obj = MACD(df["close"], window_slow=26, window_fast=12, window_sign=9)
        df["macd"] = macd_obj.macd()
        df["macd_signal"] = macd_obj.macd_signal()
        df["macd_hist"] = macd_obj.macd_diff()

        # VWAP (manual)
        df["vwap"] = (df["close"] * df["volume"]).cumsum() / df["volume"].cumsum()

        curr = df.iloc[-1]
        prev = df.iloc[-2]

        if any(pd.isna([curr["macd"], curr["macd_signal"], curr["vwap"]])):
            return None

        macd_crossed_up = prev["macd"] <= prev["macd_signal"] and curr["macd"] > curr["macd_signal"]
        macd_crossed_down = prev["macd"] >= prev["macd_signal"] and curr["macd"] < curr["macd_signal"]

        if macd_crossed_up and curr["close"] > curr["vwap"] and curr["macd_hist"] > 0:
            return "buy"

        if macd_crossed_down and curr["close"] < curr["vwap"]:
            return "sell"

        return None