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
import logging
import os
import time
from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Tuple
from datetime import datetime, timedelta

from exchange_connector import ExchangeConnector
from risk_manager import RiskManager

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


class BaseAlgo(ABC):
    def __init__(
        self,
        connector: ExchangeConnector,
        risk_mgr: RiskManager,
        db,
        user_id: str,
        paper_mode: bool = True,
        session_ref: str = "",
    ):
        self.connector    = connector
        self.risk         = risk_mgr
        self.db           = db
        self.user_id      = user_id
        self._paper_mode  = paper_mode
        self._session_ref = session_ref

        self._reconciled  = False
        self._risk_loaded = False

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

    async def _get_bot_stop_mode(self) -> Optional[str]:
        try:
            return await self.db.get_bot_stop_mode(self.user_id)
        except Exception as e:
            logger.warning(f"[{self.name}] ⚠️  Could not read stop mode: {e}")
            return None

    async def _reconcile_positions(self):
        if self._paper_mode:
            self._reconciled = True
            return
        logger.info(f"[{self.name}] 🔍 Starting startup reconciliation…")
        try:
            db_open: List[Dict] = await self.db.get_all_open_trades(self.user_id, self.market_type)
            if not db_open:
                self._reconciled = True
                return
            owned = (
                [
                    t for t in db_open
                    if t.get("bot_session_ref") == self._session_ref
                       or t.get("bot_session_ref") is None
                ]
                if self._session_ref
                else db_open
            )
            if not owned:
                self._reconciled = True
                return
            try:
                exchange_orders  = await self.connector.fetch_open_orders()
                exchange_symbols = {o.get("symbol", "") for o in exchange_orders}
            except Exception as e:
                logger.warning(f"[{self.name}] ⚠️  Exchange order fetch failed during reconcile: {e}. Skipping.")
                self._reconciled = True
                return
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
            db_open_map = await self.db.get_open_symbols_for_market(self.user_id, self.market_type)
            if not db_open_map:
                await self.db.update_reconciliation_log(self.user_id, self.market_type, 0)
                return
            try:
                exchange_orders  = await self.connector.fetch_open_orders()
                exchange_symbols = {o.get("symbol", "") for o in exchange_orders}
            except Exception as e:
                logger.warning(f"[{self.name}] ⚠️  Exchange fetch_open_orders failed: {e}. Skipping.")
                return
            fixed = 0
            for symbol, trade_id in db_open_map.items():
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
        if not self._reconciled:
            await self._reconcile_positions()
        if not self._risk_loaded:
            await self._load_risk_state()

        self.config = self._load_config()
        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config")
            return

        await self._runtime_reconcile()

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
            balance = 10_000.0
        else:
            balance = await self.connector.get_balance(self.config.get("quote_currency", "USDT"))

        if balance <= 0:
            logger.warning(f"[{self.name}] ⚠️  Zero balance — skipping")
            return

        for symbol in self.get_symbols():
            await self._process_symbol(symbol, balance, is_draining=is_draining)

    async def _process_symbol(self, symbol: str, balance: float, is_draining: bool = False):
        try:
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

            can_trade, reason = self.risk.can_trade(balance)
            if not can_trade:
                logger.info(f"[{self.name}] ⛔ {symbol}: {reason}")
                return

            await self.db.save_signal(self.user_id, self.name, self.market_type, symbol, signal)

            ticker = await self.connector.fetch_ticker(symbol)
            price  = ticker.get("last")
            if not price:
                logger.warning(f"[{self.name}] ❌ No price for {symbol}")
                return

            quantity = self.risk.calculate_position_size(balance, price)
            if quantity <= 0:
                logger.warning(f"[{self.name}] ❌ Invalid qty for {symbol}")
                return

            if self._paper_mode:
                trade_id = await self.db.save_paper_trade(
                    self.user_id, symbol, signal, quantity,
                    price, self.name, self.market_type,
                    session_ref=self._session_ref,
                )
                if trade_id:
                    if hasattr(self, "_confirm_staged_open"):
                        self._confirm_staged_open(symbol)
                    self.risk.record_trade_opened()
                    await self.risk.persist_state(self.db, self.user_id, self.market_type)
                    logger.info(f"[{self.name}] 🧪 PAPER OPEN {signal} {quantity:.6f} {symbol} @ {price}")
                else:
                    if hasattr(self, "_discard_staged_open"):
                        self._discard_staged_open(symbol)
            else:
                await self._execute_live_trade(symbol, signal, quantity, price)

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Symbol {symbol} error: {e}", exc_info=True)

    async def _find_open_trade(self, symbol: str) -> Tuple:
        try:
            row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if row:
                return True, row["id"], float(row["entry_price"]), row["side"]
        except Exception as e:
            logger.error(f"❌ find_open_trade error: {e}")
        return False, None, None, None

    async def _close_trade(
        self, symbol: str, exit_signal: str, trade_id: str,
        entry_price: float, original_side: str, balance: float,
    ):
        """
        F3 FIX: _open_positions is always cleaned up, regardless of whether
        the DB close succeeds. This prevents infinite exit-retry loops.

        Previous bug: if closed=False (trade already closed by another process
        or concurrent call), the symbol stayed in _open_positions. Next cycle
        would detect the position, call _check_exit, fetch ticker, attempt
        close again → returned False again → infinite loop until restart.

        Fix: Always pop _open_positions at the point we know the trade should
        be closed. The DB WHERE status='open' guard prevents actual double-closes.
        """
        # F3 FIX: Pop _open_positions FIRST, before any async operations.
        # If anything after this raises, the in-memory state is still correct.
        if hasattr(self, "_open_positions"):
            self._open_positions.pop(symbol, None)

        try:
            ticker     = await self.connector.fetch_ticker(symbol)
            exit_price = ticker.get("last")
            if not exit_price:
                logger.warning(f"[{self.name}] ❌ No price to close {symbol}")
                return

            # Verify the trade is still open in DB before attempting close
            # (guards against race with close_all_engine or another cycle)
            open_row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if not open_row:
                # Already closed by another process — _open_positions already cleaned up above
                logger.info(f"[{self.name}] ℹ️  {symbol} already closed in DB, skipping close")
                return

            quantity = float(open_row["quantity"])
            if original_side.lower() == "sell":
                pnl = (entry_price - exit_price) * quantity
            else:
                pnl = (exit_price - entry_price) * quantity
            pnl_pct = (pnl / (entry_price * quantity)) * 100 if entry_price > 0 else 0

            if self._paper_mode:
                closed = await self.db.close_paper_trade(trade_id, exit_price, pnl, pnl_pct)
                # F3 FIX: No position cleanup here — already done above.
                # closed=False means another process closed it — that's fine.
                if not closed:
                    logger.info(f"[{self.name}] ℹ️  {symbol} close was a no-op (already closed by another process)")
                    return
                logger.info(
                    f"[{self.name}] 🧪 PAPER CLOSE {symbol} entry={entry_price} exit={exit_price} PnL={pnl:+.4f}"
                )
            else:
                order  = await self.connector.place_order(symbol, exit_signal, quantity)
                closed = await self.db.close_live_trade(trade_id, exit_price, pnl, pnl_pct, order.get("id", ""))
                if not closed:
                    logger.info(f"[{self.name}] ℹ️  {symbol} live close was a no-op (already closed)")
                    return

            self.risk.record_trade_closed(pnl)
            await self.risk.persist_state(self.db, self.user_id, self.market_type)

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Close trade failed {symbol}: {e}", exc_info=True)
            # F3 FIX: _open_positions was already cleaned up before the try block.
            # Even on exception, in-memory state is correct. Bot won't retry
            # the exit loop. The DB record remains open until reconciliation.

    async def _execute_live_trade(self, symbol: str, signal: str, quantity: float, price: float):
        """
        F9 FIX: After placing the order, call fetch_order() to get the actual
        filled quantity from the exchange. Pass actual_quantity to save_live_trade()
        so the DB records reality, not the request.

        PARTIAL FILL BEHAVIOR:
          - If actual_qty < requested_qty: trade saved with actual_qty.
            On next exit, close_trade uses open_row["quantity"] (actual_qty).
            PnL calculation uses the correct filled position size.
          - If fetch_order fails: fall back to requested_qty with warning.
          - If actual_qty = 0 (order rejected): discard staged open, save
            failed order record, don't create trade in DB.
        """
        sl    = self.risk.calculate_stop_loss(price, signal)
        tp    = self.risk.calculate_take_profit(price, signal)
        order = None
        try:
            order    = await self.connector.place_order(symbol, signal, quantity)
            order_id = order.get("id", "")

            # F9 FIX: Fetch actual fill quantity from exchange
            actual_quantity = await self._fetch_actual_fill(order_id, symbol, quantity)

            if actual_quantity == 0.0:
                # Order placed but nothing filled (rejected or cancelled immediately)
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
                return

            trade_id = await self.db.save_live_trade(
                self.user_id, symbol, signal, quantity,
                price, sl, tp, order_id,
                self.name, self.market_type,
                session_ref=self._session_ref,
                actual_quantity=actual_quantity,  # F9: pass actual fill
            )

            if trade_id:
                if hasattr(self, "_confirm_staged_open"):
                    self._confirm_staged_open(symbol)
                self.risk.record_trade_opened()
                await self.risk.persist_state(self.db, self.user_id, self.market_type)
                logger.info(
                    f"[{self.name}] ✅ LIVE {signal} requested={quantity:.8f} "
                    f"filled={actual_quantity:.8f} {symbol} order={order_id}"
                )
            else:
                # DB rejected duplicate — attempt cancel
                if hasattr(self, "_discard_staged_open"):
                    self._discard_staged_open(symbol)

                cancel_attempted  = False
                cancel_succeeded  = False
                cancel_error: Optional[str] = None

                if order_id:
                    cancel_attempted = True
                    logger.error(
                        f"[{self.name}] ❌ CRITICAL: Live order placed ({order_id}) but "
                        f"DB rejected duplicate for {symbol}. Attempting to cancel order…"
                    )
                    try:
                        await self.connector.cancel_order(order_id, symbol)
                        cancel_succeeded = True
                        logger.info(f"[{self.name}] ✅ Order {order_id} cancelled successfully")
                    except Exception as cancel_err:
                        cancel_error = str(cancel_err)
                        logger.error(
                            f"[{self.name}] ❌ Cancel failed for order {order_id}: {cancel_err}. "
                            "Recording for manual review."
                        )

                fail_reason = (
                    "duplicate_blocked_cancel_ok" if cancel_succeeded
                    else "duplicate_blocked_cancel_failed" if cancel_attempted
                    else "duplicate_blocked_no_order_id"
                )
                await self.db.save_failed_live_order(
                    user_id=self.user_id,
                    exchange_name=self.connector.exchange_name,
                    market_type=self.market_type,
                    symbol=symbol,
                    side=signal.lower(),
                    quantity=actual_quantity,
                    entry_price=price,
                    exchange_order_id=order_id if order_id else None,
                    fail_reason=fail_reason,
                    cancel_attempted=cancel_attempted,
                    cancel_succeeded=cancel_succeeded,
                    cancel_error=cancel_error,
                )

                if not cancel_succeeded and cancel_attempted:
                    logger.critical(
                        f"[{self.name}] 💀 UNTRACKED LIVE POSITION: {signal} "
                        f"filled={actual_quantity} {symbol} order={order_id}. "
                        "Cancel failed. MANUAL EXCHANGE ACTION REQUIRED. "
                        "Position recorded in failed_live_orders table."
                    )

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

    async def _fetch_actual_fill(
        self, order_id: str, symbol: str, requested_qty: float
    ) -> float:
        """
        F9: Fetch actual filled quantity for a just-placed order.

        Polls fetch_order() up to 3 times (3 second intervals) waiting for
        the order to settle. Market orders on liquid pairs typically fill
        within 1 second, so 3 polls is generous.

        Returns:
          - Actual filled quantity (may be less than requested_qty for partial fills)
          - 0.0 if order was cancelled/rejected
          - requested_qty if fetch_order fails (fallback, with warning)
        """
        if not order_id:
            logger.warning(f"[{self.name}] F9: No order_id — assuming full fill of {requested_qty:.8f}")
            return requested_qty

        MAX_POLLS    = 3
        POLL_DELAY_S = 3.0

        import asyncio

        for poll in range(MAX_POLLS):
            if poll > 0:
                await asyncio.sleep(POLL_DELAY_S)
            try:
                order_info  = await self.connector.fetch_order(order_id, symbol)
                exch_status = str(order_info.get("status", "unknown")).lower()
                filled_qty  = float(order_info.get("filled", 0) or 0)

                if exch_status in ("closed", "filled"):
                    if abs(filled_qty - requested_qty) > 0.0001:
                        logger.warning(
                            f"[{self.name}] F9 partial fill detected: "
                            f"symbol={symbol} requested={requested_qty:.8f} "
                            f"filled={filled_qty:.8f}"
                        )
                    return filled_qty

                elif exch_status in ("canceled", "cancelled", "rejected", "expired"):
                    logger.warning(
                        f"[{self.name}] F9: Order {order_id} {exch_status}. "
                        f"filled_qty={filled_qty:.8f}"
                    )
                    return filled_qty  # may be partial fill before cancel

                elif exch_status in ("open", "partially_filled", "partial"):
                    # Still filling — keep polling
                    logger.debug(
                        f"[{self.name}] F9: Order {order_id} still {exch_status} "
                        f"(poll {poll+1}/{MAX_POLLS}), filled so far={filled_qty:.8f}"
                    )
                    continue

                else:
                    # Unknown status — return what we have, try again
                    logger.debug(
                        f"[{self.name}] F9: Unknown order status '{exch_status}' "
                        f"for {order_id} — continuing to poll"
                    )
                    continue

            except Exception as e:
                logger.warning(
                    f"[{self.name}] F9: fetch_order failed for {order_id}: {e}. "
                    f"Falling back to requested_qty={requested_qty:.8f}"
                )
                # fetch_order failed — fall through to return requested_qty below
                return requested_qty

        # Polls exhausted — order still not settled. Use requested_qty as fallback.
        logger.warning(
            f"[{self.name}] F9: Order {order_id} not settled after {MAX_POLLS} polls. "
            f"Using requested_qty={requested_qty:.8f} as fallback."
        )
        return requested_qty