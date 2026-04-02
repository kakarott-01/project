"""
bot-engine/risk_manager.py — v2
=================================
FIX K: Risk state (daily_loss, open_trade_count) is now persisted to DB
        and restored on restart. In-memory state is the source of truth
        during a session; DB is synced after every trade event.

        This prevents the scenario where a restarted bot thinks it has
        zero daily loss and trades through its configured daily limit.

Design:
  - RiskManager is initialized synchronously (no async __init__)
  - Call await risk_mgr.load_state(db, user_id, market_type) after creation
    to restore previous state from DB.
  - Call await risk_mgr.persist_state(db, user_id, market_type) after any
    trade event that changes daily_loss or open_trade_count.
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
            cooldown_seconds   = int(cfg.get("cooldown_seconds",     300)),
            trailing_stop      = bool(cfg.get("trailing_stop",       False)),
        )
        # In-memory state — synced to DB after every trade event
        self.daily_loss       = 0.0
        self.open_trade_count = 0
        self.last_loss_time   = None

        # Track whether we've loaded from DB yet
        self._loaded_from_db = False

    # ── FIX K: DB persistence ──────────────────────────────────────────────────

    async def load_state(self, db, user_id: str, market_type: str):
        """
        Load persisted risk state from DB.
        Call this once after creating the RiskManager.
        Safe to call multiple times — only loads once.
        """
        if self._loaded_from_db:
            return

        try:
            state = await db.get_risk_state(user_id, market_type)
            self.daily_loss       = state.get("daily_loss", 0.0)
            self.open_trade_count = state.get("open_trade_count", 0)
            self._loaded_from_db  = True
            logger.info(
                f"📊 Risk state restored for {market_type}: "
                f"daily_loss={self.daily_loss:.4f} "
                f"open_trades={self.open_trade_count}"
            )
        except Exception as e:
            logger.error(
                f"❌ Failed to load risk state from DB: {e}. "
                "Starting with zero values — daily loss guard may be inaccurate today."
            )
            self._loaded_from_db = True  # Don't retry on every cycle

    async def persist_state(self, db, user_id: str, market_type: str):
        """
        Persist current risk state to DB.
        Call after record_trade_opened() or record_trade_closed().
        Non-blocking on failure — logged but not re-raised.
        """
        try:
            await db.update_risk_state(
                user_id, market_type,
                self.daily_loss,
                self.open_trade_count,
            )
        except Exception as e:
            logger.warning(f"⚠️  Failed to persist risk state: {e}")

    # ── Core risk calculations (unchanged) ────────────────────────────────────

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

    def can_trade(self, balance: float) -> tuple[bool, str]:
        # Max open trades
        if self.open_trade_count >= self.cfg.max_open_trades:
            return False, f"Max open trades ({self.cfg.max_open_trades}) reached"

        # Daily loss limit
        daily_loss_pct = abs(self.daily_loss / balance * 100) if balance > 0 else 0
        if daily_loss_pct >= self.cfg.max_daily_loss_pct:
            return False, f"Daily loss limit ({self.cfg.max_daily_loss_pct}%) reached"

        # Cooldown after loss
        if self.last_loss_time:
            elapsed = time.time() - self.last_loss_time
            if elapsed < self.cfg.cooldown_seconds:
                remaining = int(self.cfg.cooldown_seconds - elapsed)
                return False, f"Cooldown active — {remaining}s remaining"

        return True, "ok"

    def record_trade_opened(self):
        self.open_trade_count = min(self.open_trade_count + 1, self.cfg.max_open_trades)

    def record_trade_closed(self, pnl: float):
        self.open_trade_count = max(0, self.open_trade_count - 1)
        self.daily_loss += min(0, pnl)  # only track losses
        if pnl < 0:
            self.last_loss_time = time.time()

    def reset_daily(self):
        """Call at start of each trading day."""
        self.daily_loss = 0.0
        logger.info("Daily loss counter reset")