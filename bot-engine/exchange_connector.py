"""
bot-engine/exchange_connector.py — v4
========================================
Changes from v3:
  - Added set_leverage(symbol, leverage) for futures exchanges (BingX etc.)
  - Added set_margin_mode(symbol, mode) to enforce isolated margin
  - place_order_with_leverage() helper that calls margin + leverage setup
    BEFORE placing any crypto futures order
  - Leverage helpers are no-ops for spot exchanges (guarded by try/except)
  - All other logic from v3 preserved.

IMPORTANT: For BingX futures:
  1. set_margin_mode(symbol, "isolated") must be called first
  2. set_leverage(symbol, leverage) must be called second
  3. Then place the order

Both calls are idempotent on the exchange side (safe to call repeatedly).
"""

import ccxt.async_support as ccxt
import pandas as pd
import logging
import time
import asyncio
from typing import Optional, Dict, List, Tuple
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)


class FatalExecutionError(RuntimeError):
    pass

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

# ── OHLCV cache (unchanged from v3) ──────────────────────────────────────────
_ohlcv_cache: Dict[Tuple[str, str, str], Tuple[float, pd.DataFrame]] = {}
OHLCV_CACHE_TTL_BY_MARKET = {
    "indian":       55,
    "crypto":      150,
    "commodities": 110,
    "global":      110,
}
OHLCV_CACHE_TTL_DEFAULT = 55
MAX_CACHE_ENTRIES = 200
OHLCV_PAGE_LIMIT = 1000
STOP_LOSS_ATTACH_RETRIES = 3
STOP_LOSS_ATTACH_BACKOFF_SEC = 0.75


def _cache_key(exchange_name: str, symbol: str, timeframe: str) -> Tuple[str, str, str]:
    return (exchange_name, symbol, timeframe)


def _get_cached_ohlcv(
    exchange_name: str, symbol: str, timeframe: str, market_type: str
) -> Optional[pd.DataFrame]:
    key   = _cache_key(exchange_name, symbol, timeframe)
    entry = _ohlcv_cache.get(key)
    ttl   = OHLCV_CACHE_TTL_BY_MARKET.get(market_type, OHLCV_CACHE_TTL_DEFAULT)
    if entry and (time.time() - entry[0]) < ttl:
        logger.debug("🎯 OHLCV cache HIT  %s %s", symbol, timeframe)
        return entry[1]
    return None


def _set_cached_ohlcv(
    exchange_name: str, symbol: str, timeframe: str, df: pd.DataFrame
) -> None:
    key = _cache_key(exchange_name, symbol, timeframe)
    now = time.time()
    ttl = OHLCV_CACHE_TTL_BY_MARKET.get("crypto", OHLCV_CACHE_TTL_DEFAULT)
    if len(_ohlcv_cache) >= MAX_CACHE_ENTRIES:
        stale_keys = [k for k, (ts, _) in _ohlcv_cache.items() if now - ts > ttl]
        for k in stale_keys:
            del _ohlcv_cache[k]
        if len(_ohlcv_cache) >= MAX_CACHE_ENTRIES:
            oldest_key = min(_ohlcv_cache, key=lambda k: _ohlcv_cache[k][0])
            del _ohlcv_cache[oldest_key]
    _ohlcv_cache[key] = (now, df)


def clear_ohlcv_cache() -> None:
    _ohlcv_cache.clear()
    logger.info("🧹 OHLCV cache cleared")


def _timeframe_to_millis(timeframe: str) -> int:
    unit  = timeframe[-1]
    value = int(timeframe[:-1])
    if unit == "m":
        return value * 60 * 1000
    if unit == "h":
        return value * 60 * 60 * 1000
    if unit == "d":
        return value * 24 * 60 * 60 * 1000
    raise ValueError(f"Unsupported timeframe: {timeframe}")


def _normalize_key(key: object) -> str:
    return str(key).strip().lower().replace("_", "").replace("-", "")


