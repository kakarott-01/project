"""
bot-engine/algorithms/base_algo.py
====================================
REVISED v3 — two critical drain-mode bugs fixed.

Bug 1 — Phantom _open_positions during drain (caused new trades after stop):
  Subclass generate_signal() methods call self._open() BEFORE returning a
  signal, even when the symbol has no open DB trade. In drain mode, these
  phantom entries persist in _open_positions. When the bot subsequently
  transitions from 'stopping' → 'stopped' (between the DB update and the
  APScheduler job removal), a cycle could start with is_draining=False but
  _open_positions still containing phantom entries. _check_exit() would fire,
  return an exit signal, _find_open_trade() would return False (no DB trade),
  and the code would fall through to OPEN A NEW REAL TRADE — causing losses.

  Fix: During drain mode, skip generate_signal() entirely for symbols that
  have no open DB position. Only symbols with live DB positions are processed.

Bug 2 — Race between DB stop update and APScheduler job removal:
  The drain completion previously scheduled stop_user_bot() as a background
  task. Between the DB update ('stopped') and the task actually running to
  remove APScheduler jobs, another job cycle could fire with is_draining=False
  (because DB now shows 'stopped', so _get_bot_stop_mode() returns None) and
  trigger new trade entries.

  Fix: When drain completion is detected inside _wrapped_cycle (scheduler.py),
  jobs are removed synchronously BEFORE the DB status is updated.
  (See scheduler.py for that fix.)
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
        session_ref: str = "",
    ):
        self.connector    = connector
        self.risk         = risk_mgr
        self.db           = db
        self.user_id      = user_id
        self._paper_mode  = paper_mode
        self._session_ref = session_ref

        self._reconciled  = False

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

    async def _get_bot_stop_mode(self) -> Optional[str]:
        try:
            return await self.db.get_bot_stop_mode(self.user_id)
        except Exception as e:
            logger.warning(f"[{self.name}] ⚠️  Could not read stop mode: {e}")
            return None

    # ── Startup reconciliation (live mode only) ────────────────────────────────

    async def _reconcile_positions(self):
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
                    "Skipping reconciliation this start — positions assumed open."
                )
                self._reconciled = True
                return

            orphaned = 0
            for trade in owned:
                symbol = trade["symbol"]
                if symbol not in exchange_symbols:
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

        self.config = self._load_config()

        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config")
            return

        stop_mode = await self._get_bot_stop_mode()
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

            # ── DRAIN MODE: only process symbols with an open DB position ─────
            # This is the critical fix for phantom _open_positions:
            #
            # Without this guard, generate_signal() is called for ALL symbols.
            # Most subclass implementations call self._open() inside
            # generate_signal() BEFORE returning the signal (e.g. CryptoAlgo,
            # IndianMarketsAlgo). This adds a phantom entry to _open_positions
            # even though no DB trade exists. When the bot transitions from
            # 'stopping' → 'stopped' (DB update vs job removal race window),
            # the next cycle sees is_draining=False but _open_positions still
            # contains the phantom entry. _check_exit() fires, _find_open_trade()
            # returns False, and a NEW REAL TRADE IS OPENED — causing losses.
            #
            # Fix: skip generate_signal() entirely for symbols that have no
            # open trade in the DB. Only exit-eligible symbols are processed.
            if is_draining:
                has_open, _, _, _ = await self._find_open_trade(symbol)
                if not has_open:
                    logger.debug(
                        f"[{self.name}] 🚿 {symbol}: no open position — "
                        "skipping signal generation during drain"
                    )
                    continue

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

            # New entry blocked during drain
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