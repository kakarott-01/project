import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from algorithms.base_algo import BaseAlgo
from strategy_engine import BlackBoxStrategyExecutor

logger = logging.getLogger(__name__)

DEFAULT_SYMBOLS = {
    "crypto": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    "indian": ["RELIANCE", "TCS", "HDFCBANK"],
    "commodities": ["XAU/USD", "WTI/USD"],
    "global": ["AAPL", "MSFT", "NVDA"],
}

DEFAULT_TIMEFRAMES = {
    "crypto": "15m",
    "indian": "5m",
    "commodities": "1h",
    "global": "1h",
}


class ConfiguredMultiStrategyAlgo(BaseAlgo):
    def __init__(self, *args, market_type_name: str, **kwargs):
        self._market_type_name = market_type_name
        self._executor = BlackBoxStrategyExecutor()
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced: set = set()
        self._staged_open: Dict[str, Dict] = {}
        super().__init__(*args, **kwargs)
        self.name = f"BLACKBOX_{self._market_type_name.upper()}"

    @property
    def market_type(self) -> str:
        return self._market_type_name

    def config_filename(self) -> str:
        return "__sealed_blackbox__.json"

    def default_config(self) -> Dict:
        return {
            "symbols": DEFAULT_SYMBOLS.get(self._market_type_name, []),
            "timeframe": DEFAULT_TIMEFRAMES.get(self._market_type_name, "15m"),
            "fee_rate": 0.001,
        }

    def get_symbols(self) -> List[str]:
        return self.config.get("symbols", DEFAULT_SYMBOLS.get(self._market_type_name, []))

    async def _sync_position_from_db(self, symbol: str):
        if symbol in self._db_synced:
            return
        self._db_synced.add(symbol)
        try:
            open_row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
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

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)
        strategy_cfg = await self.db.get_market_strategy_config(self.user_id, self.market_type)
        strategy_keys = strategy_cfg.get("strategy_keys", [])
        execution_mode = strategy_cfg.get("execution_mode", "SAFE")
        if not strategy_keys:
            return None

        timeframe = self.config.get("timeframe", DEFAULT_TIMEFRAMES.get(self._market_type_name, "15m"))
        df = await self.connector.fetch_ohlcv_cached(symbol, timeframe, limit=160)
        if len(df) < 80:
            return None

        current_close = float(df["close"].iloc[-1])
        decision = self._executor.evaluate(df, strategy_keys, execution_mode)

        if symbol in self._open_positions:
            return self._check_exit(symbol, current_close, decision)

        if decision in ("BUY", "SELL"):
            self._stage_open(symbol, decision, current_close)
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
