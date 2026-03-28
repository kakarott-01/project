"""
bot-engine/algorithms/base_algo.py
====================================
Production base algorithm.

KEY FIX: Trade lifecycle now fully managed:
- Entry signal → saves open trade with status='open'
- Exit signal  → finds the open trade, calculates PnL, updates status='closed'
- Paper balance is now tracked per-cycle based on actual closed PnL
"""

import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Optional, Dict
from datetime import datetime

from exchange_connector import ExchangeConnector
from risk_manager import RiskManager

logger = logging.getLogger(__name__)

# Exit signals indicate we're CLOSING an existing position
_EXIT_CLOSES = {
    "BUY":  "SELL",   # if we bought, BUY closes a short
    "SELL": "BUY",    # if we sold, SELL closes a long
}


class BaseAlgo(ABC):
    def __init__(
        self,
        connector: ExchangeConnector,
        risk_mgr: RiskManager,
        db,
        user_id: str,
        paper_mode: bool = True,
    ):
        self.connector   = connector
        self.risk        = risk_mgr
        self.db          = db
        self.user_id     = user_id
        self._paper_mode = paper_mode   # authoritative — from DB only

        self.config = self._load_config()
        self.name   = self.config.get("algo_name", self.__class__.__name__)

        logger.info(
            f"✅ [{self.name}] Init user={user_id[:8]}… "
            f"mode={'PAPER' if paper_mode else '🔴 LIVE'}"
        )

    # ── Config ────────────────────────────────────────────────────────────────

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

    # ── Abstract interface ────────────────────────────────────────────────────

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

    # ── Main execution loop ───────────────────────────────────────────────────

    async def run_cycle(self):
        """Safe wrapper — any exception is caught so the APScheduler job stays alive."""
        try:
            await self._run_cycle_inner()
        except Exception as e:
            logger.error(f"[{self.name}] ❌ run_cycle crashed: {e}", exc_info=True)
            try:
                await self.db.update_bot_status(
                    self.user_id, "error", [], error=str(e)
                )
            except Exception:
                pass

    async def _run_cycle_inner(self):
        self.config = self._load_config()

        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config")
            return

        logger.info(
            f"[{self.name}] 🔄 Cycle "
            f"[{'PAPER' if self._paper_mode else '🔴 LIVE'}]"
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
            await self._process_symbol(symbol, balance)

    # ── Per-symbol processing ─────────────────────────────────────────────────

    async def _process_symbol(self, symbol: str, balance: float):
        try:
            signal = await self.generate_signal(symbol)

            if not signal:
                return

            signal = signal.upper()

            # Determine if this is an exit (closing an open trade)
            # The algo subclass tracks open positions internally and returns
            # the opposite signal when it wants to close. We detect this by
            # checking if there's an open DB trade for this symbol.
            is_exit, open_trade_id, open_entry_price, open_side = \
                await self._find_open_trade(symbol)

            if is_exit and open_trade_id:
                # ── CLOSE existing position ────────────────────────────────
                await self._close_trade(
                    symbol, signal, open_trade_id,
                    open_entry_price, open_side, balance
                )
                return

            # ── OPEN new position ──────────────────────────────────────────
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

    # ── Trade lifecycle helpers ───────────────────────────────────────────────

    async def _find_open_trade(self, symbol: str):
        """
        Returns (is_exit, trade_id, entry_price, side) if there's an open trade.
        """
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
        """Fetch current price, calculate PnL, update trade to closed."""
        try:
            ticker     = await self.connector.fetch_ticker(symbol)
            exit_price = ticker.get("last")
            if not exit_price:
                logger.warning(f"[{self.name}] ❌ No price to close {symbol}")
                return

            # PnL calculation
            open_row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if not open_row:
                return

            quantity = float(open_row["quantity"])

            if original_side.lower() == "sell":
                pnl = (entry_price - exit_price) * quantity
            else:
                pnl = (exit_price - entry_price) * quantity

            pnl_pct = (pnl / (entry_price * quantity)) * 100

            if self._paper_mode:
                await self.db.close_paper_trade(
                    trade_id, exit_price, pnl, pnl_pct
                )
                logger.info(
                    f"[{self.name}] 🧪 PAPER CLOSE {symbol} "
                    f"entry={entry_price} exit={exit_price} "
                    f"PnL={pnl:+.4f} ({pnl_pct:+.2f}%)"
                )
            else:
                order = await self.connector.place_order(
                    symbol, exit_signal, quantity
                )
                await self.db.close_live_trade(
                    trade_id, exit_price, pnl, pnl_pct,
                    order.get("id", "")
                )

            self.risk.record_trade_closed(pnl)

        except Exception as e:
            logger.error(
                f"[{self.name}] ❌ Close trade failed {symbol}: {e}", exc_info=True
            )

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
            )
            logger.info(
                f"[{self.name}] ✅ LIVE {signal} {quantity} {symbol} "
                f"order={order.get('id')}"
            )
        except Exception as e:
            logger.error(
                f"[{self.name}] ❌ Live trade failed {symbol}: {e}", exc_info=True
            )
            raise