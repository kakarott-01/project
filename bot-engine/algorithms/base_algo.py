"""
bot-engine/algorithms/base_algo.py
====================================
Production base algorithm class.

Key changes from v1:
- paper_mode comes from DB only (JSON config value is IGNORED)
- Every run_cycle is wrapped in try/except so one bad cycle never kills the job
- Exchange is closed after EVERY operation (ExchangeConnector handles this)
- Heartbeat logging for observability
"""

import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Optional, Dict

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
    ):
        self.connector   = connector
        self.risk        = risk_mgr
        self.db          = db
        self.user_id     = user_id
        self._paper_mode = paper_mode   # authoritative: comes from DB, not JSON

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
            cfg.pop("paper_mode", None)  # strip paper_mode so DB is always source of truth
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
        """
        Safe wrapper around _run_cycle_inner.
        Any exception is caught, logged, and does NOT propagate
        so the APScheduler job stays alive.
        """
        try:
            await self._run_cycle_inner()
        except Exception as e:
            logger.error(
                f"[{self.name}] ❌ run_cycle crashed: {e}", exc_info=True
            )
            try:
                await self.db.update_bot_status(
                    self.user_id, "error", [], error=str(e)
                )
            except Exception:
                pass  # don't let DB error mask the original

    async def _run_cycle_inner(self):
        # Reload JSON config each cycle (allows live param changes without restart)
        # paper_mode is NOT reloaded from config — it only changes on explicit DB update + restart
        self.config = self._load_config()

        if not self.config.get("enabled", True):
            logger.info(f"[{self.name}] 🚫 Disabled by config — skipping cycle")
            return

        logger.info(
            f"[{self.name}] 🔄 Cycle start "
            f"[{'PAPER' if self._paper_mode else '🔴 LIVE'}]"
        )

        # Balance: simulated for paper, real for live
        if self._paper_mode:
            balance = 10_000.0
            logger.info(f"[{self.name}] 🧪 Paper balance: {balance}")
        else:
            balance = await self.connector.get_balance(
                self.config.get("quote_currency", "USDT")
            )
            logger.info(f"[{self.name}] 💰 Live balance: {balance}")

        if balance <= 0:
            logger.warning(f"[{self.name}] ⚠️  Zero balance — skipping cycle")
            return

        for symbol in self.get_symbols():
            await self._process_symbol(symbol, balance)

    async def _process_symbol(self, symbol: str, balance: float):
        try:
            can_trade, reason = self.risk.can_trade(balance)
            if not can_trade:
                logger.info(f"[{self.name}] ⛔ {symbol}: {reason}")
                return

            signal = await self.generate_signal(symbol)
            logger.info(f"[{self.name}] 📊 {symbol} → signal={signal}")

            if not signal:
                return

            signal = signal.upper()

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
                logger.warning(f"[{self.name}] ❌ Invalid quantity for {symbol}")
                return

            if self._paper_mode:
                await self.db.save_paper_trade(
                    self.user_id, symbol, signal, quantity,
                    price, self.name, self.market_type,
                )
                logger.info(f"[{self.name}] 🧪 PAPER {signal} {quantity} {symbol} @ {price}")
            else:
                await self._execute_live_trade(symbol, signal, quantity, price)

        except Exception as e:
            logger.error(
                f"[{self.name}] ❌ Symbol {symbol} error: {e}", exc_info=True
            )
            # Don't re-raise: one bad symbol should not kill the full cycle

    async def _execute_live_trade(
        self,
        symbol: str,
        signal: str,
        quantity: float,
        price: float,
    ):
        try:
            sl = self.risk.calculate_stop_loss(price, signal)
            tp = self.risk.calculate_take_profit(price, signal)

            order = await self.connector.place_order(symbol, signal, quantity)
            self.risk.record_trade_opened()

            await self.db.save_live_trade(
                self.user_id, symbol, signal, quantity,
                price, sl, tp, order.get("id", ""), self.name, self.market_type,
            )
            logger.info(f"[{self.name}] ✅ LIVE {signal} {quantity} {symbol} order={order.get('id')}")

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Live trade failed {symbol}: {e}", exc_info=True)
            raise  # propagate so the cycle error handler can record it