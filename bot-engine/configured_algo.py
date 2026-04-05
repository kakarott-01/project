import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from algorithms.base_algo import BaseAlgo
from strategy_engine import BlackBoxStrategyExecutor, strategy_default_timeframe

logger = logging.getLogger(__name__)

DEFAULT_SYMBOLS = {
    "crypto": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    "indian": ["RELIANCE", "TCS", "HDFCBANK"],
    "commodities": ["XAU/USD", "WTI/USD"],
    "global": ["AAPL", "MSFT", "NVDA"],
}


class ConfiguredMultiStrategyAlgo(BaseAlgo):
    def __init__(
        self,
        *args,
        market_type_name: str,
        strategy_keys: List[str],
        execution_mode: str,
        position_scope_key: str,
        position_mode: str,
        allow_hedge_opposition: bool,
        **kwargs,
    ):
        self._market_type_name = market_type_name
        self._strategy_keys = strategy_keys
        self._execution_mode = execution_mode
        self._position_mode = position_mode
        self._allow_hedge_opposition = allow_hedge_opposition
        self._executor = BlackBoxStrategyExecutor()
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced: set = set()
        self._staged_open: Dict[str, Dict] = {}
        super().__init__(
            *args,
            position_scope_key=position_scope_key,
            strategy_key=strategy_keys[0] if len(strategy_keys) == 1 else None,
            execution_mode=execution_mode,
            position_mode=position_mode,
            allow_hedge_opposition=allow_hedge_opposition,
            **kwargs,
        )
        scope_label = position_scope_key.replace("|", "_")
        self.name = f"BLACKBOX_{self._market_type_name.upper()}_{scope_label}"

    @property
    def market_type(self) -> str:
        return self._market_type_name

    def config_filename(self) -> str:
        return "__sealed_blackbox__.json"

    def default_config(self) -> Dict:
        return {
            "symbols": DEFAULT_SYMBOLS.get(self._market_type_name, []),
            "fee_rate": 0.001,
        }

    def get_symbols(self) -> List[str]:
        return self.config.get("symbols", DEFAULT_SYMBOLS.get(self._market_type_name, []))

    async def _sync_position_from_db(self, symbol: str):
        if symbol in self._db_synced:
            return
        self._db_synced.add(symbol)
        try:
            open_row = await self.db.get_open_trade(
                self.user_id, symbol, self.market_type, self.position_scope_key
            )
            if open_row and symbol not in self._open_positions:
                opened_at = open_row["opened_at"]
                if hasattr(opened_at, "tzinfo") and opened_at.tzinfo is not None:
                    opened_at = opened_at.replace(tzinfo=None)
                self._open_positions[symbol] = {
                    "signal": open_row["side"].upper(),
                    "entry_price": float(open_row["entry_price"]),
                    "opened_at": opened_at,
                }
        except Exception as e:
            logger.error(f"❌ Strategy DB sync failed for {symbol}: {e}", exc_info=True)

    def _stage_open(self, symbol: str, signal: str, price: float):
        self._staged_open[symbol] = {
            "signal": signal,
            "entry_price": price,
            "opened_at": datetime.utcnow(),
        }

    def _confirm_staged_open(self, symbol: str):
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending

    def _discard_staged_open(self, symbol: str):
        self._staged_open.pop(symbol, None)

    def _close(self, symbol: str):
        self._open_positions.pop(symbol, None)

    async def _decision_for_symbol(self, symbol: str) -> tuple[Optional[str], Optional[float]]:
        votes: List[Optional[str]] = []
        latest_close = None

        for strategy_key in self._strategy_keys:
            timeframe = strategy_default_timeframe(strategy_key)
            df = await self.connector.fetch_ohlcv_cached(symbol, timeframe, limit=160)
            if len(df) < 80:
                votes.append(None)
                continue
            latest_close = float(df["close"].iloc[-1])
            votes.append(self._executor.evaluate_strategy(df, strategy_key))

        if latest_close is None:
            return None, None

        decision = self._executor.combine(
            votes,
            self._execution_mode,
            required_votes=len(self._strategy_keys),
        )
        return decision, latest_close

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)
        if not self._strategy_keys:
            return None

        decision, latest_close = await self._decision_for_symbol(symbol)
        if latest_close is None:
            return None

        if symbol in self._open_positions:
            return self._check_exit(symbol, latest_close, decision)

        if decision in ("BUY", "SELL"):
            if (
                len(self._strategy_keys) == 1
                and self._execution_mode == "AGGRESSIVE"
                and (self._position_mode != "HEDGE" or not self._allow_hedge_opposition)
            ):
                open_trades = await self.db.get_open_trades_for_symbol(
                    self.user_id, self.market_type, symbol
                )
                opposite_exists = any(
                    row["position_scope_key"] != self.position_scope_key
                    and row["side"].upper() != decision
                    for row in open_trades
                )
                if opposite_exists:
                    logger.warning(
                        f"[{self.name}] Aggressive entry blocked for {symbol}: "
                        "opposite strategy direction already open on this symbol."
                    )
                    return None

            self._stage_open(symbol, decision, latest_close)
            return decision
        return None

    def _check_exit(self, symbol: str, close: float, decision: Optional[str]) -> Optional[str]:
        pos = self._open_positions[symbol]
        side = pos["signal"]
        entry = pos["entry_price"]
        opened_at = pos["opened_at"]

        sl_pct = float(self.risk.cfg.stop_loss_pct)
        tp_pct = float(self.risk.cfg.take_profit_pct)
        pnl_pct = ((entry - close) / entry) * 100 if side == "SELL" else ((close - entry) / entry) * 100

        reverse = (side == "BUY" and decision == "SELL") or (side == "SELL" and decision == "BUY")
        timed_out = (datetime.utcnow() - opened_at) > timedelta(hours=6)

        if pnl_pct >= tp_pct or pnl_pct <= -sl_pct or reverse or timed_out:
            self._close(symbol)
            return "BUY" if side == "SELL" else "SELL"
        return None
