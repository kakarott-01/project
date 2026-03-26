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
        user_id: str
    ):
        self.connector = connector
        self.risk = risk_mgr
        self.db = db
        self.user_id = user_id

        self.config = self.load_config()
        self.name = self.config.get("algo_name", self.__class__.__name__)

        logger.info(f"✅ [{self.name}] Initialized for user={user_id}")

    # ─────────────────────────────────────────────

    def load_config(self) -> Dict:
        base_dir = os.path.dirname(__file__)
        config_path = os.path.join(base_dir, "configs", self.config_filename())

        if not os.path.exists(config_path):
            logger.warning(f"⚠️ Config not found: {config_path}, using defaults")
            return self.default_config()

        try:
            with open(config_path, "r") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"❌ Config load failed: {e}")
            return self.default_config()

    # ─────────────────────────────────────────────

    @abstractmethod
    def config_filename(self) -> str:
        ...

    @abstractmethod
    def default_config(self) -> Dict:
        ...

    @abstractmethod
    def get_symbols(self) -> list[str]:
        ...

    @abstractmethod
    async def generate_signal(self, symbol: str) -> Optional[str]:
        ...

    # ─────────────────────────────────────────────

    async def run_cycle(self):
        """
        Main execution loop (called by scheduler)
        """

        try:
            self.config = self.load_config()

            if not self.config.get("enabled", True):
                logger.info(f"[{self.name}] 🚫 Disabled")
                return

            logger.info(f"[{self.name}] 🔄 Running cycle")

            symbols = self.get_symbols()

            # 🔥 Get balance
            balance = await self.connector.get_balance(
                self.config.get("quote_currency", "USDT")
            )

            logger.info(f"[{self.name}] 💰 Balance: {balance}")

            if balance <= 0:
                logger.warning(f"[{self.name}] ❌ No balance, skipping")
                return

            for symbol in symbols:
                try:
                    logger.info(f"[{self.name}] 📊 Checking {symbol}")

                    can_trade, reason = self.risk.can_trade(balance)

                    if not can_trade:
                        logger.info(f"[{self.name}] ⛔ {symbol}: {reason}")
                        continue

                    signal = await self.generate_signal(symbol)

                    logger.info(f"[{self.name}] Signal for {symbol}: {signal}")

                    if not signal:
                        continue

                    # Normalize signal
                    signal = signal.upper()

                    # Save signal
                    await self.db.save_signal(
                        self.user_id,
                        self.name,
                        self.market_type,
                        symbol,
                        signal
                    )

                    ticker = await self.connector.fetch_ticker(symbol)
                    price = ticker.get("last")

                    if not price:
                        logger.warning(f"[{self.name}] ❌ No price for {symbol}")
                        continue

                    quantity = self.risk.calculate_position_size(balance, price)

                    if quantity <= 0:
                        logger.warning(f"[{self.name}] ❌ Invalid quantity")
                        continue

                    paper_mode = self.config.get("paper_mode", True)

                    if paper_mode:
                        await self.db.save_paper_trade(
                            self.user_id,
                            symbol,
                            signal,
                            quantity,
                            price,
                            self.name,
                            self.market_type
                        )

                        logger.info(
                            f"[{self.name}] 🧪 PAPER {signal} {quantity} {symbol} @ {price}"
                        )

                    else:
                        await self._execute_live_trade(
                            symbol,
                            signal,
                            quantity,
                            price
                        )

                except Exception as e:
                    logger.error(
                        f"[{self.name}] ❌ Error on {symbol}: {e}",
                        exc_info=True
                    )

        except Exception as e:
            logger.error(f"[{self.name}] ❌ run_cycle crash: {e}", exc_info=True)
            await self.db.update_bot_status(
                self.user_id,
                "error",
                [],
                str(e)
            )

    # ─────────────────────────────────────────────

    async def _execute_live_trade(
        self,
        symbol: str,
        signal: str,
        quantity: float,
        price: float
    ):
        try:
            logger.info(f"[{self.name}] 🚀 Executing LIVE trade")

            sl = self.risk.calculate_stop_loss(price, signal)
            tp = self.risk.calculate_take_profit(price, signal)

            order = await self.connector.place_order(
                symbol,
                signal,
                quantity
            )

            self.risk.record_trade_opened()

            await self.db.save_live_trade(
                self.user_id,
                symbol,
                signal,
                quantity,
                price,
                sl,
                tp,
                order.get("id"),
                self.name,
                self.market_type
            )

            logger.info(f"[{self.name}] ✅ LIVE trade executed")

        except Exception as e:
            logger.error(f"[{self.name}] ❌ Live trade failed: {e}", exc_info=True)

    # ─────────────────────────────────────────────

    @property
    @abstractmethod
    def market_type(self) -> str:
        ...