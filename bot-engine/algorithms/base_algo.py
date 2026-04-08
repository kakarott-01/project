"""
bot-engine/algorithms/base_algo.py  — v5
==========================================
F3 FIX: _close_trade() now ALWAYS removes symbol from _open_positions,
        even when close_paper_trade/close_live_trade returns False
        (trade already closed by another process).

        PROBLEM: Previously, if closed=False (double-close prevented),
        the symbol remained in _open_positions. Next cycle, generate_signal
        would see the position and call _check_exit again, which queries
        fetch_ticker and attempts another close. This looped indefinitely
        until bot restart, generating noise logs and unnecessary API calls.

        FIX: Pop _open_positions REGARDLESS of the close DB result.
        The DB is the source of truth — if it says the trade is closed,
        our in-memory state must agree.

F9 FIX: _execute_live_trade() now polls fetch_order() after placing
        a live market order to get the ACTUAL filled quantity from the
        exchange. This actual_quantity is passed to save_live_trade()
        so the DB records what was really filled, not what was requested.

        PROBLEM: place_order returns immediately after order submission.
        The requested quantity (e.g., 0.001 BTC) may not fully fill —
        partial fills are common on illiquid markets or during volatility.
        The old code recorded requested_quantity as filled, causing PnL
        calculations and exit logic to be based on incorrect position size.

        FIX: After place_order, call fetch_order() once to get actual
        filled qty. If fetch_order fails (exchange API error), fall back
        to requested quantity with a warning (same as before).

        IMPORTANT: F9 only applies to LIVE trading. Paper trading always
        fills at the full requested quantity (simulated).

All other fixes from v4 unchanged.
"""

import json
import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Tuple
from datetime import datetime, timedelta

from exchange_connector import ExchangeConnector, FatalExecutionError
from fee_calculator import calculate_net_pnl
from risk_manager import GlobalRiskManager, RiskManager

logger = logging.getLogger(__name__)

_config_file_cache: Dict[str, Tuple[float, Dict]] = {}


def _load_config_cached(config_path: str) -> Optional[Dict]:
    try:
        mtime  = os.path.getmtime(config_path)
        cached = _config_file_cache.get(config_path)
        if cached and cached[0] == mtime:
            return cached[1]
        with open(config_path, "r") as f:
            data = json.load(f)
        data.pop("paper_mode", None)
        _config_file_cache[config_path] = (mtime, data)
        logger.debug(f"📄 Config reloaded: {config_path}")
        return data
    except Exception as e:
        logger.error(f"❌ Config load error {config_path}: {e}")
        return None


# F8 FIX: Reconciliation interval reduced from 10 minutes to 2 minutes.
# A 10-minute window was too wide for live trading — a user manually closing
# a position on the exchange would leave the risk manager thinking the
# position is still open for up to 10 minutes, blocking new trades.
RECONCILE_INTERVAL_SEC = 2 * 60   # 2 minutes (was 10 * 60)
FUTURES_MARKETS = {"crypto", "commodities", "global"}
SYMBOL_LOCK_RETRY_DELAYS_SEC = (0.25, 0.5, 1.0)
SYMBOL_LOCK_ACQUIRE_TIMEOUT_SEC = 0.5
TRADE_SLOT_RETRY_DELAYS_SEC = (0.25, 0.5, 1.0)
EMERGENCY_CLOSE_RETRY_DELAYS_SEC = (0.0, 0.75, 1.5)
LIQUIDATION_BUFFER_MULTIPLIER = 1.5
EPSILON = 1e-4
RISK_ROUNDING_PRECISION = 6
RISK_BUDGET_SAFETY_BUFFER = 0.999
MAX_RISK_RESCALE_ATTEMPTS = 3
_ACTIVE_TRADE_LOCKS: Dict[Tuple[str, str, str], asyncio.Lock] = {}


class TradePersistenceError(RuntimeError):
    pass


class ExecutionVerificationError(RuntimeError):
    pass


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except Exception:
        return default


