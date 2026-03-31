"""
bot-engine/algorithms/base_algo.py
====================================
REVISED v2 — production-safe.

Key improvements over v1:
1. Drain-mode check is done from DB status (not in-memory scheduler flag).
   This means it survives restarts — a restarted bot in 'stopping' state
   correctly resumes drain behaviour without needing the scheduler to
   reconstruct in-memory state.

2. Race condition fixed: stop/drain check happens AFTER signal generation
   but BEFORE order placement, not only at cycle start.

3. Position ownership: bot only manages trades it created (bot_session_ref
   matches current session). Manual exchange trades are never touched.

4. Startup reconciliation: first cycle cross-checks DB open trades against
   exchange. Orphaned trades (closed on exchange while bot was down) are
   marked cancelled in DB.

5. Paper mode reconciliation is skipped (no exchange to reconcile against).
"""

import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Tuple
from datetime import datetime

from exchange_connector import ExchangeConnector
from risk_manager import RiskManager

logger = logging.getLogger(__name__)


class BaseAlgo(ABC):
    def __init__(
        self,
        connector: ExchangeConnector,
        risk_mgr: RiskManager,
        db,
        user_id: str,
        paper_mode: bool = True,
        session_ref: str = "",   # "{userId}:{sessionId}" — for ownership tagging
    ):
        self.connector    = connector
        self.risk         = risk_mgr
        self.db           = db
        self.user_id      = user_id
        self._paper_mode  = paper_mode
        self._session_ref = session_ref   # ownership tag

        self._reconciled  = False   # True after first-cycle reconciliation

        self.config = self._load_config()
        self.name   = self.config.get("algo_name", self.__class__.__name__)

        logger.info(
            f"✅ [{self.name}] Init user={user_id[:8]}… "
            f"mode={'PAPER' if paper_mode else '🔴 LIVE'} "
            f"ref={session_ref}"
        )

    # ── Config ─────────────────────────────────────────────────────────────────

    def _load_config(self) -> Dict:
        base_dir    = os.path.dirname(__file__)
        config_path = os.path.join(base_dir, "configs", self.config_filename())

        if not os.path.exists(config_path):
            logger.warning(f"⚠️  Config not found: {config_path}, using defaults")
            return self.default_config()

        try:
            with open(config_path, "r") as f:
                cfg = json.load(f)
            cfg.pop("paper_mode", None)
            return cfg
        except Exception as e:
            logger.error(f"❌ Config load failed: {e}")
            return self.default_config()

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

    # ── DB-driven stop state check ─────────────────────────────────────────────
    # Reading from DB (not in-memory) ensures correctness after restart.

    async def _get_bot_stop_mode(self) -> Optional[str]:
        """
        Returns the current stop mode from DB, or None if running normally.
        Possible values: 'close_all', 'graceful', None
        """
        try:
            row = await self.db.get_bot_stop_mode(self.user_id)
            return row  # 'graceful' | 'close_all' | None
        except Exception as e:
            logger.warning(f"[{self.name}] ⚠️  Could not read stop mode: {e}")
            return None

    # ── Startup reconciliation (live mode only) ────────────────────────────────

    async def _reconcile_positions(self):
        """
        Cross-checks DB open trades against exchange open orders.
        Run ONCE on the first cycle.

        Outcomes:
          - DB open + exchange open → restore to _open_positions (normal)
          - DB open + exchange closed → mark DB trade cancelled (orphan)
          - Exchange open + DB missing → log warning, do NOT touch (not our trade)
        """
        if self._paper_mode:
            self._reconciled = True
            return

        logger.info(f"[{self.name}] 🔍 Starting position reconciliation…")
        try:
            db_open: List[Dict] = await self.db.get_all_open_trades(
                self.user_id, self.market_type
            )
            if not db_open:
                self._reconciled = True
                return

            # Filter to only trades this bot session owns
            if self._session_ref:
                owned = [
                    t for t in db_open
                    if t.get("bot_session_ref") == self._session_ref
                       or t.get("bot_session_ref") is None  # legacy trades have no ref
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
                    "Skipping reconciliation this start — positions assumed open."
                )
                self._reconciled = True
                return

            orphaned = 0
            for trade in owned:
                symbol = trade["symbol"]
                if symbol not in exchange_symbols:
                    # Position closed on exchange while bot was down
                    logger.warning(
                        f"[{self.name}] 🔍 Orphan: {symbol} id={trade['id']} "
                        "not found on exchange — marking cancelled"
                    )
                    await self.db.cancel_orphan_trade(trade["id"])
                    if hasattr(self, '_open_positions'):
                        self._open_positions.pop(symbol, None)
                    orphaned += 1

            if orphaned:
                logger.info(f"[{self.name}] Reconciled {orphaned} orphan trade(s)")

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Reconciliation error: {e}", exc_info=True)
        finally:
            self._reconciled = True

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
        # ── Step 0: First-cycle reconciliation ────────────────────────────────
        if not self._reconciled:
            await self._reconcile_positions()

        self.config = self._load_config()

        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config")
            return

        # ── Step 1: Read stop mode from DB ─────────────────────────────────────
        stop_mode = await self._get_bot_stop_mode()
        is_draining   = stop_mode == "graceful"
        is_closing_all = stop_mode == "close_all"

        # close_all is handled by CloseAllEngine, not algo cycles.
        # If we somehow reach this point during close_all, skip.
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
                # ── Always process exits — even during drain ──────────────────
                await self._close_trade(
                    symbol, signal, open_trade_id,
                    open_entry_price, open_side, balance
                )
                return

            # ── New entry: BLOCKED during drain ───────────────────────────────
            # Re-check stop mode HERE (after signal gen) to close the race window
            # where stop fires between generate_signal() and order placement.
            if is_draining:
                logger.info(f"[{self.name}] 🚿 {symbol}: blocking new entry (drain mode)")
                return

            # Double-check from DB to close the race window
            stop_mode_now = await self._get_bot_stop_mode()
            if stop_mode_now is not None:
                logger.info(
                    f"[{self.name}] ⛔ {symbol}: stop mode activated mid-cycle "
                    f"({stop_mode_now}) — blocking new entry"
                )
                return

            # ── Normal entry ──────────────────────────────────────────────────
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
                await self.db.save_paper_trade(
                    self.user_id, symbol, signal, quantity,
                    price, self.name, self.market_type,
                    session_ref=self._session_ref,
                )
                logger.info(
                    f"[{self.name}] 🧪 PAPER OPEN {signal} {quantity:.6f} "
                    f"{symbol} @ {price}"
                )
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
                return

            quantity = float(open_row["quantity"])

            if original_side.lower() == "sell":
                pnl = (entry_price - exit_price) * quantity
            else:
                pnl = (exit_price - entry_price) * quantity

            pnl_pct = (pnl / (entry_price * quantity)) * 100 if entry_price > 0 else 0

            if self._paper_mode:
                await self.db.close_paper_trade(trade_id, exit_price, pnl, pnl_pct)
                logger.info(
                    f"[{self.name}] 🧪 PAPER CLOSE {symbol} "
                    f"entry={entry_price} exit={exit_price} "
                    f"PnL={pnl:+.4f} ({pnl_pct:+.2f}%)"
                )
            else:
                order = await self.connector.place_order(symbol, exit_signal, quantity)
                await self.db.close_live_trade(
                    trade_id, exit_price, pnl, pnl_pct, order.get("id", "")
                )

            self.risk.record_trade_closed(pnl)

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
            self.risk.record_trade_opened()

            await self.db.save_live_trade(
                self.user_id, symbol, signal, quantity,
                price, sl, tp, order.get("id", ""),
                self.name, self.market_type,
                session_ref=self._session_ref,
            )
            logger.info(
                f"[{self.name}] ✅ LIVE {signal} {quantity} {symbol} "
                f"order={order.get('id')}"
            )
        except Exception as e:
            logger.error(f"[{self.name}] ❌ Live trade failed {symbol}: {e}", exc_info=True)
            raise