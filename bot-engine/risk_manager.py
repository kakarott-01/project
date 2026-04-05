"""
bot-engine/risk_manager.py — v3
=================================
F10 FIX: last_loss_time is now persisted to DB and restored on restart.

PROBLEM: last_loss_time was in-memory only. A bot crash or Render restart
reset it to None, allowing trading to resume immediately even if the bot
had hit its cooldown due to a recent loss. This bypassed a critical risk
control.

FIX:
  - load_state() now restores last_loss_time from DB
  - persist_state() now saves last_loss_time to DB
  - record_trade_closed() still sets self.last_loss_time = time.time()
    in memory; persist_state() must be called immediately after to save it

All other logic from v2 unchanged.
"""

import logging
import time
from typing import Optional, Dict
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass
class RiskConfig:
    max_position_pct:   float = 2.0
    stop_loss_pct:      float = 1.5
    take_profit_pct:    float = 3.0
    max_daily_loss_pct: float = 5.0
    max_open_trades:    int   = 3
    max_positions_per_symbol: int = 2
    max_capital_per_strategy_pct: float = 25.0
    max_drawdown_pct: float = 12.0
    cooldown_seconds:   int   = 300
    trailing_stop:      bool  = False


class RiskManager:
    def __init__(self, config: Optional[Dict] = None):
        cfg = config or {}
        self.cfg = RiskConfig(
            max_position_pct   = float(cfg.get("max_position_pct",   2.0)),
            stop_loss_pct      = float(cfg.get("stop_loss_pct",      1.5)),
            take_profit_pct    = float(cfg.get("take_profit_pct",    3.0)),
            max_daily_loss_pct = float(cfg.get("max_daily_loss_pct", 5.0)),
            max_open_trades    = int(cfg.get("max_open_trades",      3)),
            max_positions_per_symbol = int(cfg.get("max_positions_per_symbol", 2)),
            max_capital_per_strategy_pct = float(cfg.get("max_capital_per_strategy_pct", 25.0)),
            max_drawdown_pct = float(cfg.get("max_drawdown_pct", 12.0)),
            cooldown_seconds   = int(cfg.get("cooldown_seconds",     300)),
            trailing_stop      = bool(cfg.get("trailing_stop",       False)),
        )
        # In-memory state — synced to DB after every trade event
        self.daily_loss       = 0.0
        self.open_trade_count = 0
        # F10: last_loss_time is now restored from DB on startup
        self.last_loss_time: Optional[float] = None

        self._loaded_from_db = False

    # ── F10: DB persistence ───────────────────────────────────────────────────

    async def load_state(self, db, user_id: str, market_type: str):
        """
        Load persisted risk state from DB.
        Call once after creating the RiskManager.

        F10: Now also restores last_loss_time so cooldown enforcement
        is correct after a bot restart or crash.
        """
        if self._loaded_from_db:
            return

        try:
            state = await db.get_risk_state(user_id, market_type)
            self.daily_loss       = state.get("daily_loss", 0.0)
            self.open_trade_count = state.get("open_trade_count", 0)
            # F10: Restore last_loss_time. None means no loss recorded today.
            self.last_loss_time   = state.get("last_loss_time", None)
            self._loaded_from_db  = True

            cooldown_remaining = self._cooldown_remaining()
            logger.info(
                f"📊 Risk state restored for {market_type}: "
                f"daily_loss={self.daily_loss:.4f} "
                f"open_trades={self.open_trade_count} "
                f"last_loss_time={'%.0f' % self.last_loss_time if self.last_loss_time else 'None'} "
                f"cooldown_remaining={cooldown_remaining:.0f}s"
            )

            # Warn if cooldown is still active after restart
            if cooldown_remaining > 0:
                logger.warning(
                    f"⏳ [{market_type}] Cooldown still active after restart: "
                    f"{cooldown_remaining:.0f}s remaining. "
                    "No new trades will be entered until cooldown expires."
                )

        except Exception as e:
            logger.error(
                f"❌ Failed to load risk state from DB for {market_type}: {e}. "
                "Starting with zero values — daily loss guard may be inaccurate today."
            )
            self._loaded_from_db = True  # Don't retry on every cycle

    async def persist_state(self, db, user_id: str, market_type: str):
        """
        Persist current risk state to DB.
        Call after record_trade_opened() or record_trade_closed().

        F10: Now also persists last_loss_time.
        Non-blocking on failure — logged but not re-raised.
        """
        try:
            await db.update_risk_state(
                user_id,
                market_type,
                self.daily_loss,
                self.open_trade_count,
                self.last_loss_time,  # F10: persist epoch float or None
            )
        except Exception as e:
            logger.warning(f"⚠️  Failed to persist risk state: {e}")

    # ── Core risk calculations ─────────────────────────────────────────────────

    def calculate_position_size(self, balance: float, entry_price: float) -> float:
        risk_amount = balance * (self.cfg.max_position_pct / 100)
        units       = risk_amount / entry_price
        return round(units, 8)

    def calculate_stop_loss(self, entry_price: float, side: str) -> float:
        factor = 1 - self.cfg.stop_loss_pct / 100 if side == "buy" \
            else 1 + self.cfg.stop_loss_pct / 100
        return round(entry_price * factor, 8)

    def calculate_take_profit(self, entry_price: float, side: str) -> float:
        factor = 1 + self.cfg.take_profit_pct / 100 if side == "buy" \
            else 1 - self.cfg.take_profit_pct / 100
        return round(entry_price * factor, 8)

    def _cooldown_remaining(self) -> float:
        """Return seconds remaining in cooldown, or 0 if not in cooldown."""
        if not self.last_loss_time:
            return 0.0
        elapsed = time.time() - self.last_loss_time
        remaining = self.cfg.cooldown_seconds - elapsed
        return max(0.0, remaining)

    def can_trade(self, balance: float) -> tuple[bool, str]:
        # Max open trades
        if self.open_trade_count >= self.cfg.max_open_trades:
            return False, f"Max open trades ({self.cfg.max_open_trades}) reached"

        # Daily loss limit
        daily_loss_pct = abs(self.daily_loss / balance * 100) if balance > 0 else 0
        if daily_loss_pct >= self.cfg.max_daily_loss_pct:
            return False, f"Daily loss limit ({self.cfg.max_daily_loss_pct}%) reached"

        # F10: Cooldown — now uses persisted last_loss_time that survives restarts
        remaining = self._cooldown_remaining()
        if remaining > 0:
            return False, f"Cooldown active — {remaining:.0f}s remaining"

        return True, "ok"

    def can_open_position(
        self,
        balance: float,
        position_count_for_symbol: int,
        strategy_capital_pct: float,
        drawdown_pct: float,
    ) -> tuple[bool, str]:
        ok, reason = self.can_trade(balance)
        if not ok:
            return ok, reason

        if position_count_for_symbol >= self.cfg.max_positions_per_symbol:
            return False, f"Max positions per symbol ({self.cfg.max_positions_per_symbol}) reached"

        if strategy_capital_pct >= self.cfg.max_capital_per_strategy_pct:
            return False, (
                f"Capital allocation per strategy exceeds "
                f"{self.cfg.max_capital_per_strategy_pct:.2f}%"
            )

        # Hedge mode can offset directional risk, but it also increases
        # operational complexity and margin usage. We hard-stop new entries
        # once the strategy drawdown breaches the configured threshold.
        if drawdown_pct >= self.cfg.max_drawdown_pct:
            return False, f"Drawdown limit ({self.cfg.max_drawdown_pct:.2f}%) reached"

        return True, "ok"

    def record_trade_opened(self):
        self.open_trade_count = min(self.open_trade_count + 1, self.cfg.max_open_trades)

    def record_trade_closed(self, pnl: float):
        self.open_trade_count = max(0, self.open_trade_count - 1)
        self.daily_loss += min(0, pnl)  # only accumulate losses
        if pnl < 0:
            # F10: Set in-memory; caller MUST call persist_state() immediately after
            self.last_loss_time = time.time()

    def reset_daily(self):
        """Call at start of each trading day."""
        self.daily_loss     = 0.0
        self.last_loss_time = None
        logger.info("Daily loss counter reset")
