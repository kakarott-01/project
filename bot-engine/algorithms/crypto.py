import pandas as pd
import logging
from typing import Optional, Dict

from ta.trend import EMAIndicator
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands, AverageTrueRange

from algorithms.base_algo import BaseAlgo

logger = logging.getLogger(__name__)


class CryptoAlgo(BaseAlgo):

    @property
    def market_type(self) -> str:
        return "crypto"

    def config_filename(self) -> str:
        return "crypto.json"

    def default_config(self) -> Dict:
        return {
            "symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
            "timeframe": "15m",
            "trend_timeframe": "4h",
        }

    def get_symbols(self) -> list[str]:
        return self.config.get("symbols", ["BTC/USDT"])

    async def generate_signal(self, symbol: str) -> Optional[str]:
        try:
            df_trend = await self.connector.fetch_ohlcv(symbol, "4h", limit=250)
            df = await self.connector.fetch_ohlcv(symbol, "15m", limit=100)

            if len(df) < 30 or len(df_trend) < 210:
                return None

            # ───── TREND (4h EMA-200) ─────
            df_trend["ema200"] = EMAIndicator(
                df_trend["close"], window=200
            ).ema_indicator()
            trend_up = df_trend["close"].iloc[-1] > df_trend["ema200"].iloc[-1]

            # ───── RSI (15m) ─────
            df["rsi"] = RSIIndicator(df["close"], window=14).rsi()

            # ───── BOLLINGER BANDS (15m) ─────
            bb = BollingerBands(df["close"], window=20, window_dev=2)
            df["bb_lower"] = bb.bollinger_lband()
            df["bb_upper"] = bb.bollinger_hband()
            df["bb_mid"]   = bb.bollinger_mavg()

            # ───── EMA fast/slow for momentum confirmation ─────
            df["ema9"]  = EMAIndicator(df["close"], window=9).ema_indicator()
            df["ema21"] = EMAIndicator(df["close"], window=21).ema_indicator()

            curr = df.iloc[-1]
            prev = df.iloc[-2]

            if pd.isna(curr["rsi"]) or pd.isna(curr["bb_lower"]) or pd.isna(curr["ema9"]):
                return None

            rsi = curr["rsi"]
            close = curr["close"]

            logger.info(
                f"{symbol} | RSI={rsi:.2f} | Close={close} | "
                f"TrendUp={trend_up} | EMA9={'>' if curr['ema9'] > curr['ema21'] else '<'}EMA21 | "
                f"BB_lower={curr['bb_lower']:.2f} | BB_upper={curr['bb_upper']:.2f}"
            )

            # ─────────────────────────────────────────────────────────────────
            # STRATEGY: Dual-mode — trend-following AND mean-reversion
            # ─────────────────────────────────────────────────────────────────

            # ── MODE 1: Trend-following (when trend is clear) ──
            if trend_up:
                # BUY: RSI pullback to neutral zone, price above BB mid, EMA momentum up
                if 35 <= rsi <= 55 and close > curr["bb_mid"] and curr["ema9"] > curr["ema21"]:
                    logger.info(f"{symbol} → TREND BUY signal (RSI pullback in uptrend)")
                    return "BUY"

            else:  # trend down
                # SELL: RSI bounce to neutral/overbought in downtrend, price below BB mid
                if 45 <= rsi <= 65 and close < curr["bb_mid"] and curr["ema9"] < curr["ema21"]:
                    logger.info(f"{symbol} → TREND SELL signal (RSI bounce in downtrend)")
                    return "SELL"

            # ── MODE 2: Mean-reversion (Bollinger Band touch + RSI extreme) ──
            # Works regardless of trend direction — catches oversold/overbought bounces

            # BUY: Price touches/crosses lower BB, RSI oversold, bouncing
            if (close <= curr["bb_lower"] * 1.005 and  # at or very near lower band
                    rsi < 38 and
                    curr["rsi"] > prev["rsi"]):          # RSI turning up
                logger.info(f"{symbol} → MEAN-REV BUY signal (BB lower + RSI oversold bounce)")
                return "BUY"

            # SELL: Price touches/crosses upper BB, RSI overbought, rolling over
            if (close >= curr["bb_upper"] * 0.995 and  # at or very near upper band
                    rsi > 62 and
                    curr["rsi"] < prev["rsi"]):          # RSI turning down
                logger.info(f"{symbol} → MEAN-REV SELL signal (BB upper + RSI overbought rollover)")
                return "SELL"

            return None

        except Exception as e:
            logger.error(f"❌ Signal generation failed for {symbol}: {e}", exc_info=True)
            return None