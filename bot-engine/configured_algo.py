"""
bot-engine/configured_algo.py — v2
=====================================
Changes from v1:
  - Integrates leverage metadata from staged_open (set by CryptoAlgo)
  - Paper mode uses leverage-aware PnL simulation via LeverageMixin
  - Live mode calls setup_futures_position() before placing order
  - Non-crypto markets: leverage is forced to 1 (guard in place)
  - All other logic from v1 preserved.
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from algorithms.base_algo import BaseAlgo
from leverage_mixin import LeverageMixin
from strategy_engine import BlackBoxStrategyExecutor, strategy_default_timeframe

logger = logging.getLogger(__name__)

DEFAULT_SYMBOLS = {
    "crypto":      ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    "indian":      ["RELIANCE", "TCS", "HDFCBANK"],
    "commodities": ["XAU/USD", "WTI/USD"],
    "global":      ["AAPL", "MSFT", "NVDA"],
}


def validate_default_symbols() -> bool:
    """
    Basic runtime validation for `DEFAULT_SYMBOLS`.

    Checks that the mapping contains non-empty lists of string symbols for
    each configured market and logs warnings for suspicious entries.
    Returns True when no obvious issues are found, False otherwise.
    """
    ok = True
    if not isinstance(DEFAULT_SYMBOLS, dict):
        logger.error("❌ DEFAULT_SYMBOLS must be a dict")
        return False

    for market, symbols in DEFAULT_SYMBOLS.items():
        if not isinstance(market, str) or not market:
            logger.warning("⚠️ Invalid DEFAULT_SYMBOLS market key: %r", market)
            ok = False
            continue
        if not isinstance(symbols, (list, tuple)) or not symbols:
            logger.warning("⚠️ DEFAULT_SYMBOLS[%s] is empty or not a list", market)
            ok = False
            continue
        for s in symbols:
            if not isinstance(s, str) or not s.strip():
                logger.warning("⚠️ DEFAULT_SYMBOLS[%s] contains invalid symbol: %r", market, s)
                ok = False
                continue
            # Heuristic: crypto pairs usually contain '/'
            if market == "crypto" and "/" not in s:
                logger.warning(
                    "⚠️ DEFAULT_SYMBOLS[crypto] symbol %s does not contain '/' — may be invalid for ccxt",
                    s,
                )
                ok = False

    if ok:
        logger.info("✅ DEFAULT_SYMBOLS validation passed")
    else:
        logger.warning("⚠️ DEFAULT_SYMBOLS validation found issues; see TODO.md")
    return ok


class ConfiguredMultiStrategyAlgo(LeverageMixin, BaseAlgo):
    """
    Black-box multi-strategy algo that delegates to BlackBoxStrategyExecutor.
    For crypto markets, leverage from confidence engine is propagated through
    the staged_open dict and applied at execution time.
    """

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
        self._market_type_name    = market_type_name
        self._strategy_keys       = strategy_keys
        self._execution_mode      = execution_mode
        self._position_mode       = position_mode
        self._allow_hedge_opposition = allow_hedge_opposition
        self._executor            = BlackBoxStrategyExecutor()
        self._open_positions:  Dict[str, Dict] = {}
        self._db_synced:       set = set()
        self._staged_open:     Dict[str, Dict] = {}
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
        return {
            "indian": "indian_markets.json",
            "commodities": "commodities.json",
            "global": "global_general.json",
            "crypto": "crypto.json",
        }.get(self._market_type_name, "global_general.json")

    def default_config(self) -> Dict:
        return {
            "symbols": DEFAULT_SYMBOLS.get(self._market_type_name, []),
            "fee_rate": 0.001,
            "risk_pct_per_trade": 1.0,
        }

    def get_symbols(self) -> List[str]:
        return self.config.get("symbols", DEFAULT_SYMBOLS.get(self._market_type_name, []))

    # ── DB sync ───────────────────────────────────────────────────────────────

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
                metadata = open_row.get("metadata") or {}
                self._open_positions[symbol] = {
                    "signal":      open_row["side"].upper(),
                    "entry_price": float(open_row["entry_price"]),
                    "opened_at":   opened_at,
                    "leverage":    int(metadata.get("leverage", 1)) if isinstance(metadata, dict) else 1,
                    "confidence":  float(metadata.get("confidence", 50)) if isinstance(metadata, dict) else 50.0,
                    "stop_loss":   float(open_row["stop_loss"]) if open_row.get("stop_loss") is not None else None,
                    "take_profit": float(open_row["take_profit"]) if open_row.get("take_profit") is not None else None,
                }
        except Exception as exc:
            logger.error("❌ Strategy DB sync failed for %s: %s", symbol, exc, exc_info=True)

    # ── Staged open helpers ───────────────────────────────────────────────────

    def _stage_open(self, symbol: str, signal: str, price: float, **extra):
        self._staged_open[symbol] = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
            "leverage":    extra.get("leverage", 1),
            "confidence":  extra.get("confidence", 50.0),
        }

    def _confirm_staged_open(self, symbol: str):
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending

    def _discard_staged_open(self, symbol: str):
        self._staged_open.pop(symbol, None)

    def _close(self, symbol: str):
        self._open_positions.pop(symbol, None)

    # ── Signal generation ─────────────────────────────────────────────────────

    async def _decision_for_symbol(self, symbol: str):
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
            # Default leverage=1 for non-crypto; crypto uses confidence engine
            leverage = 1
            conf = 50.0
            if self._market_type_name == "crypto":
                # For blackbox crypto strategies, use a conservative default
                from confidence_engine import leverage_from_score, score_confidence
                try:
                    df_latest = await self.connector.fetch_ohlcv_cached(
                        symbol,
                        strategy_default_timeframe(self._strategy_keys[0]),
                        limit=250,
                    )
                    conf = score_confidence(df_latest, decision)
                    lev = leverage_from_score(conf)
                    if lev is None:
                        self._discard_staged_open(symbol)
                        return None  # confidence too low
                    leverage = lev
                except Exception as exc:
                    logger.warning("⚠️  confidence scoring failed for %s: %s", symbol, exc)
                    return None
            self._stage_open(symbol, decision, latest_close, leverage=leverage, confidence=conf)
            return decision
        return None

    # ── Exit logic (leverage-aware) ───────────────────────────────────────────

    def _check_exit(self, symbol: str, close: float, decision: Optional[str]) -> Optional[str]:
        pos = self._open_positions[symbol]
        side = pos["signal"]
        opened_at = pos["opened_at"]
        sl_price = pos.get("stop_loss")
        tp_price = pos.get("take_profit")

        if tp_price:
            tp_price = float(tp_price)
            if (side == "BUY" and close >= tp_price) or (side == "SELL" and close <= tp_price):
                self._set_exit_price_override(symbol, tp_price)
                self._close(symbol)
                return "BUY" if side == "SELL" else "SELL"

        if sl_price:
            sl_price = float(sl_price)
            if (side == "BUY" and close <= sl_price) or (side == "SELL" and close >= sl_price):
                self._set_exit_price_override(symbol, sl_price)
                self._close(symbol)
                return "BUY" if side == "SELL" else "SELL"

        reverse = (side == "BUY" and decision == "SELL") or \
                  (side == "SELL" and decision == "BUY")
        timed_out = (datetime.utcnow() - opened_at) > timedelta(hours=6)

        if reverse or timed_out:
            self._close(symbol)
            return "BUY" if side == "SELL" else "SELL"
        return None
