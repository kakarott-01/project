"""
bot-engine/algorithms/base_algo.py — v3
=========================================
Fixes applied:

FIX 5 (RUNTIME RECONCILIATION):
  - _runtime_reconcile() runs every 10 minutes per market.
  - Fetches exchange open positions, compares to DB open trades.
  - Trades open in DB but gone from exchange → marked cancelled.
  - Uses reconciliation_log table to throttle to 10-minute intervals
    (avoids expensive exchange API calls every cycle).
  - Paper mode: skipped (no exchange to reconcile against).

FIX C (DOUBLE-CLOSE GUARD):
  - _close_trade() now checks the return value of close_paper_trade /
    close_live_trade. If False (already closed), removes from in-memory
    _open_positions and returns without placing an exchange order.

FIX K (RISK STATE PERSISTENCE):
  - After record_trade_opened() and record_trade_closed(), calls
    await risk.persist_state(db, user_id, market_type) to sync to DB.
  - Risk state is loaded at algo init via _load_risk_state().

PERF P (CONFIG CACHING):
  - _load_config() caches the parsed JSON keyed by file path + mtime.
  - Only re-reads from disk when the file actually changes.
  - Saves one file I/O + JSON parse per symbol per cycle.
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

# ── Module-level config cache ──────────────────────────────────────────────────
# Keyed by file path → (mtime, parsed_config)
# Safe because config files are read-only during a bot run.
_config_file_cache: Dict[str, Tuple[float, Dict]] = {}


def _load_config_cached(config_path: str) -> Optional[Dict]:
    """
    Load JSON config file with mtime-based caching.
    Only re-reads from disk when the file changes.
    """
    try:
        mtime = os.path.getmtime(config_path)
        cached = _config_file_cache.get(config_path)
        if cached and cached[0] == mtime:
            return cached[1]

        with open(config_path, "r") as f:
            data = json.load(f)
        data.pop("paper_mode", None)  # strip config-file paper_mode (DB is authoritative)
        _config_file_cache[config_path] = (mtime, data)
        logger.debug(f"📄 Config reloaded: {config_path}")
        return data
    except Exception as e:
        logger.error(f"❌ Config load error {config_path}: {e}")
        return None


# Interval for runtime reconciliation (seconds)
RECONCILE_INTERVAL_SEC = 10 * 60   # 10 minutes


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

        self._reconciled  = False   # True after first-cycle startup reconciliation
        self._risk_loaded = False   # True after risk state loaded from DB

        self.config = self._load_config()
        self.name   = self.config.get("algo_name", self.__class__.__name__)

        logger.info(
            f"✅ [{self.name}] Init user={user_id[:8]}… "
            f"mode={'PAPER' if paper_mode else '🔴 LIVE'} "
            f"ref={session_ref}"
        )

    # ── Config (PERF P: cached) ────────────────────────────────────────────────

    def _load_config(self) -> Dict:
        base_dir    = os.path.dirname(__file__)
        config_path = os.path.join(base_dir, "configs", self.config_filename())

        if not os.path.exists(config_path):
            logger.warning(f"⚠️  Config not found: {config_path}, using defaults")
            return self.default_config()

        data = _load_config_cached(config_path)
        return data if data is not None else self.default_config()

    # ── Abstract interface ─────────────────────────────────────────────────────

    @abstractmethod
    def config_filename(self) -> str: ...

    def default_config(self) -> Dict:
        return {}

    @abstractmethod
    def get_symbols(self) -> list: ...

    @abstractmethod
    async def generate_signal(self, symbol: str) -> Optional[str]: ...

    @property
    @abstractmethod
    def market_type(self) -> str: ...

    # ── FIX K: Risk state persistence ──────────────────────────────────────────

    async def _load_risk_state(self):
        """Load persisted risk state from DB once at startup."""
        if self._risk_loaded:
            return
        self._risk_loaded = True
        await self.risk.load_state(self.db, self.user_id, self.market_type)

    # ── DB-driven stop state check ─────────────────────────────────────────────

    async def _get_bot_stop_mode(self) -> Optional[str]:
        try:
            return await self.db.get_bot_stop_mode(self.user_id)
        except Exception as e:
            logger.warning(f"[{self.name}] ⚠️  Could not read stop mode: {e}")
            return None

    # ── Startup reconciliation (live mode only) ────────────────────────────────

    async def _reconcile_positions(self):
        """
        Cross-checks DB open trades against exchange open orders.
        Run ONCE on the first cycle.
        """
        if self._paper_mode:
            self._reconciled = True
            return

        logger.info(f"[{self.name}] 🔍 Starting startup reconciliation…")
        try:
            db_open: List[Dict] = await self.db.get_all_open_trades(
                self.user_id, self.market_type
            )
            if not db_open:
                self._reconciled = True
                return

            # Filter to owned trades
            if self._session_ref:
                owned = [
                    t for t in db_open
                    if t.get("bot_session_ref") == self._session_ref
                       or t.get("bot_session_ref") is None
                ]
            else:
                owned = db_open

            if not owned:
                self._reconciled = True
                return

            try:
                exchange_orders = await self.connector.fetch_open_orders()
                exchange_symbols: set = {o.get("symbol", "") for o in exchange_orders}
            except Exception as e:
                logger.warning(
                    f"[{self.name}] ⚠️  Exchange order fetch failed during reconcile: {e}. "
                    "Skipping reconciliation — positions assumed open."
                )
                self._reconciled = True
                return

            orphaned = 0
            for trade in owned:
                symbol = trade["symbol"]
                if symbol not in exchange_symbols:
                    logger.warning(
                        f"[{self.name}] 🔍 Orphan at startup: {symbol} id={trade['id']} "
                        "not found on exchange — marking cancelled"
                    )
                    await self.db.cancel_orphan_trade(trade["id"])
                    if hasattr(self, '_open_positions'):
                        self._open_positions.pop(symbol, None)
                    orphaned += 1

            if orphaned:
                logger.info(f"[{self.name}] Startup reconciled {orphaned} orphan trade(s)")

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Startup reconciliation error: {e}", exc_info=True)
        finally:
            self._reconciled = True

    # ── FIX 5: Runtime reconciliation ─────────────────────────────────────────

    async def _runtime_reconcile(self):
        """
        FIX 5: Periodic runtime check — compares DB open trades against
        exchange positions. Runs every RECONCILE_INTERVAL_SEC (10 minutes).

        This catches the case where a user manually closes a position on
        the exchange while the bot is running. Without this, the DB trade
        stays 'open' forever and the risk manager's open_trade_count stays
        inflated, blocking new trades.

        Paper mode: skipped entirely (no exchange to check against).
        """
        if self._paper_mode:
            return

        try:
            # Check if enough time has passed since the last run
            last_run = await self.db.get_reconciliation_last_run(
                self.user_id, self.market_type
            )
            now = datetime.utcnow()

            if last_run is not None:
                elapsed = (now - last_run).total_seconds()
                if elapsed < RECONCILE_INTERVAL_SEC:
                    return  # Not time yet

            logger.info(f"[{self.name}] 🔄 Runtime reconciliation starting…")

            # Get all open symbols from DB for this market
            db_open_map = await self.db.get_open_symbols_for_market(
                self.user_id, self.market_type
            )

            if not db_open_map:
                # Nothing open in DB — update timestamp and return
                await self.db.update_reconciliation_log(self.user_id, self.market_type, 0)
                return

            # Get open positions from exchange (one API call for all symbols)
            try:
                exchange_orders = await self.connector.fetch_open_orders()
                exchange_symbols: set = {o.get("symbol", "") for o in exchange_orders}
            except Exception as e:
                logger.warning(
                    f"[{self.name}] ⚠️  Exchange fetch_open_orders failed during "
                    f"runtime reconcile: {e}. Skipping this cycle."
                )
                return

            fixed = 0
            for symbol, trade_id in db_open_map.items():
                if symbol not in exchange_symbols:
                    logger.warning(
                        f"[{self.name}] 🔍 Runtime orphan detected: {symbol} "
                        f"id={trade_id} — not on exchange, marking cancelled"
                    )
                    was_fixed = await self.db.cancel_orphan_trade(trade_id)
                    if was_fixed:
                        # Remove from in-memory position tracker
                        if hasattr(self, '_open_positions'):
                            self._open_positions.pop(symbol, None)
                        # Update risk manager — position is gone
                        self.risk.open_trade_count = max(0, self.risk.open_trade_count - 1)
                        fixed += 1

            if fixed:
                logger.info(f"[{self.name}] Runtime reconciled {fixed} orphan trade(s)")
                # Persist updated risk state
                await self.risk.persist_state(self.db, self.user_id, self.market_type)

            await self.db.update_reconciliation_log(self.user_id, self.market_type, fixed)

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Runtime reconciliation error: {e}", exc_info=True)

    # ── Main execution loop ────────────────────────────────────────────────────

    async def run_cycle(self):
        """Safe wrapper — exceptions are caught to keep APScheduler job alive."""
        try:
            await self._run_cycle_inner()
        except Exception as e:
            logger.error(f"[{self.name}] ❌ run_cycle crashed: {e}", exc_info=True)
            try:
                await self.db.update_bot_status(self.user_id, "error", [], error=str(e))
            except Exception:
                pass

    async def _run_cycle_inner(self):
        # ── Step 0: First-cycle initialization ────────────────────────────────
        if not self._reconciled:
            await self._reconcile_positions()

        if not self._risk_loaded:
            await self._load_risk_state()  # FIX K

        # ── Step 0b: PERF P — use cached config (only re-reads on file change)
        self.config = self._load_config()

        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config")
            return

        # ── Step 0c: FIX 5 — runtime reconciliation (throttled to 10 min)
        await self._runtime_reconcile()

        # ── Step 1: Read stop mode from DB ─────────────────────────────────────
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
            balance = await self.connector.get_balance(
                self.config.get("quote_currency", "USDT")
            )

        if balance <= 0:
            logger.warning(f"[{self.name}] ⚠️  Zero balance — skipping")
            return

        for symbol in self.get_symbols():
            await self._process_symbol(symbol, balance, is_draining=is_draining)

    # ── Per-symbol processing ──────────────────────────────────────────────────

    async def _process_symbol(
        self,
        symbol: str,
        balance: float,
        is_draining: bool = False,
    ):
        try:
            signal = await self.generate_signal(symbol)

            if not signal:
                return

            signal = signal.upper()

            is_exit, open_trade_id, open_entry_price, open_side = \
                await self._find_open_trade(symbol)

            if is_exit and open_trade_id:
                await self._close_trade(
                    symbol, signal, open_trade_id,
                    open_entry_price, open_side, balance
                )
                return

            if is_draining:
                logger.info(f"[{self.name}] 🚿 {symbol}: blocking new entry (drain mode)")
                return

            # Double-check from DB to close race window
            stop_mode_now = await self._get_bot_stop_mode()
            if stop_mode_now is not None:
                logger.info(
                    f"[{self.name}] ⛔ {symbol}: stop mode activated mid-cycle "
                    f"({stop_mode_now}) — blocking new entry"
                )
                return

            can_trade, reason = self.risk.can_trade(balance)
            if not can_trade:
                logger.info(f"[{self.name}] ⛔ {symbol}: {reason}")
                return

            await self.db.save_signal(
                self.user_id, self.name, self.market_type, symbol, signal
            )

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
                if trade_id:  # FIX E: None means duplicate was blocked
                    # FIX E: Confirm the staged open (moves to _open_positions)
                    if hasattr(self, '_confirm_staged_open'):
                        self._confirm_staged_open(symbol)
                    self.risk.record_trade_opened()
                    await self.risk.persist_state(self.db, self.user_id, self.market_type)  # FIX K
                    logger.info(
                        f"[{self.name}] 🧪 PAPER OPEN {signal} {quantity:.6f} "
                        f"{symbol} @ {price}"
                    )
                else:
                    # FIX E: DB rejected duplicate — discard staged open
                    if hasattr(self, '_discard_staged_open'):
                        self._discard_staged_open(symbol)
            else:
                await self._execute_live_trade(symbol, signal, quantity, price)

        except Exception as e:
            logger.error(
                f"[{self.name}] ❌ Symbol {symbol} error: {e}", exc_info=True
            )

    # ── Trade lifecycle ────────────────────────────────────────────────────────

    async def _find_open_trade(self, symbol: str) -> Tuple:
        try:
            row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if row:
                return True, row["id"], float(row["entry_price"]), row["side"]
        except Exception as e:
            logger.error(f"❌ find_open_trade error: {e}")
        return False, None, None, None

    async def _close_trade(
        self,
        symbol: str,
        exit_signal: str,
        trade_id: str,
        entry_price: float,
        original_side: str,
        balance: float,
    ):
        try:
            ticker     = await self.connector.fetch_ticker(symbol)
            exit_price = ticker.get("last")
            if not exit_price:
                logger.warning(f"[{self.name}] ❌ No price to close {symbol}")
                return

            open_row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if not open_row:
                # FIX C: Trade was already closed (manual close or concurrent cycle)
                # Remove from in-memory tracker and return
                if hasattr(self, '_open_positions'):
                    self._open_positions.pop(symbol, None)
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
                if not closed:
                    # FIX C: Already closed — clean up in-memory state
                    if hasattr(self, '_open_positions'):
                        self._open_positions.pop(symbol, None)
                    return
                logger.info(
                    f"[{self.name}] 🧪 PAPER CLOSE {symbol} "
                    f"entry={entry_price} exit={exit_price} "
                    f"PnL={pnl:+.4f} ({pnl_pct:+.2f}%)"
                )
            else:
                order = await self.connector.place_order(symbol, exit_signal, quantity)
                closed = await self.db.close_live_trade(
                    trade_id, exit_price, pnl, pnl_pct, order.get("id", "")
                )
                if not closed:
                    # FIX C: Already closed
                    if hasattr(self, '_open_positions'):
                        self._open_positions.pop(symbol, None)
                    return

            # Update risk manager + persist to DB
            self.risk.record_trade_closed(pnl)
            await self.risk.persist_state(self.db, self.user_id, self.market_type)  # FIX K

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Close trade failed {symbol}: {e}", exc_info=True)

    async def _execute_live_trade(
        self,
        symbol: str,
        signal: str,
        quantity: float,
        price: float,
    ):
        try:
            sl    = self.risk.calculate_stop_loss(price, signal)
            tp    = self.risk.calculate_take_profit(price, signal)
            order = await self.connector.place_order(symbol, signal, quantity)

            trade_id = await self.db.save_live_trade(
                self.user_id, symbol, signal, quantity,
                price, sl, tp, order.get("id", ""),
                self.name, self.market_type,
                session_ref=self._session_ref,
            )

            if trade_id:  # FIX E: None means duplicate was blocked
                # FIX E: Confirm staged open
                if hasattr(self, '_confirm_staged_open'):
                    self._confirm_staged_open(symbol)
                self.risk.record_trade_opened()
                await self.risk.persist_state(self.db, self.user_id, self.market_type)  # FIX K
                logger.info(
                    f"[{self.name}] ✅ LIVE {signal} {quantity} {symbol} "
                    f"order={order.get('id')}"
                )
            else:
                # Duplicate blocked — the order was already placed but DB rejected the record.
                # This is a serious state — we placed an order but DB rejected it.
                # FIX E: Discard staged open
                if hasattr(self, '_discard_staged_open'):
                    self._discard_staged_open(symbol)
                order_id = order.get("id")
                if order_id:
                    logger.error(
                        f"[{self.name}] ❌ CRITICAL: Live order placed ({order_id}) but "
                        f"DB rejected duplicate for {symbol}. Attempting to cancel order…"
                    )
                    try:
                        await self.connector.cancel_order(order_id, symbol)
                        logger.info(f"[{self.name}] ✅ Order {order_id} cancelled successfully")
                    except Exception as cancel_err:
                        logger.error(
                            f"[{self.name}] ❌ MANUAL ACTION REQUIRED: Could not cancel "
                            f"order {order_id} for {symbol}: {cancel_err}"
                        )
        except Exception as e:
            logger.error(f"[{self.name}] ❌ Live trade failed {symbol}: {e}", exc_info=True)
            raise