def _collect_numeric_values(payload, wanted_keys: set[str], found: List[Tuple[str, float]], prefix: str = "") -> None:
    if isinstance(payload, dict):
        for key, value in payload.items():
            key_name = f"{prefix}.{key}" if prefix else str(key)
            normalized = _normalize_key(key)
            if normalized in wanted_keys:
                try:
                    found.append((key_name, float(value)))
                except Exception:
                    pass
            _collect_numeric_values(value, wanted_keys, found, key_name)
    elif isinstance(payload, list):
        for idx, value in enumerate(payload):
            child_prefix = f"{prefix}[{idx}]" if prefix else f"[{idx}]"
            _collect_numeric_values(value, wanted_keys, found, child_prefix)


# =============================================================================
# ExchangeConnector
# =============================================================================

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
                f"Exchange '{exchange_name}' (ccxt id: '{ccxt_id}') is not supported."
            )

        self._ccxt_id = ccxt_id
        self._options = (
            {"defaultType": "swap"}
            if market_type in FUTURES_MARKETS
            else {"defaultType": "spot"}
        )
        logger.info(
            "🔌 ExchangeConnector configured: %s mode=%s market=%s",
            ccxt_id, self._options["defaultType"], market_type,
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
            except Exception as exc:
                logger.warning("⚠️  exchange.close() error (non-fatal): %s", exc)

    # ── OHLCV (unchanged) ─────────────────────────────────────────────────────

    async def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = "15m",
        limit: int = 100,
        since_ms: Optional[int] = None,
    ) -> pd.DataFrame:
        async with self._exchange() as ex:
            try:
                requested_limit = max(int(limit), 1)
                page_limit = min(requested_limit, OHLCV_PAGE_LIMIT)
                cursor = since_ms
                raw: List[List[float]] = []

                while len(raw) < requested_limit:
                    batch = await ex.fetch_ohlcv(
                        symbol, timeframe,
                        since=cursor,
                        limit=min(page_limit, requested_limit - len(raw)),
                    )
                    if not batch:
                        break
                    if raw:
                        last_ts = raw[-1][0]
                        batch = [r for r in batch if r[0] > last_ts]
                        if not batch:
                            break
                    raw.extend(batch)
                    if len(batch) < page_limit:
                        break
                    if cursor is None:
                        break
                    next_cursor = int(batch[-1][0]) + _timeframe_to_millis(timeframe)
                    if next_cursor <= cursor:
                        break
                    cursor = next_cursor

                if not raw:
                    raise ValueError(f"Empty OHLCV for {symbol}")

                df = pd.DataFrame(
                    raw,
                    columns=["timestamp", "open", "high", "low", "close", "volume"],
                )
                df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
                df.set_index("timestamp", inplace=True)
                return df.astype(float)

            except Exception as exc:
                logger.error("❌ OHLCV fetch failed %s: %s", symbol, exc, exc_info=True)
                raise

    async def fetch_ohlcv_cached(
        self,
        symbol: str,
        timeframe: str = "15m",
        limit: int = 100,
    ) -> pd.DataFrame:
        cached = _get_cached_ohlcv(self.exchange_name, symbol, timeframe, self.market_type)
        if cached is not None:
            return cached
        logger.debug("⬇️  OHLCV cache MISS %s %s — fetching", symbol, timeframe)
        df = await self.fetch_ohlcv(symbol, timeframe, limit)
        _set_cached_ohlcv(self.exchange_name, symbol, timeframe, df)
        return df

    # ── Balance ───────────────────────────────────────────────────────────────

    async def get_balance(self, currency: str = "USDT") -> float:
        async with self._exchange() as ex:
            try:
                balance = await ex.fetch_balance()
                value   = float(balance.get("free", {}).get(currency, 0))
                logger.info("💰 Balance %s: %s", currency, value)
                return value
            except Exception as exc:
                logger.error("❌ Balance fetch failed: %s", exc, exc_info=True)
                raise

    async def fetch_available_margin(self, currency: str = "USDT") -> float:
        async with self._exchange() as ex:
            try:
                balance = await ex.fetch_balance()
                if self.market_type not in FUTURES_MARKETS:
                    value = float(balance.get("free", {}).get(currency, 0) or 0)
                    logger.info("💰 Available balance %s: %s", currency, value)
                    return value

                margin_keys = {
                    "availablemargin",
                    "availablebalance",
                    "availablefunds",
                    "withdrawavailable",
                    "freemargin",
                }
                margin_candidates: List[Tuple[str, float]] = []
                _collect_numeric_values(balance, margin_keys, margin_candidates)
                for source, value in margin_candidates:
                    if value >= 0:
                        logger.info("💰 Available margin %s: %s (source=%s)", currency, value, source)
                        return value

                raise FatalExecutionError(
                    f"Unable to determine available margin safely for {self.exchange_name}:{currency}"
                )
            except FatalExecutionError:
                raise
            except Exception as exc:
                logger.error("❌ Available margin fetch failed: %s", exc, exc_info=True)
                raise

    async def fetch_ticker(self, symbol: str) -> Dict:
        async with self._exchange() as ex:
            try:
                return await ex.fetch_ticker(symbol)
            except Exception as exc:
                logger.error("❌ Ticker fetch failed %s: %s", symbol, exc, exc_info=True)
                raise

    async def fetch_latest_close(self, symbol: str, timeframe: str = "1m") -> Optional[float]:
        cached = _get_cached_ohlcv(self.exchange_name, symbol, timeframe, self.market_type)
        if cached is not None and not cached.empty:
            price = float(cached["close"].iloc[-1])
            return price
        try:
            ticker = await self.fetch_ticker(symbol)
            return float(ticker.get("last", 0)) or None
        except Exception:
            return None

    async def fetch_fresh_price(self, symbol: str, max_age_seconds: int = 45) -> Dict[str, Optional[float]]:
        ticker = await self.fetch_ticker(symbol)
        price = float(ticker.get("last") or 0)
        timestamp_ms = ticker.get("timestamp")
        if timestamp_ms:
            age_seconds = max(0.0, (time.time() * 1000 - float(timestamp_ms)) / 1000.0)
            if price > 0 and age_seconds <= max_age_seconds:
                return {"price": price, "timestamp_ms": float(timestamp_ms), "age_seconds": age_seconds}

        df = await self.fetch_ohlcv(symbol, "1m", limit=2)
        if df.empty:
            return {"price": None, "timestamp_ms": None, "age_seconds": None}
        candle_ts = df.index[-1].to_pydatetime().timestamp() * 1000
        candle_price = float(df["close"].iloc[-1] or 0)
        age_seconds = max(0.0, (time.time() * 1000 - candle_ts) / 1000.0)
        if candle_price <= 0 or age_seconds > max_age_seconds:
            return {"price": None, "timestamp_ms": candle_ts, "age_seconds": age_seconds}
        return {"price": candle_price, "timestamp_ms": candle_ts, "age_seconds": age_seconds}

    async def get_market_constraints(
        self,
        symbol: str,
        quantity: Optional[float] = None,
        price: Optional[float] = None,
    ) -> Dict[str, float]:
        async with self._exchange() as ex:
            try:
                await ex.load_markets()
                market = ex.market(symbol)
                min_qty = float((((market.get("limits") or {}).get("amount") or {}).get("min")) or 0.0)
                min_notional = float((((market.get("limits") or {}).get("cost") or {}).get("min")) or 0.0)
                result = {
                    "min_qty": min_qty,
                    "min_notional": min_notional,
                }
                if quantity is not None:
                    result["quantity"] = float(ex.amount_to_precision(symbol, quantity))
                if price is not None:
                    result["price"] = float(ex.price_to_precision(symbol, price))
                return result
            except Exception as exc:
                logger.warning("⚠️  Market constraints lookup failed for %s: %s", symbol, exc)
                result = {
                    "min_qty": 0.0,
                    "min_notional": 0.0,
                }
                if quantity is not None:
                    result["quantity"] = round(quantity, 8)
                if price is not None:
                    result["price"] = round(price, 8)
                return result

    async def round_quantity_to_market(self, symbol: str, quantity: float) -> Tuple[float, float]:
        if quantity <= 0:
            return 0.0, 0.0
        constraints = await self.get_market_constraints(symbol, quantity=quantity)
        return float(constraints.get("quantity", 0.0)), float(constraints.get("min_qty", 0.0))

    async def round_price_to_market(self, symbol: str, price: float) -> float:
        if price <= 0:
            return 0.0
        constraints = await self.get_market_constraints(symbol, price=price)
        return float(constraints.get("price", 0.0))

    async def fetch_position_for_symbol(self, symbol: str) -> Optional[Dict]:
        positions = await self.fetch_positions(symbol)
        for position in positions:
            if position.get("symbol") != symbol:
                continue
            qty_raw = position.get("contracts")
            if qty_raw is None:
                qty_raw = position.get("size")
            if qty_raw is None:
                qty_raw = position.get("amount")
            quantity = abs(float(qty_raw or 0))
            if quantity <= 0:
                continue
            side = str(position.get("side") or "").lower()
            if side not in ("buy", "sell"):
                try:
                    raw_signed_qty = float(qty_raw or 0)
                    side = "buy" if raw_signed_qty > 0 else "sell"
                except Exception:
                    side = ""
            entry_price = float(
                position.get("entryPrice")
                or position.get("average")
                or position.get("avgPrice")
                or position.get("markPrice")
                or 0
            )
            liquidation_price = position.get("liquidationPrice")
            return {
                "symbol": symbol,
                "quantity": quantity,
                "side": side,
                "entry_price": entry_price,
                "liquidation_price": float(liquidation_price) if liquidation_price not in (None, "") else None,
                "leverage": float(position.get("leverage") or 0) if position.get("leverage") not in (None, "") else None,
                "raw": position,
            }
        return None

    async def fetch_position_for_symbol_checked(self, symbol: str) -> Optional[Dict]:
        """
        Same as `fetch_position_for_symbol` but uses the checked positions
        API so that caller sees exchange errors instead of silent
        fallbacks. Raises when the underlying positions fetch fails.
        """
        positions = await self.fetch_positions_checked(symbol)
        for position in positions:
            if position.get("symbol") != symbol:
                continue
            qty_raw = position.get("contracts")
            if qty_raw is None:
                qty_raw = position.get("size")
            if qty_raw is None:
                qty_raw = position.get("amount")
            try:
                quantity = abs(float(qty_raw or 0))
            except Exception:
                continue
            if quantity <= 0:
                continue
            side = str(position.get("side") or "").lower()
            if side not in ("buy", "sell"):
                try:
                    raw_signed_qty = float(qty_raw or 0)
                    side = "buy" if raw_signed_qty > 0 else "sell"
                except Exception:
                    side = ""
            entry_price = float(
                position.get("entryPrice")
                or position.get("average")
                or position.get("avgPrice")
                or position.get("markPrice")
                or 0
            )
            liquidation_price = position.get("liquidationPrice")
            return {
                "symbol": symbol,
                "quantity": quantity,
                "side": side,
                "entry_price": entry_price,
                "liquidation_price": float(liquidation_price) if liquidation_price not in (None, "") else None,
                "leverage": float(position.get("leverage") or 0) if position.get("leverage") not in (None, "") else None,
                "raw": position,
            }
        return None

    def estimate_liquidation_price(
        self,
        entry_price: float,
        side: str,
        leverage: int,
        maintenance_margin_rate: float = 0.005,
    ) -> Optional[float]:
        if entry_price <= 0 or leverage <= 0:
            return None
        liquidation_distance = max((1.0 / leverage) - maintenance_margin_rate, 0.0)
        if side.lower() == "buy":
            return round(entry_price * (1.0 - liquidation_distance), 8)
        return round(entry_price * (1.0 + liquidation_distance), 8)

    # ── Leverage management (NEW — Parts 4 / 10) ─────────────────────────────

    async def set_margin_mode(self, symbol: str, mode: str = "isolated") -> bool:
        """
        Set margin mode for a futures symbol.

        mode: "isolated" | "cross"
        Always use "isolated" for safety (limits loss to deposited margin).

        Returns True on success, False if the exchange doesn't support it
        (e.g. spot exchanges — safe no-op).

        NOTE: Must be called BEFORE set_leverage and place_order for
        any new crypto position.
        """
        if self.market_type not in FUTURES_MARKETS:
            return True  # spot — no-op

        async with self._exchange() as ex:
            try:
                if hasattr(ex, "set_margin_mode"):
                    await ex.set_margin_mode(mode, symbol)
                    logger.info("🔒 Margin mode set to %s for %s", mode, symbol)
                    return True
                else:
                    logger.debug("⚠️  Exchange %s does not support set_margin_mode — skipping", self.exchange_name)
                    return True
            except ccxt.ExchangeError as exc:
                # Margin mode already set correctly is often returned as an error by BingX
                if "already" in str(exc).lower() or "no need" in str(exc).lower():
                    logger.debug("🔒 Margin mode already %s for %s", mode, symbol)
                    return True
                logger.warning("⚠️  set_margin_mode failed for %s: %s (non-fatal)", symbol, exc)
                return False
            except Exception as exc:
                logger.warning("⚠️  set_margin_mode error for %s: %s (non-fatal)", symbol, exc)
                return False

    async def set_leverage(self, symbol: str, leverage: int) -> bool:
        """
        Set leverage for a futures symbol.

        Always called after set_margin_mode and before place_order.
        Returns True on success, False if unsupported (safe no-op for spot).

        BingX requires: margin mode set → leverage set → place order.
        """
        if self.market_type not in FUTURES_MARKETS:
            return True  # spot — no-op

        if leverage < 1 or leverage > 125:
            logger.warning("⚠️  Invalid leverage %d for %s — clamping to [1, 125]", leverage, symbol)
            leverage = max(1, min(125, leverage))

        async with self._exchange() as ex:
            try:
                if hasattr(ex, "set_leverage"):
                    await ex.set_leverage(leverage, symbol)
                    logger.info("⚡ Leverage set to %d× for %s", leverage, symbol)
                    return True
                else:
                    logger.debug("⚠️  Exchange %s does not support set_leverage — skipping", self.exchange_name)
                    return True
            except ccxt.ExchangeError as exc:
                if "already" in str(exc).lower():
                    logger.debug("⚡ Leverage already %d× for %s", leverage, symbol)
                    return True
                logger.warning("⚠️  set_leverage failed for %s (%d×): %s", symbol, leverage, exc)
                return False
            except Exception as exc:
                logger.warning("⚠️  set_leverage error for %s (%d×): %s", symbol, leverage, exc)
                return False

    async def setup_futures_position(self, symbol: str, leverage: int) -> bool:
        """
        Convenience helper: sets isolated margin + leverage in the correct order.
        Call this before every new crypto futures order.

        Returns True if both steps succeeded (or were no-ops for spot).
        """
        margin_ok   = await self.set_margin_mode(symbol, "isolated")
        leverage_ok = await self.set_leverage(symbol, leverage)
        if not (margin_ok and leverage_ok):
            logger.warning(
                "⚠️  futures setup incomplete for %s lev=%d× "
                "(margin_ok=%s leverage_ok=%s) — proceeding with caution",
                symbol, leverage, margin_ok, leverage_ok,
            )
        return margin_ok and leverage_ok

    # ── Order placement (leverage-aware) ─────────────────────────────────────

    async def place_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        order_type: str = "market",
        price: Optional[float] = None,
        params: Optional[Dict] = None,
    ) -> Dict:
        """
        Place a market or limit order.
        For futures markets, leverage must already be configured via
        setup_futures_position() before calling this method.
        """
        async with self._exchange() as ex:
            try:
                side = side.lower()
                logger.info("📤 Placing %s %s %s @ qty=%.8f", order_type, side, symbol, quantity)
                if order_type == "market":
                    order = await ex.create_order(symbol, "market", side, quantity, None, params or {})
                else:
                    order = await ex.create_order(symbol, "limit", side, quantity, price, params or {})
                logger.info("✅ Order placed: id=%s", order.get("id"))
                return order
            except Exception as exc:
                logger.error("❌ Order failed %s: %s", symbol, exc, exc_info=True)
                raise

    async def _attach_stop_loss_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        stop_loss: float,
    ) -> Dict:
        """Place a separate stop-loss order for a futures position."""
        stop_side = "sell" if side.lower() == "buy" else "buy"
        params = {"stopPrice": stop_loss, "reduceOnly": True}

        async with self._exchange() as ex:
            for order_type in ("stop_market", "stop"):
                try:
                    order = await ex.create_order(symbol, order_type, stop_side, quantity, None, params)
                    logger.info("🛡️  Stop-loss attached: %s %s @ %.8f", symbol, order_type, stop_loss)
                    return order
                except Exception as exc:
                    logger.debug(
                        "⚠️  Stop loss order type %s failed for %s: %s",
                        order_type, symbol, exc,
                    )
            raise RuntimeError(
                f"Unable to attach stop-loss order for {symbol} at {stop_loss}"
            )

    def _extract_stop_price(self, order: Dict) -> Optional[float]:
        candidates = [
            order.get("stopPrice"),
            order.get("triggerPrice"),
            (order.get("info") or {}).get("stopPrice"),
            (order.get("info") or {}).get("triggerPrice"),
            (order.get("params") or {}).get("stopPrice"),
        ]
        for candidate in candidates:
            if candidate in (None, ""):
                continue
            try:
                return float(candidate)
            except Exception:
                continue
        return None

    async def verify_stop_loss_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        stop_loss: float,
        order_id: Optional[str] = None,
    ) -> bool:
        return await self.find_matching_stop_loss_order(
            symbol=symbol,
            side=side,
            quantity=quantity,
            stop_loss=stop_loss,
            order_id=order_id,
        ) is not None

    async def find_matching_stop_loss_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        stop_loss: float,
        order_id: Optional[str] = None,
    ) -> Optional[Dict]:
        reverse_side = "sell" if side.lower() == "buy" else "buy"
        tolerance = max(stop_loss * 0.002, 1e-8)
        if order_id:
            try:
                order = await self.fetch_order(order_id, symbol)
                stop_price = self._extract_stop_price(order)
                order_side = str(order.get("side", "")).lower()
                if stop_price is not None and order_side == reverse_side and abs(stop_price - stop_loss) <= tolerance:
                    return order
            except Exception:
                pass

        open_orders = await self.fetch_open_orders_checked(symbol)
        for order in open_orders:
            order_side = str(order.get("side", "")).lower()
            stop_price = self._extract_stop_price(order)
            if order_side != reverse_side or stop_price is None:
                continue
            try:
                order_qty = abs(float(order.get("amount") or order.get("remaining") or quantity))
            except Exception:
                order_qty = quantity
            if order_qty + 1e-8 < quantity:
                continue
            if abs(stop_price - stop_loss) <= tolerance:
                return order
        return None

    async def attach_verified_stop_loss(
        self,
        symbol: str,
        side: str,
        quantity: float,
        stop_loss: float,
        retries: int = 3,
    ) -> Dict:
        last_error: Optional[Exception] = None
        existing = await self.find_matching_stop_loss_order(symbol, side, quantity, stop_loss)
        if existing is not None:
            return existing
        for attempt in range(1, retries + 1):
            try:
                order = await self._attach_stop_loss_order(symbol, side, quantity, stop_loss)
                if await self.verify_stop_loss_order(symbol, side, quantity, stop_loss, order.get("id")):
                    return order
                last_error = RuntimeError(
                    f"Stop-loss verification failed on attempt {attempt} for {symbol} @ {stop_loss}"
                )
            except Exception as exc:
                last_error = exc
            logger.warning(
                "⚠️  Stop-loss attach/verify attempt %d/%d failed for %s: %s",
                attempt, retries, symbol, last_error,
            )
            if attempt < retries:
                await asyncio.sleep(STOP_LOSS_ATTACH_BACKOFF_SEC * (2 ** (attempt - 1)))
        raise FatalExecutionError(str(last_error) if last_error else f"Stop-loss attach failed for {symbol}")

    async def emergency_close_position(self, symbol: str, side: str, quantity: float) -> Optional[Dict]:
        if quantity <= 0:
            return None
        close_side = "sell" if side.lower() == "buy" else "buy"
        logger.error("🚨 Emergency reduce-only close for %s qty=%.8f", symbol, quantity)
        return await self.place_order(
            symbol,
            close_side,
            quantity,
            params={"reduceOnly": True},
        )

    async def place_order_with_leverage(
        self,
        symbol: str,
        side: str,
        quantity: float,
        leverage: int = 1,
        order_type: str = "market",
        price: Optional[float] = None,
        stop_loss: Optional[float] = None,
        params: Optional[Dict] = None,
    ) -> Dict:
        """
        Full crypto futures order flow:
          1. set_margin_mode(symbol, "isolated")
          2. set_leverage(symbol, leverage)
          3. place_order(symbol, side, quantity)
          4. attach a stop-loss order if requested.

        For non-futures markets: falls through to plain place_order.
        """
        if self.market_type in FUTURES_MARKETS:
            if not await self.setup_futures_position(symbol, leverage):
                raise RuntimeError(
                    f"Futures setup failed for {symbol} at leverage {leverage}×"
                )

        order = await self.place_order(symbol, side, quantity, order_type, price, params=params)

        if self.market_type in FUTURES_MARKETS and stop_loss is not None:
            try:
                stop_order = await self.attach_verified_stop_loss(symbol, side, quantity, stop_loss)
                order["stopLossOrderId"] = stop_order.get("id")
            except Exception as exc:
                order["stopLossAttachError"] = str(exc)
                logger.error("❌ Stop-loss attach failed for %s after entry order: %s", symbol, exc)

        return order

    # ── Fetch order (unchanged) ───────────────────────────────────────────────

    async def fetch_order(self, order_id: str, symbol: str) -> Dict:
        async with self._exchange() as ex:
            try:
                order = await ex.fetch_order(order_id, symbol)
                logger.debug(
                    "📋 fetch_order %s: status=%s filled=%s remaining=%s",
                    order_id, order.get("status"), order.get("filled"), order.get("remaining"),
                )
                return order
            except Exception as exc:
                logger.error("❌ fetch_order failed %s %s: %s", order_id, symbol, exc, exc_info=True)
                raise

    async def fetch_open_orders(self, symbol: Optional[str] = None) -> List[Dict]:
        async with self._exchange() as ex:
            try:
                return await ex.fetch_open_orders(symbol)
            except Exception as exc:
                logger.error("❌ Fetch open orders failed: %s", exc, exc_info=True)
                return []

    async def fetch_open_orders_checked(self, symbol: Optional[str] = None) -> List[Dict]:
        async with self._exchange() as ex:
            try:
                return await ex.fetch_open_orders(symbol)
            except Exception as exc:
                logger.error("❌ Fetch open orders failed: %s", exc, exc_info=True)
                raise

    async def fetch_positions(self, symbol: Optional[str] = None) -> List[Dict]:
        async with self._exchange() as ex:
            try:
                if not ex.has.get("fetchPositions"):
                    return []
                positions = await ex.fetch_positions([symbol] if symbol else None)
                open_positions = []
                for position in positions:
                    contracts = position.get("contracts")
                    size      = position.get("size")
                    amount    = position.get("amount")
                    qty = contracts if contracts is not None else size if size is not None else amount
                    try:
                        if abs(float(qty or 0)) > 0:
                            open_positions.append(position)
                    except Exception:
                        continue
                return open_positions
            except Exception as exc:
                logger.warning("⚠️  fetch_positions failed: %s", exc)
                return []

    async def fetch_positions_checked(self, symbol: Optional[str] = None) -> List[Dict]:
        async with self._exchange() as ex:
            try:
                if not ex.has.get("fetchPositions"):
                    return []
                return await ex.fetch_positions([symbol] if symbol else None)
            except Exception as exc:
                logger.error("❌ fetch_positions failed: %s", exc, exc_info=True)
                raise

    async def cancel_order(self, order_id: str, symbol: str) -> Dict:
        async with self._exchange() as ex:
            try:
                return await ex.cancel_order(order_id, symbol)
            except Exception as exc:
                logger.error("❌ Cancel order failed: %s", exc, exc_info=True)
                raise
