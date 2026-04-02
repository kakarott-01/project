"""
bot-engine/exchange_connector.py — v3
========================================
Added: fetch_order() method required by F5 (close_all fill confirmation)
       and F9 (entry fill quantity verification).

fetch_order(order_id, symbol) → Dict
  Returns the full order object from the exchange including:
    - status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired' | etc.
    - filled: quantity actually filled (float)
    - remaining: quantity still unfilled (float)
    - amount: original requested quantity (float)

All other logic unchanged from v2.
"""

import ccxt.async_support as ccxt
import pandas as pd
import logging
import time
from typing import Optional, Dict, List, Tuple
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

# ── OHLCV cache ───────────────────────────────────────────────────────────────
_ohlcv_cache: Dict[Tuple[str, str, str], Tuple[float, pd.DataFrame]] = {}
OHLCV_CACHE_TTL   = 30
MAX_CACHE_ENTRIES = 200


def _cache_key(exchange_name: str, symbol: str, timeframe: str) -> Tuple[str, str, str]:
    return (exchange_name, symbol, timeframe)


def _get_cached_ohlcv(
    exchange_name: str, symbol: str, timeframe: str
) -> Optional[pd.DataFrame]:
    key   = _cache_key(exchange_name, symbol, timeframe)
    entry = _ohlcv_cache.get(key)
    if entry and (time.time() - entry[0]) < OHLCV_CACHE_TTL:
        logger.debug(f"🎯 OHLCV cache HIT  {symbol} {timeframe}")
        return entry[1]
    return None


def _set_cached_ohlcv(
    exchange_name: str, symbol: str, timeframe: str, df: pd.DataFrame
) -> None:
    key = _cache_key(exchange_name, symbol, timeframe)
    now = time.time()
    if len(_ohlcv_cache) >= MAX_CACHE_ENTRIES:
        stale_keys = [
            k for k, (ts, _) in _ohlcv_cache.items()
            if now - ts > OHLCV_CACHE_TTL
        ]
        for k in stale_keys:
            del _ohlcv_cache[k]
        if len(_ohlcv_cache) >= MAX_CACHE_ENTRIES:
            oldest_key = min(_ohlcv_cache, key=lambda k: _ohlcv_cache[k][0])
            del _ohlcv_cache[oldest_key]
            logger.debug(f"🗑️  OHLCV cache evicted oldest entry (cache full)")
    _ohlcv_cache[key] = (now, df)


def clear_ohlcv_cache() -> None:
    _ohlcv_cache.clear()
    logger.info("🧹 OHLCV cache cleared")


class ExchangeConnector:
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

    async def fetch_ohlcv_cached(
        self,
        symbol: str,
        timeframe: str = "15m",
        limit: int = 100,
    ) -> pd.DataFrame:
        cached = _get_cached_ohlcv(self.exchange_name, symbol, timeframe)
        if cached is not None:
            return cached
        logger.debug(f"⬇️  OHLCV cache MISS {symbol} {timeframe} — fetching")
        df = await self.fetch_ohlcv(symbol, timeframe, limit)
        _set_cached_ohlcv(self.exchange_name, symbol, timeframe, df)
        return df

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

    async def fetch_latest_close(self, symbol: str, timeframe: str = "1m") -> Optional[float]:
        cached = _get_cached_ohlcv(self.exchange_name, symbol, timeframe)
        if cached is not None and not cached.empty:
            price = float(cached["close"].iloc[-1])
            logger.debug(f"💲 Using cached close for {symbol}: {price}")
            return price
        try:
            ticker = await self.fetch_ticker(symbol)
            return float(ticker.get("last", 0)) or None
        except Exception:
            return None

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

    async def fetch_order(self, order_id: str, symbol: str) -> Dict:
        """
        NEW (required by F5 and F9): Fetch a specific order by ID.

        Returns the full ccxt order object including:
          - status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired'
          - filled: quantity actually filled (float)
          - remaining: quantity not yet filled (float)
          - amount: original requested quantity (float)
          - average: average fill price (float, may be None)

        Raises on exchange API error — callers must handle exceptions.
        """
        async with self._exchange() as ex:
            try:
                order = await ex.fetch_order(order_id, symbol)
                logger.debug(
                    f"📋 fetch_order {order_id}: status={order.get('status')} "
                    f"filled={order.get('filled')} remaining={order.get('remaining')}"
                )
                return order
            except Exception as e:
                logger.error(f"❌ fetch_order failed {order_id} {symbol}: {e}", exc_info=True)
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