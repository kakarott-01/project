"""
bot-engine/exchange_connector.py
=================================
Production exchange connector.

KEY CHANGE: Every public method acquires a fresh exchange instance,
uses it inside try/finally, and ALWAYS calls .close() before returning.
This guarantees zero unclosed aiohttp sessions regardless of exceptions.

The connector itself is stateless — it just holds config.
"""

import ccxt.async_support as ccxt
import pandas as pd
import logging
from typing import Optional, Dict, List
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)

EXCHANGE_MAP = {
    "bingx":       "bingx",
    "coindcx":     "coindcx",
    "coinswitch":  "coinswitch",
    "delta":       "delta",
    "deltaexch":   "delta",
    "binance":     "binance",
    "kraken":      "kraken",
    "ibkr":        "ibkr",
}

FUTURES_MARKETS = {"crypto", "commodities", "global"}
SPOT_MARKETS    = {"indian"}


class ExchangeConnector:
    """
    Stateless config holder.  Call methods that need exchange access —
    each one creates, uses, and closes the ccxt instance internally.
    """

    def __init__(
        self,
        exchange_name: str,
        api_key: str,
        api_secret: str,
        extra: Optional[Dict] = None,
        market_type: str = "crypto",
    ):
        self.exchange_name = exchange_name.lower()
        self.api_key       = api_key
        self.api_secret    = api_secret
        self.extra         = extra or {}
        self.market_type   = market_type

        if not api_key or not api_secret:
            raise ValueError("❌ API keys missing in ExchangeConnector")

        # Verify the exchange ID is valid at construction time
        ccxt_id = EXCHANGE_MAP.get(self.exchange_name, self.exchange_name)
        if not getattr(ccxt, ccxt_id, None):
            raise ValueError(
                f"Exchange '{exchange_name}' (ccxt id: '{ccxt_id}') is not supported. "
                "For Zerodha/Dhan/Upstox/Fyers you need their proprietary SDK."
            )

        self._ccxt_id = ccxt_id
        self._options = (
            {"defaultType": "swap"}
            if market_type in FUTURES_MARKETS
            else {"defaultType": "spot"}
        )
        logger.info(
            f"🔌 ExchangeConnector configured: {ccxt_id} "
            f"mode={self._options['defaultType']} market={market_type}"
        )

    @asynccontextmanager
    async def _exchange(self):
        """
        Context manager that creates a ccxt exchange, yields it,
        and ALWAYS closes it — even on exception.
        This is the only place ccxt instances are created.
        """
        ExClass  = getattr(ccxt, self._ccxt_id)
        exchange = ExClass({
            "apiKey":          self.api_key,
            "secret":          self.api_secret,
            "enableRateLimit": True,
            "options":         self._options,
            **self.extra,
        })
        try:
            yield exchange
        finally:
            try:
                await exchange.close()
            except Exception as e:
                logger.warning(f"⚠️  exchange.close() error (non-fatal): {e}")

    # ── Public API ─────────────────────────────────────────────────────────────

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = "15m",
        limit: int = 100,
    ) -> pd.DataFrame:
        async with self._exchange() as ex:
            try:
                raw = await ex.fetch_ohlcv(symbol, timeframe, limit=limit)
                if not raw:
                    raise ValueError(f"Empty OHLCV for {symbol}")
                df = pd.DataFrame(
                    raw,
                    columns=["timestamp", "open", "high", "low", "close", "volume"],
                )
                df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
                df.set_index("timestamp", inplace=True)
                return df.astype(float)
            except Exception as e:
                logger.error(f"❌ OHLCV fetch failed {symbol}: {e}", exc_info=True)
                raise

    async def get_balance(self, currency: str = "USDT") -> float:
        async with self._exchange() as ex:
            try:
                balance = await ex.fetch_balance()
                value   = float(balance.get("free", {}).get(currency, 0))
                logger.info(f"💰 Balance {currency}: {value}")
                return value
            except Exception as e:
                logger.error(f"❌ Balance fetch failed: {e}", exc_info=True)
                raise

    async def fetch_ticker(self, symbol: str) -> Dict:
        async with self._exchange() as ex:
            try:
                return await ex.fetch_ticker(symbol)
            except Exception as e:
                logger.error(f"❌ Ticker fetch failed {symbol}: {e}", exc_info=True)
                raise

    async def place_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        order_type: str = "market",
        price: Optional[float] = None,
    ) -> Dict:
        async with self._exchange() as ex:
            try:
                side = side.lower()
                logger.info(f"📤 Placing {order_type} {side} {quantity} {symbol}")
                if order_type == "market":
                    order = await ex.create_order(symbol, "market", side, quantity)
                else:
                    order = await ex.create_order(symbol, "limit", side, quantity, price)
                logger.info(f"✅ Order placed: id={order.get('id')}")
                return order
            except Exception as e:
                logger.error(f"❌ Order failed {symbol}: {e}", exc_info=True)
                raise

    async def fetch_open_orders(self, symbol: Optional[str] = None) -> List[Dict]:
        async with self._exchange() as ex:
            try:
                return await ex.fetch_open_orders(symbol)
            except Exception as e:
                logger.error(f"❌ Fetch open orders failed: {e}", exc_info=True)
                return []

    async def cancel_order(self, order_id: str, symbol: str) -> Dict:
        async with self._exchange() as ex:
            try:
                return await ex.cancel_order(order_id, symbol)
            except Exception as e:
                logger.error(f"❌ Cancel order failed: {e}", exc_info=True)
                raise