class BaseAlgo(ABC):
    def __init__(
        self,
        connector: ExchangeConnector,
        risk_mgr: RiskManager,
        db,
        user_id: str,
        paper_mode: bool = True,
        session_ref: str = "",
        position_scope_key: str = "default",
        strategy_key: Optional[str] = None,
        execution_mode: str = "SAFE",
        position_mode: str = "NET",
        allow_hedge_opposition: bool = False,
    ):
        self.connector    = connector
        self.risk         = risk_mgr
        self.db           = db
        self.user_id      = user_id
        self._paper_mode  = paper_mode
        self._session_ref = session_ref
        self.position_scope_key = position_scope_key
        self.strategy_key = strategy_key
        self.execution_mode = execution_mode
        self.position_mode = position_mode
        self.allow_hedge_opposition = allow_hedge_opposition
        self.global_risk = GlobalRiskManager({
            "max_total_exposure": getattr(risk_mgr.cfg, "max_total_exposure", 0.0),
            "max_daily_loss": getattr(risk_mgr.cfg, "max_daily_loss", 0.0),
            "max_open_positions": getattr(risk_mgr.cfg, "max_open_positions", 0),
        })
        self._strategy_runtime_config: Dict = {}

        self._reconciled  = False
        self._risk_loaded = False
        self._blocked_symbols: Dict[str, str] = {}
        self._symbols_pending_verification: set[str] = set()
        self._exit_price_overrides: Dict[str, float] = {}

        self.config = self._load_config()
        self.name   = self.config.get("algo_name", self.__class__.__name__)

        logger.info(
            f"✅ [{self.name}] Init user={user_id[:8]}… "
            f"mode={'PAPER' if paper_mode else '🔴 LIVE'} ref={session_ref}"
        )

    def _load_config(self) -> Dict:
        base_dir    = os.path.dirname(__file__)
        config_path = os.path.join(base_dir, "configs", self.config_filename())
        if not os.path.exists(config_path):
            logger.warning(f"⚠️  Config not found: {config_path}, using defaults")
            return self.default_config()
        data = _load_config_cached(config_path)
        return data if data is not None else self.default_config()

    @abstractmethod
    def config_filename(self) -> str: ...
    def default_config(self) -> Dict: return {}
    @abstractmethod
    def get_symbols(self) -> list: ...
    @abstractmethod
    async def generate_signal(self, symbol: str) -> Optional[str]: ...
    @property
    @abstractmethod
    def market_type(self) -> str: ...

    async def _load_risk_state(self):
        if self._risk_loaded:
            return
        self._risk_loaded = True
        await self.risk.load_state(self.db, self.user_id, self.market_type)
        synced_open_count = await self.db.sync_open_trade_count(self.user_id, self.market_type)
        self.risk.open_trade_count = synced_open_count
        await self.risk.persist_state(self.db, self.user_id, self.market_type)

    async def _get_bot_stop_mode(self) -> Optional[str]:
        try:
            return await self.db.get_bot_stop_mode(self.user_id)
        except Exception as e:
            logger.warning(f"[{self.name}] ⚠️  Could not read stop mode: {e}")
            return None

    def _risk_pct_fraction(self) -> float:
        risk_pct = float(self.config.get("risk_pct_per_trade", 1.0)) / 100.0
        if risk_pct <= 0:
            raise ValueError("risk_pct_per_trade must be > 0")
        return risk_pct

    def _symbol_lock_key(self, symbol: str) -> Tuple[str, str, str]:
        return (self.user_id, self.market_type, symbol)

    @asynccontextmanager
    async def _symbol_execution_guard(self, symbol: str):
        lock_key = self._symbol_lock_key(symbol)
        lock = _ACTIVE_TRADE_LOCKS.setdefault(lock_key, asyncio.Lock())
        acquired = False
        try:
            for attempt, delay in enumerate(SYMBOL_LOCK_RETRY_DELAYS_SEC, start=1):
                try:
                    await asyncio.wait_for(lock.acquire(), timeout=SYMBOL_LOCK_ACQUIRE_TIMEOUT_SEC)
                    acquired = True
                    break
                except asyncio.TimeoutError:
                    logger.warning(
                        f"[{self.name}] ⏳ Symbol lock busy for {symbol} (attempt {attempt}/{len(SYMBOL_LOCK_RETRY_DELAYS_SEC)})"
                    )
                    if attempt < len(SYMBOL_LOCK_RETRY_DELAYS_SEC):
                        await asyncio.sleep(delay)
            if not acquired:
                raise ExecutionVerificationError(f"Lock timeout while processing {symbol}")
            yield
        finally:
            if acquired and lock.locked():
                lock.release()
            if not lock.locked():
                _ACTIVE_TRADE_LOCKS.pop(lock_key, None)

    def _calc_price_from_distance(self, entry_price: float, side: str, distance_fraction: float, is_stop: bool) -> float:
        if entry_price <= 0 or distance_fraction <= 0:
            raise ValueError("entry_price and distance_fraction must be positive")
        if hasattr(self, "calc_sl_price") and is_stop:
            return self.calc_sl_price(entry_price, side, distance_fraction)
        if hasattr(self, "calc_tp_price") and not is_stop:
            return self.calc_tp_price(entry_price, side, distance_fraction)
        if side.upper() == "BUY":
            multiplier = 1.0 - distance_fraction if is_stop else 1.0 + distance_fraction
        else:
            multiplier = 1.0 + distance_fraction if is_stop else 1.0 - distance_fraction
        return round(entry_price * multiplier, 8)

    def _estimate_total_loss(
        self,
        entry_price: float,
        stop_price: float,
        quantity: float,
        side: str,
        fee_rate: float,
    ) -> float:
        if side.upper() == "BUY":
            gross_loss = max((entry_price - stop_price) * quantity, 0.0)
        else:
            gross_loss = max((stop_price - entry_price) * quantity, 0.0)
        fees = (entry_price * quantity + stop_price * quantity) * fee_rate
        return gross_loss + fees

    def _round_risk_value(self, value: float) -> float:
        return round(float(value), RISK_ROUNDING_PRECISION)

    def _effective_risk_budget(self, risk_budget: float) -> float:
        return float(risk_budget) * RISK_BUDGET_SAFETY_BUFFER

    def _risk_within_budget(self, total_risk: float, risk_budget: float) -> bool:
        rounded_total_risk = self._round_risk_value(total_risk)
        rounded_budget = self._round_risk_value(risk_budget)
        return rounded_total_risk <= rounded_budget + EPSILON

    def _risk_scale_factor(self, total_risk: float, risk_budget: float) -> float:
        if total_risk <= 0 or risk_budget <= 0:
            raise ValueError("Risk scaling requires positive risk values")
        return min(1.0, float(risk_budget) / float(total_risk))

    def _solve_fee_inclusive_stop_distance(
        self,
        entry_price: float,
        quantity: float,
        side: str,
        risk_amount: float,
        fee_rate: float,
        max_distance: float,
    ) -> float:
        effective_budget = self._effective_risk_budget(risk_amount)
        if max_distance <= 0 or max_distance >= 1:
            raise ValueError("Configured stop-loss percentage is outside safe bounds")
        low = 0.0
        high = max_distance
        for _ in range(60):
            mid = (low + high) / 2.0
            stop_price = self._calc_price_from_distance(entry_price, side, mid, is_stop=True)
            total_loss = self._estimate_total_loss(entry_price, stop_price, quantity, side, fee_rate)
            if self._risk_within_budget(total_loss, effective_budget):
                low = mid
            else:
                high = mid
        if low <= 0:
            raise ValueError("Risk budget is fully consumed by fees; trade rejected")
        return low

    async def _build_fee_checked_level_plan(
        self,
        symbol: str,
        entry_price: float,
        quantity: float,
        leverage: int,
        side: str,
        risk_amount: float,
        fee_rate: float,
    ) -> Dict[str, float]:
        level_plan = self._build_level_plan(
            entry_price,
            quantity,
            leverage,
            side,
            risk_amount,
            fee_rate=fee_rate,
        )
        rounded_stop_loss = await self.connector.round_price_to_market(symbol, float(level_plan["stop_loss"]))
        rounded_take_profit = (
            await self.connector.round_price_to_market(symbol, float(level_plan["take_profit"]))
            if float(level_plan["take_profit"]) > 0
            else 0.0
        )
        level_plan["stop_loss"] = rounded_stop_loss or float(level_plan["stop_loss"])
        level_plan["take_profit"] = rounded_take_profit or float(level_plan["take_profit"])
        level_plan["estimated_total_loss"] = self._estimate_total_loss(
            entry_price,
            level_plan["stop_loss"],
            quantity,
            side,
            fee_rate,
        )
        return level_plan

    def _build_level_plan(
        self,
        entry_price: float,
        quantity: float,
        leverage: int,
        side: str,
        risk_amount: float,
        fee_rate: Optional[float] = None,
    ) -> Dict[str, float]:
        if entry_price <= 0 or quantity <= 0 or leverage <= 0 or risk_amount <= 0:
            raise ValueError("Invalid trade inputs for risk plan")
        actual_notional = entry_price * quantity
        if actual_notional <= 0:
            raise ValueError("Actual notional must be positive")
        fee_rate = float(self.config.get("fee_rate", 0.001) if fee_rate is None else fee_rate)
        if self.market_type == "crypto" or leverage > 1:
            if actual_notional <= risk_amount:
                raise ValueError("Rounded quantity produced notional too small for a defined stop-loss")
            max_distance = risk_amount / actual_notional
            sl_distance = self._solve_fee_inclusive_stop_distance(
                entry_price=entry_price,
                quantity=quantity,
                side=side,
                risk_amount=risk_amount,
                fee_rate=fee_rate,
                max_distance=max_distance,
            )
            tp_pct = float(self.risk.cfg.take_profit_pct or 0.0)
            tp_distance = max(0.0, (tp_pct / 100.0) * sl_distance)
        else:
            configured_distance = float(self.risk.cfg.stop_loss_pct or 0.0) / 100.0
            sl_distance = self._solve_fee_inclusive_stop_distance(
                entry_price=entry_price,
                quantity=quantity,
                side=side,
                risk_amount=risk_amount,
                fee_rate=fee_rate,
                max_distance=configured_distance,
            )
            tp_distance = max(0.0, float(self.risk.cfg.take_profit_pct or 0.0) / 100.0)
        stop_loss = self._calc_price_from_distance(entry_price, side, sl_distance, is_stop=True)
        take_profit = (
            self._calc_price_from_distance(entry_price, side, tp_distance, is_stop=False)
            if tp_distance > 0
            else 0.0
        )
        liquidation_price = (
            self.connector.estimate_liquidation_price(entry_price, side, leverage)
            if self.market_type == "crypto" and leverage > 1
            else None
        )
        return {
            "actual_notional": actual_notional,
            "sl_distance": sl_distance,
            "tp_distance": tp_distance,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "liquidation_price": liquidation_price or 0.0,
            "estimated_total_loss": self._estimate_total_loss(entry_price, stop_loss, quantity, side, fee_rate),
        }

    async def _build_trade_plan(
        self,
        symbol: str,
        side: str,
        balance: float,
        entry_price: float,
        leverage: int,
    ) -> Dict[str, float]:
        if entry_price <= 0:
            raise ValueError("Entry price must be positive")
        if leverage <= 0:
            raise ValueError("Leverage must be positive")
        risk_amount = balance * self._risk_pct_fraction()
        notional = risk_amount * leverage
        fee_rate = float(self.config.get("fee_rate", 0.001))
        raw_quantity = notional / entry_price
        market_constraints = await self.connector.get_market_constraints(symbol, quantity=raw_quantity)
        quantity = float(market_constraints.get("quantity", 0.0))
        min_qty = float(market_constraints.get("min_qty", 0.0))
        min_notional = float(market_constraints.get("min_notional", 0.0))
        if quantity <= 0:
            raise ValueError("Rounded quantity is zero")
        if min_qty > 0 and quantity + 1e-12 < min_qty:
            raise ValueError(f"Quantity {quantity:.8f} is below min lot size {min_qty:.8f}")
        level_plan = await self._build_fee_checked_level_plan(
            symbol=symbol,
            entry_price=entry_price,
            quantity=quantity,
            leverage=leverage,
            side=side,
            risk_amount=risk_amount,
            fee_rate=fee_rate,
        )
        for _ in range(MAX_RISK_RESCALE_ATTEMPTS):
            if self._risk_within_budget(level_plan["estimated_total_loss"], risk_amount):
                break
            scale_factor = self._risk_scale_factor(level_plan["estimated_total_loss"], risk_amount)
            scaled_raw_quantity = quantity * scale_factor
            scaled_constraints = await self.connector.get_market_constraints(symbol, quantity=scaled_raw_quantity)
            scaled_quantity = float(scaled_constraints.get("quantity", 0.0))
            scaled_min_qty = float(scaled_constraints.get("min_qty", min_qty))
            if scaled_quantity >= quantity:
                raise ValueError(
                    f"Fee-inclusive risk exceeds budget for {symbol} and quantity cannot be reduced safely: "
                    f"{level_plan['estimated_total_loss']:.8f} > {risk_amount:.8f}"
                )
            if scaled_quantity <= 0:
                raise ValueError("Scaled quantity is zero")
            if scaled_min_qty > 0 and scaled_quantity + 1e-12 < scaled_min_qty:
                raise ValueError(
                    f"Scaled quantity {scaled_quantity:.8f} is below min lot size {scaled_min_qty:.8f}"
                )
            logger.warning(
                f"[{self.name}] ⚖️  Adjusted size for {symbol} to stay within fee-inclusive risk: "
                f"qty {quantity:.8f} -> {scaled_quantity:.8f} "
                f"(scale={scale_factor:.8f}, risk={level_plan['estimated_total_loss']:.8f}, budget={risk_amount:.8f})"
            )
            raw_quantity = scaled_raw_quantity
            quantity = scaled_quantity
            min_qty = scaled_min_qty
            min_notional = float(scaled_constraints.get("min_notional", min_notional))
            level_plan = await self._build_fee_checked_level_plan(
                symbol=symbol,
                entry_price=entry_price,
                quantity=quantity,
                leverage=leverage,
                side=side,
                risk_amount=risk_amount,
                fee_rate=fee_rate,
            )
        if not self._risk_within_budget(level_plan["estimated_total_loss"], risk_amount):
            raise ValueError(
                f"Fee-inclusive risk exceeds budget for {symbol} after scaling: "
                f"{level_plan['estimated_total_loss']:.8f} > {risk_amount:.8f}"
            )
        actual_notional = float(level_plan["actual_notional"])
        if min_notional > 0 and actual_notional + 1e-8 < min_notional:
            raise ValueError(
                f"Notional {actual_notional:.8f} is below min notional {min_notional:.8f}"
            )
        liquidation_price = level_plan.get("liquidation_price") or None
        if liquidation_price is not None:
            stop_distance_abs = abs(entry_price - level_plan["stop_loss"])
            liq_distance_abs = abs(entry_price - liquidation_price)
            if liq_distance_abs <= (LIQUIDATION_BUFFER_MULTIPLIER * stop_distance_abs) + 1e-8:
                raise ValueError(
                    f"SL too close to liquidation (entry={entry_price:.8f} liq={liquidation_price:.8f} sl={level_plan['stop_loss']:.8f})"
                )
        return {
            "risk_amount": risk_amount,
            "margin_used": risk_amount,
            "requested_notional": raw_quantity * entry_price,
            "raw_quantity": raw_quantity,
            "quantity": quantity,
            "min_qty": min_qty,
            "min_notional": min_notional,
            **level_plan,
            "leverage": float(leverage),
            "entry_price": entry_price,
        }

    def _block_symbol_trading(self, symbol: str, reason: str):
        self._blocked_symbols[symbol] = reason
        logger.error(f"[{self.name}] 🚫 Symbol blocked {symbol}: {reason}")

    def _mark_trade_pending_verification(self, symbol: str):
        self._symbols_pending_verification.add(symbol)
        logger.warning(f"[{self.name}] ⏳ Trade pending verification for {symbol}")

    def _clear_trade_pending_verification(self, symbol: str):
        self._symbols_pending_verification.discard(symbol)

    def _set_exit_price_override(self, symbol: str, price: float):
        if price > 0:
            self._exit_price_overrides[symbol] = price

    async def _activate_kill_switch(self, reason: str):
        await self.db.set_kill_switch_state(
            self.user_id,
            True,
            close_positions=True,
            reason=reason,
        )
        await self.db.set_bot_error_state(self.user_id, reason)

    async def _emergency_flatten_position(
        self,
        symbol: str,
        side: str,
        quantity: float,
        reason: str,
    ) -> Dict:
        last_error: Optional[Exception] = None
        response: Optional[Dict] = None
        for attempt, delay in enumerate(EMERGENCY_CLOSE_RETRY_DELAYS_SEC, start=1):
            if delay > 0:
                await asyncio.sleep(delay)
            try:
                response = await self.connector.emergency_close_position(symbol, side, quantity)
                logger.error(
                    f"[{self.name}] 🚨 Emergency close succeeded for {symbol} on attempt {attempt}"
                )
                return response or {}
            except Exception as exc:
                last_error = exc
                logger.critical(
                    f"[{self.name}] 💀 Emergency close failed for {symbol} "
                    f"(attempt {attempt}/{len(EMERGENCY_CLOSE_RETRY_DELAYS_SEC)}): {exc}"
                )
        kill_reason = f"Emergency close failed for {symbol}: {last_error or reason}"
        await self._activate_kill_switch(kill_reason)
        raise FatalExecutionError(kill_reason)

    async def _reserve_trade_slot_with_retry(self, symbol: str) -> Dict:
        last_result: Optional[Dict] = None
        for attempt, delay in enumerate(TRADE_SLOT_RETRY_DELAYS_SEC, start=1):
            reservation = await self.db.reserve_trade_slot(
                user_id=self.user_id,
                market_type=self.market_type,
                symbol=symbol,
                max_open_trades=int(self.risk.cfg.max_open_trades),
            )
            last_result = reservation
            if reservation.get("reserved"):
                return reservation
            if not reservation.get("lock_timeout"):
                return reservation
            logger.warning(
                f"[{self.name}] ⏳ Trade slot lock timeout for {symbol} "
                f"(attempt {attempt}/{len(TRADE_SLOT_RETRY_DELAYS_SEC)})"
            )
            if attempt < len(TRADE_SLOT_RETRY_DELAYS_SEC):
                await asyncio.sleep(delay)
        return last_result or {
            "reserved": False,
            "lock_timeout": True,
            "duplicate_symbol": False,
            "open_trade_count": self.risk.open_trade_count,
            "reason": f"Lock timeout while reserving trade slot for {symbol}",
        }

    async def _reconstruct_trade_from_exchange(
        self,
        symbol: str,
        exchange_position: Dict,
        stop_orders: List[Dict],
    ) -> bool:
        side = str(exchange_position.get("side") or "").lower()
        quantity = abs(_safe_float(exchange_position.get("quantity")))
        entry_price = _safe_float(exchange_position.get("entry_price"))
        if side not in ("buy", "sell") or quantity <= 0 or entry_price <= 0:
            reason = f"Unable to reconstruct exchange position safely for {symbol}"
            self._block_symbol_trading(symbol, reason)
            await self.db.set_bot_error_state(self.user_id, reason)
            return False

        stop_loss = 0.0
        if self.market_type in FUTURES_MARKETS:
            matching_stop = None
            for order in stop_orders:
                order_side = str(order.get("side") or "").lower()
                if order_side != ("sell" if side == "buy" else "buy"):
                    continue
                stop_loss = _safe_float(self.connector._extract_stop_price(order))
                if stop_loss > 0:
                    matching_stop = order
                    break
            if matching_stop is None:
                await self._emergency_flatten_position(
                    symbol=symbol,
                    side=side,
                    quantity=quantity,
                    reason=f"Untracked exchange position without stop-loss for {symbol}",
                )
                self._block_symbol_trading(symbol, f"Exchange position without stop-loss for {symbol}")
                return False

        metadata = {
            "reconciled_from_exchange": True,
            "reconciled_at": datetime.utcnow().isoformat(),
            "leverage": int(_safe_float(exchange_position.get("leverage"), 1.0) or 1.0),
            "liquidation_price": exchange_position.get("liquidation_price"),
        }
        stop_order_id = matching_stop.get("id") if matching_stop else None
        trade_id = await self.db.save_live_trade(
            user_id=self.user_id,
            symbol=symbol,
            side=side,
            quantity=quantity,
            price=entry_price,
            stop_loss=stop_loss,
            take_profit=0.0,
            order_id=f"reconciled:{symbol}:{int(time.time())}",
            algo_name=self.name,
            market_type=self.market_type,
            session_ref=self._session_ref,
            actual_quantity=quantity,
            exchange_name=self.connector.exchange_name,
            fee_rate=float(self.config.get("fee_rate", 0.001)),
            strategy_key=self.strategy_key,
            position_scope_key=self.position_scope_key,
            metadata=metadata,
            stop_loss_order_id=stop_order_id,
        )
        if trade_id:
            if hasattr(self, "_open_positions"):
                self._open_positions[symbol] = {
                    "signal": side.upper(),
                    "entry_price": entry_price,
                    "opened_at": datetime.utcnow(),
                    "stop_loss": stop_loss if stop_loss > 0 else None,
                    "take_profit": 0.0,
                    "quantity": quantity,
                    "leverage": metadata["leverage"],
                    "confidence": 50.0,
                    "liquidation_price": exchange_position.get("liquidation_price"),
                }
            self.risk.open_trade_count = await self.db.sync_open_trade_count(self.user_id, self.market_type)
            await self.risk.persist_state(self.db, self.user_id, self.market_type)
            logger.warning(f"[{self.name}] ♻️ Reconstructed live trade from exchange for {symbol}")
        return True

    async def _reconcile_symbol_state(self, symbol: str) -> bool:
        if self._paper_mode:
            return True

        db_open = await self.db.get_open_trades_for_symbol(self.user_id, self.market_type, symbol)
        exchange_position = await self.connector.fetch_position_for_symbol(symbol)
        open_orders = await self.connector.fetch_open_orders_checked(symbol)
        stop_orders = [order for order in open_orders if self.connector._extract_stop_price(order) is not None]

        if not db_open and exchange_position is None:
            if not stop_orders:
                return True
            for order in stop_orders:
                order_id = str(order.get("id") or "")
                if not order_id:
                    continue
                try:
                    await self.connector.cancel_order(order_id, symbol)
                except Exception as exc:
                    logger.warning(f"[{self.name}] ⚠️  Could not cancel orphan stop order {order_id} for {symbol}: {exc}")
            reason = f"Cancelled orphan stop orders for flat symbol {symbol}"
            self._block_symbol_trading(symbol, reason)
            await self.db.set_bot_error_state(self.user_id, reason)
            return False

        if not db_open and exchange_position is not None:
            return await self._reconstruct_trade_from_exchange(symbol, exchange_position, stop_orders)

        if db_open and exchange_position is None:
            for trade in db_open:
                await self.db.cancel_orphan_trade(str(trade["id"]))
            self.risk.open_trade_count = await self.db.sync_open_trade_count(self.user_id, self.market_type)
            await self.risk.persist_state(self.db, self.user_id, self.market_type)
            reason = f"DB/exchange mismatch for {symbol}: DB open, exchange flat"
            self._block_symbol_trading(symbol, reason)
            await self.db.set_bot_error_state(self.user_id, reason)
            return False

        if exchange_position is None:
            return True

        db_quantity = sum(
            _safe_float(trade.get("remaining_quantity") or trade.get("quantity"))
            for trade in db_open
        )
        exchange_quantity = _safe_float(exchange_position.get("quantity"))
        quantity_tolerance = max(exchange_quantity * 0.01, 1e-8)
        if abs(db_quantity - exchange_quantity) > quantity_tolerance:
            reason = (
                f"DB/exchange quantity mismatch for {symbol}: "
                f"db={db_quantity:.8f} exchange={exchange_quantity:.8f}"
            )
            self._block_symbol_trading(symbol, reason)
            await self.db.set_bot_error_state(self.user_id, reason)
            return False

        if self.market_type in FUTURES_MARKETS:
            primary_trade = db_open[0]
            stop_loss = _safe_float(primary_trade.get("stop_loss"))
            side = str(primary_trade.get("side") or exchange_position.get("side") or "").lower()
            if stop_loss <= 0 or side not in ("buy", "sell"):
                reason = f"Cannot verify stop-loss protection for {symbol}"
                self._block_symbol_trading(symbol, reason)
                await self.db.set_bot_error_state(self.user_id, reason)
                return False
            if not await self.connector.verify_stop_loss_order(
                symbol=symbol,
                side=side,
                quantity=exchange_quantity,
                stop_loss=stop_loss,
            ):
                try:
                    await self.connector.attach_verified_stop_loss(
                        symbol=symbol,
                        side=side,
                        quantity=exchange_quantity,
                        stop_loss=stop_loss,
                    )
                except Exception as exc:
                    await self._emergency_flatten_position(
                        symbol=symbol,
                        side=side,
                        quantity=exchange_quantity,
                        reason=f"SL missing on exchange for {symbol}: {exc}",
                    )
                    reason = f"SL missing on exchange for {symbol}"
                    self._block_symbol_trading(symbol, reason)
                    return False
        return True

    async def _reconcile_positions(self):
        if self._paper_mode:
            self._reconciled = True
            return
        logger.info(f"[{self.name}] 🔍 Starting startup reconciliation…")
        exchange_symbol_count = 0
        try:
            db_open: List[Dict] = await self.db.get_all_open_trades(
                self.user_id, self.market_type, self.position_scope_key
            )
            owned = (
                [
                    t for t in db_open
                    if t.get("bot_session_ref") == self._session_ref
                       or t.get("bot_session_ref") is None
                ]
                if self._session_ref
                else db_open
            )
            exchange_symbols = set()
            if self.market_type in FUTURES_MARKETS:
                exchange_positions = await self.connector.fetch_positions_checked()
                exchange_symbols |= {
                    p.get("symbol", "")
                    for p in exchange_positions
                    if p.get("symbol")
                }
            exchange_orders = await self.connector.fetch_open_orders_checked()
            exchange_symbols |= {
                o.get("symbol", "")
                for o in exchange_orders
                if o.get("symbol")
            }
            exchange_symbol_count = len(exchange_symbols)
            owned_symbols = {str(trade["symbol"]) for trade in owned}
            untracked_exchange_symbols = {symbol for symbol in exchange_symbols if symbol and symbol not in owned_symbols}
            if untracked_exchange_symbols:
                logger.warning(
                    f"[{self.name}] ♻️ Startup found exchange-only symbols "
                    f"{sorted(untracked_exchange_symbols)}; deferring to strict symbol reconciliation."
                )
            orphaned = 0
            for trade in owned:
                symbol = trade["symbol"]
                if symbol not in exchange_symbols:
                    logger.warning(f"[{self.name}] 🔍 Orphan at startup: {symbol} id={trade['id']}")
                    await self.db.cancel_orphan_trade(trade["id"])
                    if hasattr(self, "_open_positions"):
                        self._open_positions.pop(symbol, None)
                    orphaned += 1
            if orphaned:
                logger.info(f"[{self.name}] Startup reconciled {orphaned} orphan trade(s)")
        except Exception as e:
            logger.error(f"[{self.name}] ❌ Startup reconciliation error: {e}", exc_info=True)
        finally:
            try:
                synced_open_count = await self.db.sync_open_trade_count(self.user_id, self.market_type)
                self.risk.open_trade_count = max(synced_open_count, exchange_symbol_count)
                await self.risk.persist_state(self.db, self.user_id, self.market_type)
            except Exception as sync_exc:
                logger.warning(f"[{self.name}] ⚠️  Could not sync open trade count after reconcile: {sync_exc}")
            self._reconciled = True

    async def _runtime_reconcile(self):
        if self._paper_mode:
            return
        try:
            last_run = await self.db.get_reconciliation_last_run(self.user_id, self.market_type)
            now      = datetime.utcnow()
            if last_run is not None and (now - last_run).total_seconds() < RECONCILE_INTERVAL_SEC:
                return
            logger.info(f"[{self.name}] 🔄 Runtime reconciliation starting…")
            db_open_refs = await self.db.get_open_trade_refs_for_market(
                self.user_id, self.market_type, self.position_scope_key
            )
            if not db_open_refs:
                await self.db.update_reconciliation_log(self.user_id, self.market_type, 0)
                return
            try:
                exchange_symbols = set()
                if self.market_type in FUTURES_MARKETS:
                    exchange_positions = await self.connector.fetch_positions()
                    exchange_symbols |= {
                        p.get("symbol", "")
                        for p in exchange_positions
                        if p.get("symbol")
                    }
                exchange_orders = await self.connector.fetch_open_orders()
                exchange_symbols |= {
                    o.get("symbol", "")
                    for o in exchange_orders
                    if o.get("symbol")
                }
            except Exception as e:
                logger.warning(f"[{self.name}] ⚠️  Exchange reconciliation fetch failed: {e}. Skipping.")
                return
            fixed = 0
            for trade_ref in db_open_refs:
                symbol = trade_ref["symbol"]
                trade_id = trade_ref["id"]
                if symbol not in exchange_symbols:
                    logger.warning(f"[{self.name}] 🔍 Runtime orphan: {symbol} id={trade_id}")
                    was_fixed = await self.db.cancel_orphan_trade(trade_id)
                    if was_fixed:
                        if hasattr(self, "_open_positions"):
                            self._open_positions.pop(symbol, None)
                        self.risk.open_trade_count = max(0, self.risk.open_trade_count - 1)
                        fixed += 1
            if fixed:
                logger.info(f"[{self.name}] Runtime reconciled {fixed} orphan trade(s)")
                await self.risk.persist_state(self.db, self.user_id, self.market_type)
            await self.db.update_reconciliation_log(self.user_id, self.market_type, fixed)
        except Exception as e:
            logger.error(f"[{self.name}] ❌ Runtime reconciliation error: {e}", exc_info=True)

    async def run_cycle(self):
        try:
            await self._run_cycle_inner()
        except Exception as e:
            logger.error(f"[{self.name}] ❌ run_cycle crashed: {e}", exc_info=True)
            try:
                await self.db.update_bot_status(self.user_id, "error", [], error=str(e))
            except Exception:
                pass

    async def _run_cycle_inner(self):
        bot_status = await self.db.get_bot_status(self.user_id)
        if bot_status == "error":
            logger.warning(f"[{self.name}] Bot status is error — skipping cycle")
            return

        if not self._reconciled:
            await self._reconcile_positions()
        if not self._risk_loaded:
            await self._load_risk_state()
        await self.risk.ensure_current_day(self.db, self.user_id, self.market_type)

        self.config = self._load_config()
        self._strategy_runtime_config = await self.db.get_market_strategy_config(self.user_id, self.market_type)
        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config")
            return

        await self._runtime_reconcile()

        global_snapshot = await self.db.get_global_risk_snapshot(self.user_id)
        can_continue, global_reason = self.global_risk.evaluate_trade(global_snapshot, proposed_notional=0.0)
        if not can_continue:
            await self.db.log_risk_event(
                user_id=self.user_id,
                market_type=self.market_type,
                event_type="GLOBAL_RISK_BREACH",
                severity="critical",
                message=global_reason,
                payload=global_snapshot,
            )
            await self.db.update_bot_status(self.user_id, "error", [], error=global_reason)
            logger.error(f"[{self.name}] 🚨 Auto-stop triggered: {global_reason}")
            return

        kill_switch = await self.db.get_kill_switch_state(self.user_id)
        if kill_switch.get("is_active"):
            logger.warning(f"[{self.name}] Kill switch active — skipping cycle")
            return

        stop_mode      = await self._get_bot_stop_mode()
        is_draining    = stop_mode == "graceful"
        is_closing_all = stop_mode == "close_all"

        if is_closing_all:
            logger.info(f"[{self.name}] ⏸  close_all in progress — skipping cycle")
            return

        logger.info(
            f"[{self.name}] 🔄 Cycle "
            f"[{'PAPER' if self._paper_mode else '🔴 LIVE'}]"
            f"{' [DRAINING]' if is_draining else ''}"
        )

        if self._paper_mode:
            balance = await self.db.get_paper_balance(self.user_id)
        else:
            try:
                replay = await self.db.flush_spooled_live_trades(self.user_id, self.market_type)
                if replay["restored"] or replay["remaining"]:
                    logger.info(
                        f"[{self.name}] ♻️  spooled live trade replay "
                        f"restored={replay['restored']} remaining={replay['remaining']}"
                    )
            except Exception as e:
                logger.warning(f"[{self.name}] ⚠️  Could not replay spooled trades: {e}")
            balance = await self.connector.fetch_available_margin(
                self.config.get("quote_currency", "USDT")
            )

        if balance <= 0:
            logger.warning(f"[{self.name}] ⚠️  Zero balance — skipping")
            return

        for symbol in self.get_symbols():
            await self._process_symbol(symbol, balance, is_draining=is_draining, global_snapshot=global_snapshot)

    async def _process_symbol(self, symbol: str, balance: float, is_draining: bool = False, global_snapshot: Optional[Dict] = None):
        slot_reserved = False
        try:
            async with self._symbol_execution_guard(symbol):
                if symbol in self._blocked_symbols:
                    logger.warning(f"[{self.name}] 🚫 {symbol}: blocked from trading ({self._blocked_symbols[symbol]})")
                    return
                if symbol in self._symbols_pending_verification:
                    logger.warning(f"[{self.name}] ⏳ {symbol}: awaiting verification, skipping cycle")
                    return
                if not await self._reconcile_symbol_state(symbol):
                    return

                signal = await self.generate_signal(symbol)
                if not signal:
                    return

                signal = signal.upper()
                is_exit, open_trade_id, open_entry_price, open_side = await self._find_open_trade(symbol)

                if is_exit and open_trade_id:
                    await self._close_trade(symbol, signal, open_trade_id, open_entry_price, open_side, balance)
                    return

                if is_draining:
                    logger.info(f"[{self.name}] 🚿 {symbol}: blocking new entry (drain mode)")
                    return

                stop_mode_now = await self._get_bot_stop_mode()
                if stop_mode_now is not None:
                    logger.info(f"[{self.name}] ⛔ {symbol}: stop mode activated mid-cycle — blocking entry")
                    return

                open_trades_for_symbol = await self.db.get_open_trades_for_symbol(
                    self.user_id, self.market_type, symbol
                )

                if self.position_mode == "NET":
                    opposite_trades = [
                        trade for trade in open_trades_for_symbol
                        if str(trade["position_scope_key"]) != self.position_scope_key
                        and str(trade["side"]).upper() != signal
                    ]
                    if opposite_trades:
                        logger.info(
                            f"[{self.name}] ↔️  NET mode reversing {symbol}: "
                            f"closing {len(opposite_trades)} opposite scoped position(s) first"
                        )
                        for trade in opposite_trades:
                            await self._close_trade(
                                symbol=symbol,
                                exit_signal=signal,
                                trade_id=str(trade["id"]),
                                entry_price=float(trade["entry_price"]),
                                original_side=str(trade["side"]),
                                balance=balance,
                                position_scope_key=str(trade["position_scope_key"]),
                            )
                        return

                if open_trades_for_symbol:
                    if hasattr(self, "_discard_staged_open"):
                        self._discard_staged_open(symbol)
                    logger.info(f"[{self.name}] ⛔ {symbol}: duplicate symbol entry blocked")
                    return

                fresh_price = await self.connector.fetch_fresh_price(symbol)
                price = float(fresh_price.get("price") or 0)
                if price <= 0:
                    if hasattr(self, "_discard_staged_open"):
                        self._discard_staged_open(symbol)
                    logger.warning(f"[{self.name}] ❌ No fresh price for {symbol}")
                    return

                leverage = 1
                staged = getattr(self, "_staged_open", {}).get(symbol, {})
                if staged:
                    leverage = int(staged.get("leverage", 1) or 1)
                trade_plan = await self._build_trade_plan(symbol, signal, balance, price, leverage)
                quantity = float(trade_plan["quantity"])

                runtime_settings = self._resolve_runtime_settings()
                quantity, can_enter, block_reason, block_payload = await self._apply_entry_controls(
                    symbol=symbol,
                    signal=signal,
                    balance=balance,
                    price=price,
                    quantity=quantity,
                    runtime_settings=runtime_settings,
                    trade_plan=trade_plan,
                    global_snapshot=global_snapshot,
                )
                if not can_enter:
                    if hasattr(self, "_discard_staged_open"):
                        self._discard_staged_open(symbol)
                    await self.db.log_blocked_trade(
                        user_id=self.user_id,
                        market_type=self.market_type,
                        symbol=symbol,
                        side=signal,
                        strategy_key=self.strategy_key,
                        position_scope_key=self.position_scope_key,
                        reason_code="ENTRY_BLOCKED",
                        reason_message=block_reason,
                        details=block_payload,
                    )
                    logger.info(f"[{self.name}] ⛔ {symbol}: {block_reason}")
                    return

                strategy_exposure = await self.db.get_open_strategy_exposure(
                    self.user_id, self.market_type, self.strategy_key,
                )
                proposed_notional = float(trade_plan["actual_notional"])
                strategy_capital_pct = ((strategy_exposure + proposed_notional) / balance * 100) if balance > 0 else 0.0
                can_trade, reason = self.risk.can_open_position(
                    balance=balance,
                    position_count_for_symbol=len(open_trades_for_symbol),
                    strategy_capital_pct=strategy_capital_pct,
                    drawdown_pct=max(0.0, abs(self.risk.daily_loss) / balance * 100) if balance > 0 else 0.0,
                )
                if not can_trade:
                    if hasattr(self, "_discard_staged_open"):
                        self._discard_staged_open(symbol)
                    await self.db.log_blocked_trade(
                        user_id=self.user_id,
                        market_type=self.market_type,
                        symbol=symbol,
                        side=signal,
                        strategy_key=self.strategy_key,
                        position_scope_key=self.position_scope_key,
                        reason_code="RISK_LIMIT",
                        reason_message=reason,
                        details={
                            "strategy_capital_pct": strategy_capital_pct,
                            "open_trades_for_symbol": len(open_trades_for_symbol),
                        },
                    )
                    logger.info(f"[{self.name}] ⛔ {symbol}: {reason}")
                    return

                reservation = await self._reserve_trade_slot_with_retry(symbol)
                if not reservation.get("reserved"):
                    if hasattr(self, "_discard_staged_open"):
                        self._discard_staged_open(symbol)
                    await self.db.log_blocked_trade(
                        user_id=self.user_id,
                        market_type=self.market_type,
                        symbol=symbol,
                        side=signal,
                        strategy_key=self.strategy_key,
                        position_scope_key=self.position_scope_key,
                        reason_code="LOCK_TIMEOUT" if reservation.get("lock_timeout") else ("RISK_LIMIT" if not reservation.get("duplicate_symbol") else "DUPLICATE_SYMBOL"),
                        reason_message=str(reservation.get("reason") or "Trade reservation failed"),
                        details=reservation,
                    )
                    logger.info(f"[{self.name}] ⛔ {symbol}: {reservation.get('reason')}")
                    return
                slot_reserved = True
                self.risk.open_trade_count = int(reservation.get("open_trade_count") or self.risk.open_trade_count)

                staged = getattr(self, "_staged_open", {}).get(symbol, {})
                if staged is not None:
                    staged.update({
                        "entry_price": price,
                        "quantity": quantity,
                        "margin_used": trade_plan["margin_used"],
                        "risk_amount": trade_plan["risk_amount"],
                        "notional": trade_plan["actual_notional"],
                        "sl_distance": trade_plan["sl_distance"],
                        "tp_distance": trade_plan["tp_distance"],
                        "stop_loss": trade_plan["stop_loss"],
                        "take_profit": trade_plan["take_profit"],
                        "liquidation_price": trade_plan["liquidation_price"] or None,
                    })

                await self.db.save_signal(self.user_id, self.name, self.market_type, symbol, signal)

                if self._paper_mode:
                    trade_id = await self.db.save_paper_trade(
                        self.user_id, symbol, signal, quantity,
                        price, trade_plan["stop_loss"], trade_plan["take_profit"], self.name, self.market_type,
                        session_ref=self._session_ref,
                        fee_rate=float(self.config.get("fee_rate", 0.001)),
                        strategy_key=self.strategy_key,
                        position_scope_key=self.position_scope_key,
                        metadata=getattr(self, "_staged_open", {}).get(symbol),
                    )
                    if trade_id:
                        if hasattr(self, "_confirm_staged_open"):
                            self._confirm_staged_open(symbol)
                        await self.db.touch_strategy_trade(self.user_id, self.market_type, self.strategy_key)
                        await self.risk.persist_state(self.db, self.user_id, self.market_type)
                        logger.info(f"[{self.name}] 🧪 PAPER OPEN {signal} {quantity:.6f} {symbol} @ {price}")
                    else:
                        if hasattr(self, "_discard_staged_open"):
                            self._discard_staged_open(symbol)
                        self.risk.open_trade_count = await self.db.release_trade_slot(self.user_id, self.market_type)
                else:
                    opened = await self._execute_live_trade(symbol, signal, quantity, price, trade_plan)
                    if not opened:
                        self.risk.open_trade_count = await self.db.release_trade_slot(self.user_id, self.market_type)

                slot_reserved = False
        except Exception as e:
            if slot_reserved and not isinstance(e, TradePersistenceError):
                self.risk.open_trade_count = await self.db.release_trade_slot(self.user_id, self.market_type)
            if hasattr(self, "_discard_staged_open"):
                self._discard_staged_open(symbol)
            logger.error(f"[{self.name}] ❌ Symbol {symbol} error: {e}", exc_info=True)

    async def _find_open_trade(self, symbol: str) -> Tuple:
        try:
            row = await self.db.get_open_trade(
                self.user_id, symbol, self.market_type, self.position_scope_key
            )
            if row:
                return True, row["id"], float(row["entry_price"]), row["side"]
        except Exception as e:
            logger.error(f"❌ find_open_trade error: {e}")
        return False, None, None, None

    async def _close_trade(
        self, symbol: str, exit_signal: str, trade_id: str,
        entry_price: float, original_side: str, balance: float,
        position_scope_key: Optional[str] = None,
    ):
        if hasattr(self, "_open_positions"):
            self._open_positions.pop(symbol, None)

        try:
            open_row = await self.db.get_open_trade(
                self.user_id, symbol, self.market_type, position_scope_key or self.position_scope_key
            )
            if not open_row:
                logger.info(f"[{self.name}] ℹ️  {symbol} already closed in DB, skipping close")
                return

            total_quantity = float(open_row["quantity"])
            remaining_quantity = float(open_row.get("remaining_quantity") or total_quantity)
            cumulative_net_pnl = float(open_row.get("net_pnl") or open_row.get("pnl") or 0)
            fee_rate = float(open_row.get("fee_rate") or self.config.get("fee_rate", 0.001))
            metadata = open_row.get("metadata") or {}

            if self._paper_mode:
                exit_price = float(self._exit_price_overrides.pop(symbol, 0.0) or 0.0)
                if exit_price <= 0:
                    ticker = await self.connector.fetch_ticker(symbol)
                    exit_price = float(ticker.get("last") or 0)
                if not exit_price:
                    logger.warning(f"[{self.name}] ❌ No price to close {symbol}")
                    return

                gross_pnl = (
                    (entry_price - exit_price) * remaining_quantity
                    if original_side.lower() == "sell"
                    else (exit_price - entry_price) * remaining_quantity
                )
                net_pnl, fee_amount = calculate_net_pnl(
                    gross_pnl, entry_price, exit_price, remaining_quantity, fee_rate
                )
                total_net_pnl = cumulative_net_pnl + net_pnl
                pnl_pct = (
                    (total_net_pnl / (entry_price * total_quantity)) * 100
                    if entry_price > 0 and total_quantity > 0
                    else 0
                )
                closed = await self.db.close_paper_trade(
                    trade_id,
                    exit_price,
                    net_pnl,
                    pnl_pct,
                    fee_amount=fee_amount,
                    close_quantity=remaining_quantity,
                )
                if not closed:
                    logger.info(f"[{self.name}] ℹ️  {symbol} close was a no-op (already closed by another process)")
                    return
                logger.info(
                    f"[{self.name}] 🧪 PAPER CLOSE {symbol} entry={entry_price} "
                    f"exit={exit_price} net_PnL={net_pnl:+.4f}"
                )
                final_pnl = total_net_pnl
            else:
                order = await self.connector.place_order(
                    symbol,
                    exit_signal,
                    remaining_quantity,
                    params={"reduceOnly": True},
                )
                order_id = order.get("id", "")
                filled_qty, exit_price, fill_status = await self._fetch_fill_details(
                    order_id, symbol, remaining_quantity, float(order.get("average") or order.get("price") or 0)
                )

                if filled_qty <= 0:
                    logger.error(
                        f"[{self.name}] ❌ Exit order {order_id} for {symbol} not filled "
                        f"(status={fill_status}). Will retry next cycle."
                    )
                    if hasattr(self, "_open_positions"):
                        self._open_positions[symbol] = {
                            "signal": original_side.upper(),
                            "entry_price": entry_price,
                            "opened_at": open_row["opened_at"],
                            "stop_loss": float(open_row["stop_loss"]) if open_row.get("stop_loss") is not None else None,
                            "take_profit": float(open_row["take_profit"]) if open_row.get("take_profit") is not None else None,
                            "leverage": int(metadata.get("leverage", 1)) if isinstance(metadata, dict) else 1,
                            "confidence": float(metadata.get("confidence", 50.0)) if isinstance(metadata, dict) else 50.0,
                        }
                    return

                if not exit_price:
                    ticker = await self.connector.fetch_ticker(symbol)
                    exit_price = float(ticker.get("last") or entry_price)

                gross_pnl = (
                    (entry_price - exit_price) * filled_qty
                    if original_side.lower() == "sell"
                    else (exit_price - entry_price) * filled_qty
                )
                net_pnl, fee_amount = calculate_net_pnl(
                    gross_pnl, entry_price, exit_price, filled_qty, fee_rate
                )
                total_net_pnl = cumulative_net_pnl + net_pnl
                pnl_pct = (
                    (total_net_pnl / (entry_price * total_quantity)) * 100
                    if entry_price > 0 and total_quantity > 0
                    else 0
                )

                if filled_qty + 1e-8 < remaining_quantity:
                    new_remaining = max(remaining_quantity - filled_qty, 0.0)
                    recorded = await self.db.record_partial_close(
                        user_id=self.user_id,
                        trade_id=trade_id,
                        exit_price=exit_price,
                        filled_quantity=filled_qty,
                        remaining_quantity=new_remaining,
                        partial_pnl=net_pnl,
                        pnl_pct=pnl_pct,
                        fee_amount=fee_amount,
                        order_id=order_id,
                    )
                    if recorded and hasattr(self, "_open_positions"):
                        self._open_positions[symbol] = {
                            "signal": original_side.upper(),
                            "entry_price": entry_price,
                            "opened_at": open_row["opened_at"],
                            "stop_loss": float(open_row["stop_loss"]) if open_row.get("stop_loss") is not None else None,
                            "take_profit": float(open_row["take_profit"]) if open_row.get("take_profit") is not None else None,
                            "leverage": int(metadata.get("leverage", 1)) if isinstance(metadata, dict) else 1,
                            "confidence": float(metadata.get("confidence", 50.0)) if isinstance(metadata, dict) else 50.0,
                        }
                    logger.warning(
                        f"[{self.name}] ⚠️  Partial exit fill {symbol}: "
                        f"filled={filled_qty:.8f} remaining={new_remaining:.8f}"
                    )
                    return

                closed = await self.db.close_live_trade(
                    trade_id,
                    exit_price,
                    net_pnl,
                    pnl_pct,
                    order_id,
                    fee_amount=fee_amount,
                    close_quantity=filled_qty,
                )
                if not closed:
                    logger.info(f"[{self.name}] ℹ️  {symbol} live close was a no-op (already closed)")
                    return
                final_pnl = total_net_pnl

            self.risk.record_trade_closed(final_pnl)
            await self.risk.persist_state(self.db, self.user_id, self.market_type)
            await self.db.touch_strategy_trade(self.user_id, self.market_type, self.strategy_key)
            health = await self.db.update_strategy_health(self.user_id, self.market_type, self.strategy_key, final_pnl)
            if health.get("auto_disabled"):
                await self.db.log_risk_event(
                    user_id=self.user_id,
                    market_type=self.market_type,
                    strategy_key=self.strategy_key,
                    event_type="STRATEGY_AUTO_DISABLED",
                    severity="critical",
                    message=health.get("reason") or "Strategy auto-disabled by health monitor.",
                    payload=health,
                )

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Close trade failed {symbol}: {e}", exc_info=True)
            if hasattr(self, "_open_positions"):
                self._open_positions[symbol] = {
                    "signal": original_side.upper(),
                    "entry_price": entry_price,
                    "opened_at": datetime.utcnow(),
                }

    async def _execute_live_trade(
        self,
        symbol: str,
        signal: str,
        quantity: float,
        price: float,
        trade_plan: Dict[str, float],
    ) -> bool:
        leverage = 1
        staged = getattr(self, "_staged_open", {}).get(symbol, {})
        if staged:
            leverage = int(staged.get("leverage", 1) or 1)

        sl = float(trade_plan["stop_loss"])
        tp = float(trade_plan["take_profit"])
        order = None
        try:
            order = await self.connector.place_order_with_leverage(
                symbol,
                signal,
                quantity,
                leverage=leverage,
                stop_loss=sl,
            )
            order_id = order.get("id", "")
            actual_quantity, actual_entry_price, _ = await self._fetch_fill_details(
                order_id, symbol, quantity, float(order.get("average") or order.get("price") or price)
            )
            self._clear_trade_pending_verification(symbol)
            persisted_price = actual_entry_price or price
            if actual_quantity + 1e-8 < quantity:
                logger.warning(
                    f"[{self.name}] ⚠️  Entry partially filled for {symbol}: "
                    f"requested={quantity:.8f} filled={actual_quantity:.8f}"
                )

            if actual_quantity == 0.0:
                if hasattr(self, "_discard_staged_open"):
                    self._discard_staged_open(symbol)
                logger.error(
                    f"[{self.name}] ❌ Live order {order_id} for {symbol} "
                    f"filled 0 units — order was rejected/cancelled. Not recording trade."
                )
                # Save as failed order for visibility
                await self.db.save_failed_live_order(
                    user_id=self.user_id,
                    exchange_name=self.connector.exchange_name,
                    market_type=self.market_type,
                    symbol=symbol,
                    side=signal.lower(),
                    quantity=quantity,
                    entry_price=price,
                    exchange_order_id=order_id,
                    fail_reason="order_filled_zero",
                    cancel_attempted=False,
                    cancel_succeeded=False,
                )
                return False

            actual_trade_plan = self._build_level_plan(
                entry_price=persisted_price,
                quantity=actual_quantity,
                leverage=leverage,
                side=signal,
                risk_amount=float(trade_plan["risk_amount"]),
                fee_rate=float(self.config.get("fee_rate", 0.001)),
            )
            actual_trade_plan["stop_loss"] = (
                await self.connector.round_price_to_market(symbol, float(actual_trade_plan["stop_loss"]))
                or float(actual_trade_plan["stop_loss"])
            )
            actual_trade_plan["take_profit"] = (
                await self.connector.round_price_to_market(symbol, float(actual_trade_plan["take_profit"]))
                if float(actual_trade_plan["take_profit"]) > 0
                else 0.0
            ) or float(actual_trade_plan["take_profit"])
            live_position = await self.connector.fetch_position_for_symbol(symbol)
            actual_liq = (
                _safe_float((live_position or {}).get("liquidation_price"), 0.0)
                or _safe_float(actual_trade_plan.get("liquidation_price"), 0.0)
                or None
            )
            if actual_liq is not None:
                if abs(persisted_price - actual_liq) <= (LIQUIDATION_BUFFER_MULTIPLIER * abs(persisted_price - actual_trade_plan["stop_loss"])) + 1e-8:
                    await self._emergency_flatten_position(
                        symbol=symbol,
                        side=signal,
                        quantity=actual_quantity,
                        reason=f"Unsafe liquidation buffer for {symbol}",
                    )
                    raise FatalExecutionError(
                        f"SL too close to liquidation after fill for {symbol}: entry={persisted_price:.8f} liq={actual_liq:.8f} sl={actual_trade_plan['stop_loss']:.8f}"
                    )

            stop_order_id = order.get("stopLossOrderId")
            provisional_stop_error = order.get("stopLossAttachError")
            stop_tolerance = max(abs(actual_trade_plan["stop_loss"]) * 0.002, 1e-8)
            stop_needs_refresh = (
                provisional_stop_error is not None
                or stop_order_id is None
                or abs(actual_trade_plan["stop_loss"] - sl) > stop_tolerance
            )
            if stop_needs_refresh:
                if stop_order_id:
                    try:
                        await self.connector.cancel_order(stop_order_id, symbol)
                    except Exception as cancel_exc:
                        logger.warning(
                            f"[{self.name}] ⚠️  Could not cancel provisional stop {stop_order_id} for {symbol}: {cancel_exc}"
                        )
                try:
                    refreshed_stop = await self.connector.attach_verified_stop_loss(
                        symbol,
                        signal,
                        actual_quantity,
                        actual_trade_plan["stop_loss"],
                    )
                    order["stopLossOrderId"] = refreshed_stop.get("id")
                except Exception as exc:
                    await self._emergency_flatten_position(
                        symbol=symbol,
                        side=signal,
                        quantity=actual_quantity,
                        reason=f"STOP LOSS ATTACH FAILED for {symbol}: {exc}",
                    )
                    raise FatalExecutionError(f"STOP LOSS ATTACH FAILED for {symbol}: {exc}") from exc
            elif not await self.connector.verify_stop_loss_order(
                symbol,
                signal,
                actual_quantity,
                actual_trade_plan["stop_loss"],
                stop_order_id,
            ):
                await self._emergency_flatten_position(
                    symbol=symbol,
                    side=signal,
                    quantity=actual_quantity,
                    reason=f"STOP LOSS VERIFY FAILED for {symbol}",
                )
                raise FatalExecutionError(f"STOP LOSS VERIFY FAILED for {symbol}")

            if staged is not None:
                staged.update({
                    "entry_price": persisted_price,
                    "quantity": actual_quantity,
                    "margin_used": trade_plan["margin_used"],
                    "risk_amount": trade_plan["risk_amount"],
                    "notional": actual_trade_plan["actual_notional"],
                    "sl_distance": actual_trade_plan["sl_distance"],
                    "tp_distance": actual_trade_plan["tp_distance"],
                    "stop_loss": actual_trade_plan["stop_loss"],
                    "take_profit": actual_trade_plan["take_profit"],
                    "liquidation_price": actual_liq,
                })

            trade_id = await self._persist_live_trade(
                symbol=symbol,
                signal=signal,
                requested_quantity=quantity,
                actual_quantity=actual_quantity,
                price=persisted_price,
                stop_loss=actual_trade_plan["stop_loss"],
                take_profit=actual_trade_plan["take_profit"],
                order_id=order_id,
                stop_loss_order_id=order.get("stopLossOrderId") or None,
            )

            if trade_id:
                if hasattr(self, "_confirm_staged_open"):
                    self._confirm_staged_open(symbol)
                await self.db.touch_strategy_trade(self.user_id, self.market_type, self.strategy_key)
                await self.risk.persist_state(self.db, self.user_id, self.market_type)
                logger.info(
                    f"[{self.name}] ✅ LIVE {signal} requested={quantity:.8f} "
                    f"filled={actual_quantity:.8f} {symbol} order={order_id}"
                )
                return True
            else:
                if hasattr(self, "_discard_staged_open"):
                    self._discard_staged_open(symbol)

                cancel_attempted = True
                cancel_succeeded = False
                cancel_error: Optional[str] = None
                try:
                    await self._emergency_flatten_position(
                        symbol=symbol,
                        side=signal,
                        quantity=actual_quantity,
                        reason=f"duplicate_blocked_emergency_close for {symbol}",
                    )
                    cancel_succeeded = True
                except Exception as cancel_err:
                    cancel_error = str(cancel_err)
                await self.db.save_failed_live_order(
                    user_id=self.user_id,
                    exchange_name=self.connector.exchange_name,
                    market_type=self.market_type,
                    symbol=symbol,
                    side=signal.lower(),
                    quantity=actual_quantity,
                    entry_price=price,
                    exchange_order_id=order_id if order_id else None,
                    fail_reason="duplicate_blocked_emergency_close" if cancel_succeeded else "duplicate_blocked_emergency_close_failed",
                    cancel_attempted=cancel_attempted,
                    cancel_succeeded=cancel_succeeded,
                    cancel_error=cancel_error,
                )

                if not cancel_succeeded:
                    logger.critical(
                        f"[{self.name}] 💀 UNTRACKED LIVE POSITION: {signal} "
                        f"filled={actual_quantity} {symbol} order={order_id}. "
                        "Emergency close failed. MANUAL EXCHANGE ACTION REQUIRED. "
                        "Position recorded in failed_live_orders table."
                    )
                    await self.db.set_bot_error_state(self.user_id, f"Emergency close failed for {symbol}")
                return False
        except TradePersistenceError as e:
            if hasattr(self, "_discard_staged_open"):
                self._discard_staged_open(symbol)
            await self.db.set_bot_error_state(self.user_id, str(e))
            logger.critical(f"[{self.name}] 💀 {e}")
            raise
        except FatalExecutionError as e:
            self._block_symbol_trading(symbol, str(e))
            await self.db.set_bot_error_state(self.user_id, str(e))
            logger.critical(f"[{self.name}] 💀 {e}")
            raise
        except Exception as e:
            logger.error(f"[{self.name}] ❌ Live trade failed {symbol}: {e}", exc_info=True)
            if order is not None:
                order_id = order.get("id")
                if order_id:
                    await self.db.save_failed_live_order(
                        user_id=self.user_id,
                        exchange_name=self.connector.exchange_name,
                        market_type=self.market_type,
                        symbol=symbol,
                        side=signal.lower(),
                        quantity=quantity,
                        entry_price=price,
                        exchange_order_id=order_id,
                        fail_reason=f"exception_after_order: {str(e)[:200]}",
                        cancel_attempted=False,
                        cancel_succeeded=False,
                    )
            raise

    def _resolve_runtime_settings(self) -> Dict:
        strategy_settings = self._strategy_runtime_config.get("strategy_settings", {}) if isinstance(self._strategy_runtime_config, dict) else {}
        if self.strategy_key and self.strategy_key in strategy_settings:
            return strategy_settings[self.strategy_key]
        if strategy_settings:
            first = next(iter(strategy_settings.values()))
            return first
        return {
            "priority": "MEDIUM",
            "cooldown_after_trade_sec": 0,
            "capital_allocation": {"per_trade_percent": 10.0, "max_active_percent": 25.0},
            "health": {"is_auto_disabled": False, "auto_disabled_reason": None, "last_trade_at": None},
        }

    async def _apply_entry_controls(
        self,
        symbol: str,
        signal: str,
        balance: float,
        price: float,
        quantity: float,
        runtime_settings: Dict,
        trade_plan: Dict[str, float],
        ,
        global_snapshot: Optional[Dict] = None,
    ) -> Tuple[float, bool, str, Dict]:
        health = runtime_settings.get("health", {})
        if health.get("is_auto_disabled"):
            return quantity, False, health.get("auto_disabled_reason") or "Strategy is auto-disabled.", {"health": health}

        cooldown_after_trade_sec = int(runtime_settings.get("cooldown_after_trade_sec", 0) or 0)
        last_trade_at = health.get("last_trade_at")
        if last_trade_at and cooldown_after_trade_sec > 0:
            last_dt = last_trade_at if isinstance(last_trade_at, datetime) else datetime.fromisoformat(str(last_trade_at).replace("Z", "+00:00")).replace(tzinfo=None)
            elapsed = (datetime.utcnow() - last_dt).total_seconds()
            if elapsed < cooldown_after_trade_sec:
                return quantity, False, f"Cooldown active for {cooldown_after_trade_sec - elapsed:.0f}s", {"cooldownRemaining": cooldown_after_trade_sec - elapsed}

        if global_snapshot is None:
            global_snapshot = await self.db.get_global_risk_snapshot(self.user_id)

        if self.execution_mode == "AGGRESSIVE" and self.strategy_key:
            capital_allocation = runtime_settings.get("capital_allocation", {})
            per_trade_capital = balance * (float(capital_allocation.get("per_trade_percent", 10.0)) / 100)
            max_active_capital = balance * (float(capital_allocation.get("max_active_percent", 25.0)) / 100)
            strategy_exposure = await self.db.get_open_strategy_exposure(self.user_id, self.market_type, self.strategy_key)
            risk_amount = float(trade_plan["risk_amount"])
            available_capital = max(0.0, balance - float(global_snapshot.get("total_exposure", 0.0)))
            if per_trade_capital + 1e-8 < risk_amount:
                return quantity, False, "Per-trade capital cap is below required risk margin.", {
                    "perTradeCapital": per_trade_capital,
                    "riskAmount": risk_amount,
                }
            if available_capital + 1e-8 < risk_amount:
                return quantity, False, "Available capital is below required risk margin.", {
                    "availableCapital": available_capital,
                    "riskAmount": risk_amount,
                }
            if strategy_exposure + risk_amount > max_active_capital:
                return quantity, False, "Per-strategy active capital limit reached.", {
                    "strategyExposure": strategy_exposure,
                    "maxActiveCapital": max_active_capital,
                    "riskAmount": risk_amount,
                }

            if trade_plan["actual_notional"] > available_capital + 1e-8:
                exposure_snapshot = await self.db.get_exposure_snapshot(self.user_id, self.market_type)
                priorities = self._strategy_runtime_config.get("strategy_settings", {})
                priority_rank = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
                my_rank = priority_rank.get(runtime_settings.get("priority", "MEDIUM"), 2)
                higher_priority_waiting = []
                for other_key, other_cfg in priorities.items():
                    if other_key == self.strategy_key:
                        continue
                    other_rank = priority_rank.get(other_cfg.get("priority", "MEDIUM"), 2)
                    if other_rank <= my_rank:
                        continue
                    used = float(exposure_snapshot.get("per_strategy", {}).get(other_key, 0.0))
                    room = max(0.0, balance * (float(other_cfg.get("capital_allocation", {}).get("max_active_percent", 25.0)) / 100) - used)
                    if room > 0:
                        higher_priority_waiting.append({"strategyKey": other_key, "availableRoom": room})
                if higher_priority_waiting:
                    return quantity, False, "Capital reserved for higher-priority strategy.", {"higherPriority": higher_priority_waiting}
                return quantity, False, "Insufficient available capital.", {"availableCapital": available_capital}

        proposed_notional = quantity * price
        can_trade, reason = self.global_risk.evaluate_trade(global_snapshot, proposed_notional=proposed_notional)
        return quantity, can_trade, reason, {"globalSnapshot": global_snapshot, "proposedNotional": proposed_notional}

    async def _persist_live_trade(
        self,
        symbol: str,
        signal: str,
        requested_quantity: float,
        actual_quantity: float,
        price: float,
        stop_loss: float,
        take_profit: float,
        order_id: str,
        metadata: Optional[dict] = None,
        stop_loss_order_id: Optional[str] = None,
    ) -> Optional[str]:
        import asyncio

        fee_rate = float(self.config.get("fee_rate", 0.001))
        last_error: Optional[Exception] = None

        for attempt in range(3):
            try:
                return await self.db.save_live_trade(
                    self.user_id, symbol, signal, requested_quantity,
                    price, stop_loss, take_profit, order_id,
                    self.name, self.market_type,
                    session_ref=self._session_ref,
                    actual_quantity=actual_quantity,
                    exchange_name=self.connector.exchange_name,
                    fee_rate=fee_rate,
                    strategy_key=self.strategy_key,
                    position_scope_key=self.position_scope_key,
                    metadata=getattr(self, "_staged_open", {}).get(symbol),
                    stop_loss_order_id=stop_loss_order_id,
                )
            except Exception as e:
                last_error = e
                if attempt < 2:
                    wait = 0.5 * (2 ** attempt)
                    logger.warning(
                        f"[{self.name}] Live trade persistence failed for {symbol} "
                        f"(attempt {attempt + 1}/3): {e}. Retrying in {wait:.1f}s."
                    )
                    await asyncio.sleep(wait)

        payload = {
            "user_id": self.user_id,
            "symbol": symbol,
            "side": signal.lower(),
            "requested_quantity": requested_quantity,
            "actual_quantity": actual_quantity,
            "entry_price": price,
            "stop_loss": stop_loss,
            "take_profit": take_profit,
            "order_id": order_id,
            "algo_name": self.name,
            "strategy_key": self.strategy_key,
            "position_scope_key": self.position_scope_key,
            "market_type": self.market_type,
            "metadata": metadata,
            "session_ref": self._session_ref,
            "exchange_name": self.connector.exchange_name,
            "fee_rate": fee_rate,
            "stop_loss_order_id": stop_loss_order_id,
            "retry_count": 0,
            "last_error": str(last_error)[:300] if last_error else "unknown",
            "spooled_at": datetime.utcnow().isoformat(),
        }
        await self.db.spool_live_trade(payload)
        raise TradePersistenceError(
            f"Live order executed for {symbol} but DB persistence failed. "
            "Trade has been spooled for recovery and the bot was moved to error state."
        )

    async def _fetch_fill_details(
        self, order_id: str, symbol: str, requested_qty: float, fallback_price: float
    ) -> Tuple[float, float, str]:
        if not order_id:
            self._mark_trade_pending_verification(symbol)
            actual_position = await self.connector.fetch_position_for_symbol(symbol)
            if actual_position:
                self._clear_trade_pending_verification(symbol)
                return actual_position["quantity"], actual_position["entry_price"] or fallback_price, "verified"
            self._block_symbol_trading(symbol, "Order status unknown (missing order id)")
            raise ExecutionVerificationError(f"Order status unknown for {symbol}: missing order id")

        import asyncio

        poll_delays = [1.0, 2.0, 2.0]
        for poll, delay in enumerate(poll_delays):
            if poll > 0:
                await asyncio.sleep(delay)
            try:
                order_info  = await self.connector.fetch_order(order_id, symbol)
                exch_status = str(order_info.get("status", "unknown")).lower()
                filled_qty  = float(order_info.get("filled", 0) or 0)
                avg_price = float(order_info.get("average") or order_info.get("price") or fallback_price or 0)

                if exch_status in ("closed", "filled"):
                    return filled_qty, avg_price, "filled"

                if exch_status in ("canceled", "cancelled", "rejected", "expired"):
                    logger.warning(
                        f"[{self.name}] Order {order_id} {exch_status}. "
                        f"filled_qty={filled_qty:.8f}"
                    )
                    return filled_qty, avg_price, exch_status

                if exch_status in ("open", "partially_filled", "partial"):
                    continue

                if filled_qty > 0:
                    return filled_qty, avg_price, "partial"

            except Exception as e:
                logger.warning(f"[{self.name}] fetch_order failed for {order_id}: {e}")
                break

        self._mark_trade_pending_verification(symbol)
        actual_position = await self.connector.fetch_position_for_symbol(symbol)
        if actual_position:
            self._clear_trade_pending_verification(symbol)
            return actual_position["quantity"], actual_position["entry_price"] or fallback_price, "verified"
        self._block_symbol_trading(symbol, f"Order status unknown for {symbol}")
        raise ExecutionVerificationError(
            f"Order status unknown for {symbol}: no verifiable exchange position after {sum(poll_delays):.0f}s"
        )
