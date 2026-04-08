"""
bot-engine/db.py  — v4
========================
F10 FIX: get_risk_state() now returns last_loss_time from DB.
         update_risk_state() now persists last_loss_time to DB.
         This means risk manager cooldown (last_loss_time) survives
         bot restarts and Render process crashes.

F9 FIX:  save_live_trade() now accepts actual_quantity parameter so
         _execute_live_trade() can store the real filled quantity
         from the exchange order response, not the requested quantity.
         Falls back to requested quantity if actual_quantity not provided
         (paper mode, or exchange didn't return fill info).

All other methods from v3 unchanged.
"""

import os
import json
import logging
import base64
import hashlib
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Dict, List, Any
from datetime import datetime, date

import asyncpg
from Crypto.Cipher import AES
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

PENDING_LIVE_TRADE_SPOOL = os.getenv(
    "PENDING_LIVE_TRADE_SPOOL",
    "/tmp/upbot-pending-live-trades.jsonl",
)


# ── Key derivation ────────────────────────────────────────────────────────────

def _derive_key_v2() -> bytes:
    password = os.getenv("ENCRYPTION_KEY")
    if not password:
        raise RuntimeError("ENCRYPTION_KEY not set")
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=b"upbot-salt-v2",
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )


def _evp_bytes_to_key(password: bytes, salt: bytes, key_len: int = 32, iv_len: int = 16):
    d, result = b"", b""
    while len(result) < key_len + iv_len:
        d = hashlib.md5(d + password + salt).digest()
        result += d
    return result[:key_len], result[key_len:key_len + iv_len]


def decrypt_field(ciphertext: str) -> Optional[str]:
    if not ciphertext:
        return None
    if ciphertext.startswith("v2:"):
        return _decrypt_v2(ciphertext[3:])
    return _decrypt_legacy(ciphertext)


def _decrypt_v2(b64: str) -> Optional[str]:
    try:
        key    = _derive_key_v2()
        packed = base64.b64decode(b64)
        if len(packed) < 12 + 16 + 1:
            raise ValueError("v2 ciphertext too short")
        iv         = packed[:12]
        tag        = packed[12:28]
        ciphertext = packed[28:]
        cipher    = AES.new(key, AES.MODE_GCM, nonce=iv)
        plaintext = cipher.decrypt_and_verify(ciphertext, tag)
        return plaintext.decode("utf-8")
    except Exception as e:
        logger.error(f"❌ V2 decryption failed: {e}")
        return None


def _decrypt_legacy(ciphertext: str) -> Optional[str]:
    try:
        password = os.getenv("ENCRYPTION_KEY")
        if not password:
            raise RuntimeError("ENCRYPTION_KEY not set")
        raw = base64.b64decode(ciphertext)
        if raw[:8] != b"Salted__":
            return ciphertext
        salt      = raw[8:16]
        encrypted = raw[16:]
        key, iv   = _evp_bytes_to_key(password.encode(), salt)
        cipher    = AES.new(key, AES.MODE_CBC, iv)
        decrypted = cipher.decrypt(encrypted)
        pad_len   = decrypted[-1]
        return decrypted[:-pad_len].decode("utf-8")
    except Exception as e:
        logger.error(f"❌ Legacy decryption failed: {e}")
        return None


def _round_pnl(value: float, places: int = 8) -> str:
    quantizer = Decimal("0." + "0" * places)
    return str(Decimal(str(value)).quantize(quantizer, rounding=ROUND_HALF_UP))


def _round_pct(value: float) -> str:
    return str(Decimal(str(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


# ── Database ──────────────────────────────────────────────────────────────────

class Database:
    def __init__(self):
        self._url = os.getenv("DATABASE_URL")
        if not self._url:
            raise RuntimeError("DATABASE_URL not set")
        self._pool: Optional[asyncpg.Pool] = None
        self._spool_path = Path(PENDING_LIVE_TRADE_SPOOL)

    async def pool(self) -> asyncpg.Pool:
        if not self._pool:
            self._pool = await asyncpg.create_pool(
                self._url, min_size=1, max_size=5, command_timeout=30
            )
        return self._pool

    async def close(self):
        if self._pool:
            await self._pool.close()
            self._pool = None
            logger.info("🔌 DB pool closed")

    def _ensure_spool_parent(self):
        self._spool_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Startup cleanup ───────────────────────────────────────────────────────

    async def cleanup_stale_sessions(self) -> int:
        pool = await self.pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                result = await conn.execute(
                    "UPDATE bot_sessions SET status='stopped', ended_at=NOW() WHERE status='running'"
                )
        try:
            return int(result.split()[-1])
        except Exception:
            return 0

    # ── Auto-restart support ──────────────────────────────────────────────────

    async def get_running_user_bots(self) -> Dict[str, Dict[str, object]]:
        pool = await self.pool()
        rows = await pool.fetch(
            """
            SELECT user_id::text, active_markets, started_at
            FROM bot_statuses
            WHERE status = 'running'
            """
        )
        result: Dict[str, Dict[str, object]] = {}
        for row in rows:
            try:
                raw = row["active_markets"]
                markets = json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, list) else [])
                if markets:
                    result[str(row["user_id"])] = {
                        "markets": markets,
                        "started_at": row["started_at"],
                    }
            except Exception as e:
                logger.error(f"❌ get_running_user_bots parse error user={row['user_id']}: {e}")
        return result

    # ── Exchange APIs ─────────────────────────────────────────────────────────

    async def get_exchange_apis(self, user_id: str) -> Dict[str, Dict]:
        pool = await self.pool()
        rows = await pool.fetch(
            """SELECT market_type, exchange_name, api_key_enc, api_secret_enc, extra_fields_enc
               FROM exchange_apis WHERE user_id=$1 AND is_active=true""",
            user_id,
        )
        result: Dict[str, Dict] = {}
        for row in rows:
            try:
                api_key    = decrypt_field(row["api_key_enc"])
                api_secret = decrypt_field(row["api_secret_enc"])
                if not api_key or not api_secret:
                    logger.warning(f"⚠️  Skipping market={row['market_type']}: decryption returned empty")
                    continue
                extra: Dict = {}
                if row["extra_fields_enc"]:
                    raw = decrypt_field(row["extra_fields_enc"])
                    if raw:
                        extra = json.loads(raw)
                result[row["market_type"]] = {
                    "exchange_name": row["exchange_name"],
                    "api_key":       api_key,
                    "api_secret":    api_secret,
                    "extra":         extra,
                }
            except Exception as e:
                logger.error(f"❌ API load failed market={row['market_type']}: {e}")
        return result

    async def get_market_modes(self, user_id: str) -> Dict[str, bool]:
        pool = await self.pool()
        rows = await pool.fetch(
            "SELECT market_type, mode, paper_mode FROM market_configs WHERE user_id=$1 AND is_active=true",
            user_id,
        )
        result: Dict[str, bool] = {}
        for row in rows:
            market = row["market_type"]
            result[market] = (row["mode"] == "paper") if row["mode"] else bool(row["paper_mode"])
        return result

    async def get_market_strategy_config(self, user_id: str, market_type: str) -> Dict[str, Any]:
        pool = await self.pool()
        rows = await pool.fetch(
            """
            SELECT
              c.execution_mode,
              c.position_mode,
              c.allow_hedge_opposition,
              c.conflict_blocking,
              c.max_positions_per_symbol,
              c.max_capital_per_strategy_pct,
              c.max_drawdown_pct,
              c.exchange_capabilities,
              s.strategy_key,
              sel.slot,
              sel.priority,
              sel.cooldown_after_trade_sec,
              sel.per_trade_percent,
              sel.max_active_percent,
              sel.health_min_win_rate_pct,
              sel.health_max_drawdown_pct,
              sel.health_max_loss_streak,
              sel.is_auto_disabled,
              sel.auto_disabled_reason,
              sel.last_trade_at
            FROM market_strategy_configs c
            LEFT JOIN market_strategy_selections sel ON sel.config_id = c.id
            LEFT JOIN strategies s ON s.id = sel.strategy_id
            WHERE c.user_id=$1 AND c.market_type=$2
            ORDER BY sel.slot ASC
            """,
            user_id, market_type,
        )
        if not rows:
            return {"execution_mode": "SAFE", "position_mode": "NET", "strategy_keys": []}

        strategy_keys = [row["strategy_key"] for row in rows if row["strategy_key"]]
        strategy_settings = {}
        for row in rows:
            key = row["strategy_key"]
            if not key:
                continue
            strategy_settings[key] = {
                "priority": row["priority"] or "MEDIUM",
                "cooldown_after_trade_sec": int(row["cooldown_after_trade_sec"] or 0),
                "capital_allocation": {
                    "per_trade_percent": float(row["per_trade_percent"] or 10),
                    "max_active_percent": float(row["max_active_percent"] or 25),
                },
                "health": {
                    "min_win_rate_pct": float(row["health_min_win_rate_pct"] or 30),
                    "max_drawdown_pct": float(row["health_max_drawdown_pct"] or 15),
                    "max_loss_streak": int(row["health_max_loss_streak"] or 5),
                    "is_auto_disabled": bool(row["is_auto_disabled"]),
                    "auto_disabled_reason": row["auto_disabled_reason"],
                    "last_trade_at": row["last_trade_at"],
                },
            }
        return {
            "execution_mode": rows[0]["execution_mode"] or "SAFE",
            "position_mode": rows[0]["position_mode"] or "NET",
            "allow_hedge_opposition": bool(rows[0]["allow_hedge_opposition"]),
            "conflict_blocking": bool(rows[0]["conflict_blocking"]),
            "max_positions_per_symbol": int(rows[0]["max_positions_per_symbol"] or 2),
            "max_capital_per_strategy_pct": float(rows[0]["max_capital_per_strategy_pct"] or 25),
            "max_drawdown_pct": float(rows[0]["max_drawdown_pct"] or 12),
            "exchange_capabilities": rows[0]["exchange_capabilities"],
            "strategy_keys": strategy_keys,
            "strategy_settings": strategy_settings,
        }

    async def get_risk_settings(self, user_id: str) -> Dict:
        pool = await self.pool()
        row  = await pool.fetchrow("SELECT * FROM risk_settings WHERE user_id=$1", user_id)
        return dict(row) if row else {}

    async def get_kill_switch_state(self, user_id: str) -> Dict[str, Any]:
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT is_active, close_positions, reason, activated_at, last_deactivated_at
               FROM kill_switch_state WHERE user_id=$1""",
            user_id,
        )
        return dict(row) if row else {
            "is_active": False,
            "close_positions": False,
            "reason": None,
            "activated_at": None,
            "last_deactivated_at": None,
        }

    async def set_kill_switch_state(self, user_id: str, is_active: bool, close_positions: bool = False, reason: Optional[str] = None):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO kill_switch_state
               (user_id, is_active, close_positions, reason, activated_at, last_deactivated_at, updated_at)
               VALUES ($1, $2, $3, $4, CASE WHEN $2 THEN NOW() ELSE NULL END, CASE WHEN NOT $2 THEN NOW() ELSE NULL END, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 is_active=$2,
                 close_positions=$3,
                 reason=$4,
                 activated_at=CASE WHEN $2 THEN NOW() ELSE kill_switch_state.activated_at END,
                 last_deactivated_at=CASE WHEN NOT $2 THEN NOW() ELSE kill_switch_state.last_deactivated_at END,
                 updated_at=NOW()""",
            user_id, is_active, close_positions, reason,
        )

    async def get_global_risk_snapshot(self, user_id: str) -> Dict[str, Any]:
        pool = await self.pool()
        open_row = await pool.fetchrow(
            """SELECT
                 COALESCE(SUM(COALESCE(remaining_quantity, quantity) * entry_price), 0) AS total_exposure,
                 COUNT(*)::int AS open_positions
               FROM trades
               WHERE user_id=$1 AND status='open'""",
            user_id,
        )
        loss_row = await pool.fetchrow(
            """SELECT COALESCE(SUM(daily_loss), 0) AS daily_loss
               FROM risk_state
               WHERE user_id=$1 AND day_date=CURRENT_DATE""",
            user_id,
        )
        return {
            "total_exposure": float(open_row["total_exposure"] or 0),
            "open_positions": int(open_row["open_positions"] or 0),
            "daily_loss": float(loss_row["daily_loss"] or 0),
        }

    async def get_exposure_snapshot(self, user_id: str, market_type: Optional[str] = None) -> Dict[str, Any]:
        pool = await self.pool()
        params: List[Any] = [user_id]
        market_filter = ""
        if market_type:
            params.append(market_type)
            market_filter = "AND market_type=$2"

        rows = await pool.fetch(
            f"""SELECT
                   symbol,
                   strategy_key,
                   side,
                   COALESCE(remaining_quantity, quantity) * entry_price AS notional
                FROM trades
                WHERE user_id=$1 {market_filter} AND status='open'""",
            *params,
        )

        per_symbol: Dict[str, Dict[str, Any]] = {}
        per_strategy: Dict[str, float] = {}
        for row in rows:
            symbol = row["symbol"]
            strategy_key = row["strategy_key"] or "UNSCOPED"
            direction = 1 if str(row["side"]).lower() == "buy" else -1
            notional = float(row["notional"] or 0)

            symbol_entry = per_symbol.setdefault(symbol, {"strategies": {}, "net": 0.0, "direction": "FLAT"})
            symbol_entry["strategies"][strategy_key] = symbol_entry["strategies"].get(strategy_key, 0.0) + (direction * notional)
            symbol_entry["net"] += direction * notional
            symbol_entry["direction"] = "LONG" if symbol_entry["net"] > 0 else "SHORT" if symbol_entry["net"] < 0 else "FLAT"

            per_strategy[strategy_key] = per_strategy.get(strategy_key, 0.0) + notional

        return {"per_symbol": per_symbol, "per_strategy": per_strategy}

    async def log_blocked_trade(
        self,
        user_id: str,
        market_type: str,
        symbol: str,
        side: str,
        reason_code: str,
        reason_message: str,
        strategy_key: Optional[str] = None,
        position_scope_key: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO blocked_trades
               (user_id, market_type, symbol, side, strategy_key, position_scope_key, reason_code, reason_message, details, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())""",
            user_id, market_type, symbol, side.lower(), strategy_key, position_scope_key, reason_code, reason_message, json.dumps(details or {}),
        )

    async def log_risk_event(
        self,
        user_id: str,
        event_type: str,
        severity: str,
        message: str,
        market_type: Optional[str] = None,
        symbol: Optional[str] = None,
        strategy_key: Optional[str] = None,
        payload: Optional[Dict[str, Any]] = None,
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO risk_events
               (user_id, market_type, symbol, strategy_key, event_type, severity, message, payload, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())""",
            user_id, market_type, symbol, strategy_key, event_type, severity, message, json.dumps(payload or {}),
        )

    async def touch_strategy_trade(self, user_id: str, market_type: str, strategy_key: Optional[str]):
        if not strategy_key:
            return
        pool = await self.pool()
        await pool.execute(
            """UPDATE market_strategy_selections sel
               SET last_trade_at=NOW()
               FROM market_strategy_configs cfg, strategies s
               WHERE sel.config_id=cfg.id
                 AND sel.strategy_id=s.id
                 AND cfg.user_id=$1
                 AND cfg.market_type=$2
                 AND s.strategy_key=$3""",
            user_id, market_type, strategy_key,
        )

    async def update_strategy_health(
        self,
        user_id: str,
        market_type: str,
        strategy_key: Optional[str],
        pnl: float,
    ) -> Dict[str, Any]:
        if not strategy_key:
            return {"auto_disabled": False}
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT id, total_trades, winning_trades, losing_trades, loss_streak, realized_pnl, best_equity, max_drawdown_pct
               FROM strategy_performance
               WHERE user_id=$1 AND market_type=$2 AND strategy_key=$3""",
            user_id, market_type, strategy_key,
        )

        total_trades = int(row["total_trades"]) if row else 0
        winning_trades = int(row["winning_trades"]) if row else 0
        losing_trades = int(row["losing_trades"]) if row else 0
        loss_streak = int(row["loss_streak"]) if row else 0
        realized_pnl = float(row["realized_pnl"]) if row else 0.0
        best_equity = float(row["best_equity"]) if row else 0.0

        total_trades += 1
        realized_pnl += pnl
        if pnl >= 0:
            winning_trades += 1
            loss_streak = 0
        else:
            losing_trades += 1
            loss_streak += 1
        best_equity = max(best_equity, realized_pnl)
        drawdown_pct = (((best_equity - realized_pnl) / best_equity) * 100) if best_equity > 0 else 0.0
        win_rate = (winning_trades / total_trades) * 100 if total_trades else 0.0

        if row:
            await pool.execute(
                """UPDATE strategy_performance
                   SET total_trades=$4, winning_trades=$5, losing_trades=$6, loss_streak=$7,
                       realized_pnl=$8, best_equity=$9, max_drawdown_pct=$10, last_trade_at=NOW(), updated_at=NOW()
                   WHERE user_id=$1 AND market_type=$2 AND strategy_key=$3""",
                user_id, market_type, strategy_key, total_trades, winning_trades, losing_trades, loss_streak,
                _round_pnl(realized_pnl), _round_pnl(best_equity), _round_pct(drawdown_pct),
            )
        else:
            await pool.execute(
                """INSERT INTO strategy_performance
                   (user_id, market_type, strategy_key, total_trades, winning_trades, losing_trades, loss_streak,
                    realized_pnl, best_equity, max_drawdown_pct, last_trade_at, last_health_status, updated_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),'healthy',NOW())""",
                user_id, market_type, strategy_key, total_trades, winning_trades, losing_trades, loss_streak,
                _round_pnl(realized_pnl), _round_pnl(best_equity), _round_pct(drawdown_pct),
            )

        thresholds = await pool.fetchrow(
            """SELECT sel.health_min_win_rate_pct, sel.health_max_drawdown_pct, sel.health_max_loss_streak
               FROM market_strategy_selections sel
               JOIN market_strategy_configs cfg ON cfg.id=sel.config_id
               JOIN strategies s ON s.id=sel.strategy_id
               WHERE cfg.user_id=$1 AND cfg.market_type=$2 AND s.strategy_key=$3""",
            user_id, market_type, strategy_key,
        )
        auto_disabled = False
        reason = None
        if thresholds:
            if total_trades >= 3 and win_rate < float(thresholds["health_min_win_rate_pct"] or 0):
                auto_disabled = True
                reason = f"Auto-disabled: win rate {win_rate:.2f}% below threshold."
            elif drawdown_pct >= float(thresholds["health_max_drawdown_pct"] or 0):
                auto_disabled = True
                reason = f"Auto-disabled: drawdown {drawdown_pct:.2f}% exceeded threshold."
            elif loss_streak >= int(thresholds["health_max_loss_streak"] or 999999):
                auto_disabled = True
                reason = f"Auto-disabled: loss streak {loss_streak} exceeded threshold."

        if auto_disabled:
            await pool.execute(
                """UPDATE market_strategy_selections sel
                   SET is_auto_disabled=true, auto_disabled_reason=$4
                   FROM market_strategy_configs cfg, strategies s
                   WHERE sel.config_id=cfg.id
                     AND sel.strategy_id=s.id
                     AND cfg.user_id=$1
                     AND cfg.market_type=$2
                     AND s.strategy_key=$3""",
                user_id, market_type, strategy_key, reason,
            )
        return {"auto_disabled": auto_disabled, "reason": reason, "win_rate": win_rate, "drawdown_pct": drawdown_pct, "loss_streak": loss_streak}

    async def get_paper_balance(self, user_id: str) -> float:
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT paper_balance FROM risk_settings WHERE user_id=$1",
            user_id,
        )
        if row and row["paper_balance"] is not None:
            return float(row["paper_balance"])
        return 10_000.0

    async def get_open_trade_count_for_market(self, user_id: str, market_type: str) -> int:
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT count(*)::int AS n
               FROM trades
               WHERE user_id=$1 AND market_type=$2 AND status='open'""",
            user_id, market_type,
        )
        return int(row["n"] or 0) if row else 0

    async def has_open_trade_for_symbol(self, user_id: str, market_type: str, symbol: str) -> bool:
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT 1
               FROM trades
               WHERE user_id=$1 AND market_type=$2 AND symbol=$3 AND status='open'
               LIMIT 1""",
            user_id, market_type, symbol,
        )
        return row is not None

    async def ensure_risk_state_day(
        self,
        user_id: str,
        market_type: str,
        open_trade_count: int,
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO risk_state
               (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
               VALUES ($1, $2, 0, $3, NULL, CURRENT_DATE, NOW())
               ON CONFLICT (user_id, market_type, day_date)
               DO UPDATE SET open_trade_count=$3, updated_at=NOW()""",
            user_id, market_type, open_trade_count,
        )

    async def sync_open_trade_count(self, user_id: str, market_type: str) -> int:
        actual_count = await self.get_open_trade_count_for_market(user_id, market_type)
        await self.ensure_risk_state_day(user_id, market_type, actual_count)
        return actual_count

    async def reserve_trade_slot(
        self,
        user_id: str,
        market_type: str,
        symbol: str,
        max_open_trades: int,
    ) -> Dict[str, Any]:
        pool = await self.pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                lock_acquired = await conn.fetchval(
                    "SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2))",
                    user_id, market_type,
                )
                if not lock_acquired:
                    row = await conn.fetchrow(
                        """SELECT count(*)::int AS n
                           FROM trades
                           WHERE user_id=$1 AND market_type=$2 AND status='open'""",
                        user_id, market_type,
                    )
                    return {
                        "reserved": False,
                        "duplicate_symbol": False,
                        "lock_timeout": True,
                        "open_trade_count": int(row["n"] or 0) if row else 0,
                        "reason": f"Timed out waiting for trade slot lock for {market_type}",
                    }
                open_rows = await conn.fetch(
                    """SELECT id, symbol
                       FROM trades
                       WHERE user_id=$1 AND market_type=$2 AND status='open'
                       FOR UPDATE""",
                    user_id, market_type,
                )
                actual_count = len(open_rows)
                if any(str(row["symbol"]) == symbol for row in open_rows):
                    await conn.execute(
                        """INSERT INTO risk_state
                           (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
                           VALUES ($1, $2, 0, $3, NULL, CURRENT_DATE, NOW())
                           ON CONFLICT (user_id, market_type, day_date)
                           DO UPDATE SET open_trade_count=$3, updated_at=NOW()""",
                        user_id, market_type, actual_count,
                    )
                    return {
                        "reserved": False,
                        "duplicate_symbol": True,
                        "lock_timeout": False,
                        "open_trade_count": actual_count,
                        "reason": f"Open position already exists for {symbol}",
                    }

                row = await conn.fetchrow(
                    """SELECT daily_loss, open_trade_count, last_loss_time
                       FROM risk_state
                       WHERE user_id=$1 AND market_type=$2 AND day_date=CURRENT_DATE
                       FOR UPDATE""",
                    user_id, market_type,
                )
                current_count = max(actual_count, int(row["open_trade_count"] or 0)) if row else actual_count
                if current_count >= max_open_trades:
                    if row:
                        await conn.execute(
                            """UPDATE risk_state
                               SET open_trade_count=$3, updated_at=NOW()
                               WHERE user_id=$1 AND market_type=$2 AND day_date=CURRENT_DATE""",
                            user_id, market_type, current_count,
                        )
                    else:
                        await conn.execute(
                            """INSERT INTO risk_state
                               (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
                               VALUES ($1, $2, 0, $3, NULL, CURRENT_DATE, NOW())""",
                            user_id, market_type, current_count,
                        )
                    return {
                        "reserved": False,
                        "duplicate_symbol": False,
                        "lock_timeout": False,
                        "open_trade_count": current_count,
                        "reason": f"Max open trades ({max_open_trades}) reached",
                    }

                next_count = current_count + 1
                if row:
                    await conn.execute(
                        """UPDATE risk_state
                           SET open_trade_count=$3, updated_at=NOW()
                           WHERE user_id=$1 AND market_type=$2 AND day_date=CURRENT_DATE""",
                        user_id, market_type, next_count,
                    )
                else:
                    await conn.execute(
                        """INSERT INTO risk_state
                           (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
                           VALUES ($1, $2, 0, $3, NULL, CURRENT_DATE, NOW())""",
                        user_id, market_type, next_count,
                    )
                return {
                    "reserved": True,
                    "duplicate_symbol": False,
                    "lock_timeout": False,
                    "open_trade_count": next_count,
                    "reason": "ok",
                }

    async def release_trade_slot(self, user_id: str, market_type: str) -> int:
        pool = await self.pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
                    user_id, market_type,
                )
                open_rows = await conn.fetch(
                    """SELECT id
                       FROM trades
                       WHERE user_id=$1 AND market_type=$2 AND status='open'
                       FOR UPDATE""",
                    user_id, market_type,
                )
                actual_count = len(open_rows)
                row = await conn.fetchrow(
                    """SELECT 1
                       FROM risk_state
                       WHERE user_id=$1 AND market_type=$2 AND day_date=CURRENT_DATE
                       FOR UPDATE""",
                    user_id, market_type,
                )
                if row:
                    await conn.execute(
                        """UPDATE risk_state
                           SET open_trade_count=$3, updated_at=NOW()
                           WHERE user_id=$1 AND market_type=$2 AND day_date=CURRENT_DATE""",
                        user_id, market_type, actual_count,
                    )
                else:
                    await conn.execute(
                        """INSERT INTO risk_state
                           (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
                           VALUES ($1, $2, 0, $3, NULL, CURRENT_DATE, NOW())""",
                        user_id, market_type, actual_count,
                    )
                return actual_count

    # ── Watchdog restart counter ──────────────────────────────────────────────

    async def get_watchdog_restart_count(self, user_id: str) -> int:
        pool = await self.pool()
        row  = await pool.fetchrow(
            "SELECT watchdog_restart_count FROM bot_statuses WHERE user_id=$1",
            user_id,
        )
        if row is None or row["watchdog_restart_count"] is None:
            return 0
        return int(row["watchdog_restart_count"])

    async def set_watchdog_restart_count(self, user_id: str, count: int):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO bot_statuses (user_id, status, watchdog_restart_count, updated_at)
               VALUES ($1, 'error', $2, NOW())
               ON CONFLICT (user_id) DO UPDATE
               SET watchdog_restart_count=$2, updated_at=NOW()""",
            user_id, count,
        )

    async def reset_watchdog_restart_count(self, user_id: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE bot_statuses SET watchdog_restart_count=0, updated_at=NOW() WHERE user_id=$1",
            user_id,
        )

    # ── Failed live orders ────────────────────────────────────────────────────

    async def save_failed_live_order(
        self,
        user_id: str,
        exchange_name: str,
        market_type: str,
        symbol: str,
        side: str,
        quantity: float,
        entry_price: float,
        exchange_order_id: Optional[str],
        fail_reason: str,
        cancel_attempted: bool = False,
        cancel_succeeded: bool = False,
        cancel_error: Optional[str] = None,
    ):
        pool = await self.pool()
        try:
            await pool.execute(
                """INSERT INTO failed_live_orders
                   (user_id, exchange_name, market_type, symbol, side, quantity,
                    entry_price, exchange_order_id, fail_reason, cancel_attempted,
                    cancel_succeeded, cancel_error, requires_manual_review, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,NOW())""",
                user_id, exchange_name, market_type, symbol,
                side.lower(), str(quantity), str(entry_price),
                exchange_order_id, fail_reason,
                cancel_attempted, cancel_succeeded, cancel_error,
            )
            logger.error(
                f"🚨 MANUAL REVIEW REQUIRED: Failed live order saved. "
                f"symbol={symbol} side={side} qty={quantity} "
                f"order_id={exchange_order_id} reason={fail_reason}"
            )
        except Exception as e:
            logger.critical(
                f"💀 CRITICAL: Could not save failed order record to DB! "
                f"symbol={symbol} order_id={exchange_order_id} err={e}. "
                "MANUAL EXCHANGE CHECK REQUIRED."
            )

    async def spool_live_trade(self, payload: Dict[str, Any]):
        self._ensure_spool_parent()
        line = json.dumps(payload, separators=(",", ":"))
        with self._spool_path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        logger.critical(
            f"💾 Live trade spooled locally for recovery: "
            f"{payload.get('symbol')} order={payload.get('order_id')}"
        )

    async def flush_spooled_live_trades(
        self,
        user_id: Optional[str] = None,
        market_type: Optional[str] = None,
    ) -> Dict[str, int]:
        if not self._spool_path.exists():
            return {"restored": 0, "remaining": 0}

        restored = 0
        retained: List[str] = []

        with self._spool_path.open("r", encoding="utf-8") as fh:
            lines = [line.strip() for line in fh.readlines() if line.strip()]

        for line in lines:
            try:
                payload = json.loads(line)
            except Exception:
                retained.append(line)
                continue

            if user_id and payload.get("user_id") != user_id:
                retained.append(line)
                continue
            if market_type and payload.get("market_type") != market_type:
                retained.append(line)
                continue

            try:
                trade_id = await self.save_live_trade(
                    user_id=payload["user_id"],
                    symbol=payload["symbol"],
                    side=payload["side"],
                    quantity=float(payload["requested_quantity"]),
                    price=float(payload["entry_price"]),
                    stop_loss=float(payload["stop_loss"]),
                    take_profit=float(payload["take_profit"]),
                    order_id=payload["order_id"],
                    algo_name=payload["algo_name"],
                    market_type=payload["market_type"],
                    session_ref=payload.get("session_ref", "") or "",
                    actual_quantity=float(payload["actual_quantity"]),
                    exchange_name=payload.get("exchange_name", "live"),
                    fee_rate=float(payload.get("fee_rate", 0.001)),
                    strategy_key=payload.get("strategy_key"),
                        position_scope_key=payload.get("position_scope_key"),
                        stop_loss_order_id=payload.get("stop_loss_order_id"),
                )
                if trade_id:
                    restored += 1
                    logger.info(
                        f"♻️  Restored spooled live trade {payload['symbol']} "
                        f"order={payload['order_id']}"
                    )
                else:
                    logger.warning(
                        f"♻️  Spool replay skipped duplicate open trade for "
                        f"{payload['symbol']} order={payload['order_id']}"
                    )
            except Exception as e:
                payload["retry_count"] = int(payload.get("retry_count", 0)) + 1
                payload["last_error"] = str(e)[:300]
                retained.append(json.dumps(payload, separators=(",", ":")))

        self._ensure_spool_parent()
        with self._spool_path.open("w", encoding="utf-8") as fh:
            for line in retained:
                fh.write(line + "\n")

        return {"restored": restored, "remaining": len(retained)}

    # ── Signal storage ────────────────────────────────────────────────────────

    async def save_signal(
        self,
        user_id: str,
        algo_name: str,
        market_type: str,
        symbol: str,
        signal: str,
        indicators: Optional[Dict] = None,
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO algo_signals
               (user_id, market_type, symbol, signal, algo_name, indicators_snapshot, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            user_id, market_type, symbol,
            signal.lower(), algo_name, json.dumps(indicators or {}),
            datetime.utcnow(),
        )

    # ── Trade: OPEN ───────────────────────────────────────────────────────────

    async def save_paper_trade(
        self,
        user_id: str,
        symbol: str,
        side: str,
        quantity: float,
        price: float,
        stop_loss: Optional[float],
        take_profit: Optional[float],
        algo_name: str,
        market_type: str,
        session_ref: str = "",
        fee_rate: float = 0.001,
        strategy_key: Optional[str] = None,
        position_scope_key: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> Optional[str]:
        pool = await self.pool()
        scope_key = position_scope_key or strategy_key or algo_name or "default"
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, fee_rate, filled_quantity, remaining_quantity,
                status, algo_used, strategy_key, position_scope_key, is_paper, bot_session_ref, metadata, opened_at)
               VALUES ($1,'paper',$2,$3,$4,$5,$6,$7,$8,$9,0,$5,'open',$10,$11,$12,true,$13,$14,$15)
               ON CONFLICT (user_id, market_type, symbol, position_scope_key)
               WHERE status='open' DO NOTHING
               RETURNING id""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            str(stop_loss) if stop_loss is not None else None,
            str(take_profit) if take_profit is not None else None,
            str(fee_rate), algo_name, strategy_key, scope_key, session_ref or None,
            metadata,
            datetime.utcnow(),
        )
        if row:
            logger.info(f"📝 Paper trade opened: {side.upper()} {quantity:.6f} {symbol} @ {price}")
            return str(row["id"])
        else:
            logger.warning(f"⚠️  Duplicate open trade blocked for {symbol} (user={user_id[:8]}…)")
            return None

    async def save_live_trade(
        self,
        user_id: str,
        symbol: str,
        side: str,
        quantity: float,
        price: float,
        stop_loss: float,
        take_profit: float,
        order_id: str,
        algo_name: str,
        market_type: str,
        session_ref: str = "",
        # F9: actual quantity filled by the exchange (may differ from requested)
        actual_quantity: Optional[float] = None,
        exchange_name: str = "live",
        fee_rate: float = 0.001,
        strategy_key: Optional[str] = None,
        position_scope_key: Optional[str] = None,
        metadata: Optional[dict] = None,
        stop_loss_order_id: Optional[str] = None,
    ) -> Optional[str]:
        # F9: Use actual filled quantity if provided, fall back to requested quantity
        recorded_quantity = actual_quantity if actual_quantity is not None else quantity

        if actual_quantity is not None and abs(actual_quantity - quantity) > 0.0001:
            logger.warning(
                f"⚠️  Partial fill detected for {symbol}: "
                f"requested={quantity:.8f} filled={actual_quantity:.8f}"
            )

        scope_key = position_scope_key or strategy_key or algo_name or "default"
        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, fee_rate,
                filled_quantity, remaining_quantity, status, algo_used, strategy_key, position_scope_key,
                is_paper, exchange_order_id, stop_loss_order_id, bot_session_ref, metadata, opened_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$6,'open',$11,$12,$13,false,$14,$15,$16,$17,$18)
               ON CONFLICT (user_id, market_type, symbol, position_scope_key)
               WHERE status='open' DO NOTHING
               RETURNING id""",
            user_id, exchange_name, market_type, symbol,
            side.lower(), str(recorded_quantity), str(price),
            str(stop_loss), str(take_profit), str(fee_rate),
            algo_name, strategy_key, scope_key, order_id,
            stop_loss_order_id,
            session_ref or None,
            metadata,
            datetime.utcnow(),
        )
        if row:
            logger.info(f"📝 Live trade opened: {side.upper()} {recorded_quantity} {symbol} @ {price}")
            return str(row["id"])
        else:
            logger.warning(f"⚠️  Duplicate live trade blocked for {symbol} (user={user_id[:8]}…)")
            return None

    # ── Trade: FIND OPEN ──────────────────────────────────────────────────────

    async def get_open_trade(
        self,
        user_id: str,
        symbol: str,
        market_type: str,
        position_scope_key: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        pool = await self.pool()
        if position_scope_key:
            row = await pool.fetchrow(
                """SELECT id, side, quantity, entry_price, opened_at,
                          stop_loss, take_profit, fee_rate, fee_amount, pnl, net_pnl,
                          filled_quantity, remaining_quantity, strategy_key, position_scope_key,
                          metadata
                   FROM trades
                   WHERE user_id=$1 AND symbol=$2 AND market_type=$3
                     AND position_scope_key=$4 AND status='open'
                   ORDER BY opened_at DESC LIMIT 1""",
                user_id, symbol, market_type, position_scope_key,
            )
        else:
            row = await pool.fetchrow(
                """SELECT id, side, quantity, entry_price, opened_at,
                          stop_loss, take_profit, fee_rate, fee_amount, pnl, net_pnl,
                          filled_quantity, remaining_quantity, strategy_key, position_scope_key,
                          metadata
                   FROM trades
                   WHERE user_id=$1 AND symbol=$2 AND market_type=$3 AND status='open'
                   ORDER BY opened_at DESC LIMIT 1""",
                user_id, symbol, market_type,
            )
        return dict(row) if row else None

    async def get_all_open_trades(
        self,
        user_id: str,
        market_type: str,
        position_scope_key: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        pool = await self.pool()
        if position_scope_key:
            rows = await pool.fetch(
                """SELECT id, symbol, side, quantity, entry_price,
                          market_type, is_paper, bot_session_ref, opened_at,
                          fee_rate, pnl, net_pnl, filled_quantity, remaining_quantity,
                          strategy_key, position_scope_key
                   FROM trades
                   WHERE user_id=$1 AND market_type=$2 AND position_scope_key=$3 AND status='open'
                   ORDER BY opened_at ASC""",
                user_id, market_type, position_scope_key,
            )
        else:
            rows = await pool.fetch(
                """SELECT id, symbol, side, quantity, entry_price,
                          market_type, is_paper, bot_session_ref, opened_at,
                          fee_rate, pnl, net_pnl, filled_quantity, remaining_quantity,
                          strategy_key, position_scope_key
                   FROM trades
                   WHERE user_id=$1 AND market_type=$2 AND status='open'
                   ORDER BY opened_at ASC""",
                user_id, market_type,
            )
        return [dict(row) for row in rows]

    async def get_all_open_trades_all_markets(self, user_id: str) -> List[Dict[str, Any]]:
        pool = await self.pool()
        rows = await pool.fetch(
            """SELECT id, symbol, side, quantity, entry_price,
                      market_type, is_paper, bot_session_ref, opened_at,
                      fee_rate, pnl, net_pnl, filled_quantity, remaining_quantity
               FROM trades WHERE user_id=$1 AND status='open' ORDER BY opened_at ASC""",
            user_id,
        )
        return [dict(row) for row in rows]

    async def count_open_trades(self, user_id: str) -> int:
        pool = await self.pool()
        row  = await pool.fetchrow(
            "SELECT count(*)::int AS n FROM trades WHERE user_id=$1 AND status='open'", user_id
        )
        return row["n"] if row else 0

    # ── Reconciliation helpers ────────────────────────────────────────────────

    async def get_open_trade_refs_for_market(
        self,
        user_id: str,
        market_type: str,
        position_scope_key: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        pool = await self.pool()
        if position_scope_key:
            rows = await pool.fetch(
                """SELECT id::text, symbol, position_scope_key
                   FROM trades
                   WHERE user_id=$1 AND market_type=$2 AND position_scope_key=$3 AND status='open'""",
                user_id, market_type, position_scope_key,
            )
        else:
            rows = await pool.fetch(
                """SELECT id::text, symbol, position_scope_key
                   FROM trades
                   WHERE user_id=$1 AND market_type=$2 AND status='open'""",
                user_id, market_type,
            )
        return [dict(row) for row in rows]

    async def get_open_trades_for_symbol(self, user_id: str, market_type: str, symbol: str) -> List[Dict[str, Any]]:
        pool = await self.pool()
        rows = await pool.fetch(
            """SELECT id::text, side, strategy_key, position_scope_key, entry_price, quantity, remaining_quantity
               FROM trades
               WHERE user_id=$1 AND market_type=$2 AND symbol=$3 AND status='open'
               ORDER BY opened_at ASC""",
            user_id, market_type, symbol,
        )
        return [dict(row) for row in rows]

    async def get_trade_by_id(self, trade_id: str) -> Optional[Dict[str, Any]]:
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT id::text, user_id::text, symbol, side, strategy_key, position_scope_key,
                      market_type, quantity, remaining_quantity, entry_price, opened_at
               FROM trades
               WHERE id=$1""",
            trade_id,
        )
        return dict(row) if row else None

    async def get_open_strategy_exposure(self, user_id: str, market_type: str, strategy_key: Optional[str]) -> float:
        if not strategy_key:
            return 0.0
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT COALESCE(SUM(COALESCE(remaining_quantity, quantity) * entry_price), 0) AS notional
               FROM trades
               WHERE user_id=$1 AND market_type=$2 AND strategy_key=$3 AND status='open'""",
            user_id, market_type, strategy_key,
        )
        return float(row["notional"]) if row and row["notional"] is not None else 0.0

    async def get_reconciliation_last_run(self, user_id: str, market_type: str) -> Optional[datetime]:
        pool = await self.pool()
        row  = await pool.fetchrow(
            "SELECT last_run_at FROM reconciliation_log WHERE user_id=$1 AND market_type=$2",
            user_id, market_type,
        )
        return row["last_run_at"] if row else None

    async def update_reconciliation_log(self, user_id: str, market_type: str, trades_fixed: int):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO reconciliation_log (user_id, market_type, last_run_at, trades_fixed)
               VALUES ($1, $2, NOW(), $3)
               ON CONFLICT (user_id, market_type)
               DO UPDATE SET last_run_at=NOW(), trades_fixed=$3""",
            user_id, market_type, trades_fixed,
        )

    # ── Trade: CLOSE ──────────────────────────────────────────────────────────

    async def close_paper_trade(
        self,
        trade_id: str,
        exit_price: float,
        pnl: float,
        pnl_pct: float,
        fee_amount: float = 0.0,
        close_quantity: Optional[float] = None,
    ) -> bool:
        pool   = await self.pool()
        result = await pool.execute(
            """UPDATE trades
               SET status='closed',
                   exit_price=$2,
                   pnl=COALESCE(pnl, 0) + $3,
                   net_pnl=COALESCE(net_pnl, 0) + $3,
                   pnl_pct=$4,
                   fee_amount=COALESCE(fee_amount, 0) + $5,
                   filled_quantity=COALESCE(filled_quantity, 0) + $6,
                   remaining_quantity=0,
                   closed_at=$7
               WHERE id=$1 AND status='open'""",
            trade_id, str(exit_price), _round_pnl(pnl), _round_pct(pnl_pct),
            _round_pnl(fee_amount), str(close_quantity or 0), datetime.utcnow(),
        )
        rows_affected = int(result.split()[-1])
        if rows_affected == 0:
            logger.warning(f"⚠️  close_paper_trade: trade {trade_id} already closed. Double-close prevented.")
            return False
        logger.info(
            f"📝 Paper trade closed id={trade_id} exit={exit_price} "
            f"net_PnL={pnl:+.4f} fees={fee_amount:.4f}"
        )
        return True

    async def close_live_trade(
        self,
        trade_id: str,
        exit_price: float,
        pnl: float,
        pnl_pct: float,
        close_order_id: str = "",
        fee_amount: float = 0.0,
        close_quantity: Optional[float] = None,
    ) -> bool:
        pool   = await self.pool()
        result = await pool.execute(
            """UPDATE trades
               SET status='closed',
                   exit_price=$2,
                   pnl=COALESCE(pnl, 0) + $3,
                   net_pnl=COALESCE(net_pnl, 0) + $3,
                   pnl_pct=$4,
                   fee_amount=COALESCE(fee_amount, 0) + $5,
                   filled_quantity=COALESCE(filled_quantity, 0) + $6,
                   remaining_quantity=0,
                   exchange_order_id=COALESCE(NULLIF($7, ''), exchange_order_id),
                   closed_at=$8
               WHERE id=$1 AND status='open'""",
            trade_id, str(exit_price), _round_pnl(pnl), _round_pct(pnl_pct),
            _round_pnl(fee_amount), str(close_quantity or 0), close_order_id,
            datetime.utcnow(),
        )
        rows_affected = int(result.split()[-1])
        if rows_affected == 0:
            logger.warning(f"⚠️  close_live_trade: trade {trade_id} already closed. Double-close prevented.")
            return False
        logger.info(
            f"📝 Live trade closed id={trade_id} exit={exit_price} "
            f"net_PnL={pnl:+.4f} fees={fee_amount:.4f}"
        )
        return True

    async def record_partial_close(
        self,
        user_id: str,
        trade_id: str,
        exit_price: float,
        filled_quantity: float,
        remaining_quantity: float,
        partial_pnl: float,
        pnl_pct: float,
        fee_amount: float,
        order_id: str,
    ) -> bool:
        pool = await self.pool()
        result = await pool.execute(
            """UPDATE trades
               SET filled_quantity=COALESCE(filled_quantity, 0) + $2,
                   remaining_quantity=$3,
                   pnl=COALESCE(pnl, 0) + $4,
                   net_pnl=COALESCE(net_pnl, 0) + $4,
                   pnl_pct=$5,
                   fee_amount=COALESCE(fee_amount, 0) + $6,
                   exit_price=$7,
                   exchange_order_id=COALESCE(NULLIF($8, ''), exchange_order_id)
               WHERE id=$1 AND status='open'""",
            trade_id,
            str(filled_quantity),
            str(remaining_quantity),
            _round_pnl(partial_pnl),
            _round_pct(pnl_pct),
            _round_pnl(fee_amount),
            str(exit_price),
            order_id,
        )
        rows_affected = int(result.split()[-1])
        if rows_affected == 0:
            return False
        await self.log_close_attempt(
            user_id=user_id,
            trade_id=trade_id,
            attempt=1,
            status="partial",
            quantity_req=filled_quantity + remaining_quantity,
            quantity_fill=filled_quantity,
            exchange_order_id=order_id,
        )
        logger.info(
            f"📝 Partial close trade={trade_id} fill={filled_quantity:.8f} "
            f"remaining={remaining_quantity:.8f} net_PnL={partial_pnl:+.4f}"
        )
        return True

    # ── Trade: CLOSE TRACKING ─────────────────────────────────────────────────

    async def log_close_attempt(
        self, user_id: str, trade_id: str, attempt: int, status: str,
        quantity_req: float = 0, quantity_fill: float = 0,
        exchange_order_id: Optional[str] = None, error_message: Optional[str] = None,
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO position_close_log
               (user_id, trade_id, attempt, status, quantity_req, quantity_fill,
                exchange_order_id, error_message, attempted_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())""",
            user_id, trade_id, attempt, status,
            str(quantity_req), str(quantity_fill), exchange_order_id, error_message,
        )

    async def increment_close_attempts(self, trade_id: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE trades SET close_attempts = COALESCE(close_attempts,0)+1 WHERE id=$1", trade_id,
        )

    async def update_close_error(self, trade_id: str, error: str):
        pool = await self.pool()
        await pool.execute("UPDATE trades SET close_error=$2 WHERE id=$1", trade_id, error)

    async def cancel_orphan_trade(self, trade_id: str):
        pool   = await self.pool()
        result = await pool.execute(
            "UPDATE trades SET status='cancelled', closed_at=NOW() WHERE id=$1 AND status='open'", trade_id,
        )
        rows_affected = int(result.split()[-1])
        if rows_affected > 0:
            logger.info(f"📝 Orphan trade cancelled: id={trade_id}")
        return rows_affected > 0

    # ── Risk state (F10: now includes last_loss_time) ─────────────────────────

    async def get_risk_state(self, user_id: str, market_type: str) -> Dict[str, Any]:
        """
        F10 FIX: Now returns last_loss_time so risk manager cooldowns survive
        bot restarts. last_loss_time is stored as a float (UTC epoch seconds),
        matching Python's time.time() output. NULL in DB → None here → risk
        manager treats it as "no recent loss".
        """
        pool  = await self.pool()
        today = date.today()
        row   = await pool.fetchrow(
            """SELECT daily_loss, open_trade_count, last_loss_time
               FROM risk_state
               WHERE user_id=$1 AND market_type=$2 AND day_date=$3::date""",
            user_id, market_type, today,
        )
        if row:
            return {
                "daily_loss":      float(row["daily_loss"]),
                "open_trade_count": int(row["open_trade_count"]),
                # F10: None if never set, or epoch seconds float if set
                "last_loss_time":  float(row["last_loss_time"]) if row["last_loss_time"] is not None else None,
            }
        return {"daily_loss": 0.0, "open_trade_count": 0, "last_loss_time": None}

    async def update_risk_state(
        self,
        user_id: str,
        market_type: str,
        daily_loss: float,
        open_trade_count: int,
        last_loss_time: Optional[float] = None,  # F10: new param
    ):
        """
        F10 FIX: Persists last_loss_time alongside daily_loss and open_trade_count.
        last_loss_time is the UTC epoch float from time.time() at the moment of
        the last loss, or None if no loss has occurred today.
        """
        pool  = await self.pool()
        today = date.today()
        await pool.execute(
            """INSERT INTO risk_state
               (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6::date, NOW())
               ON CONFLICT (user_id, market_type, day_date)
               DO UPDATE SET
                 daily_loss=$3,
                 open_trade_count=$4,
                 last_loss_time=$5,
                 updated_at=NOW()""",
            user_id, market_type,
            _round_pnl(daily_loss),
            open_trade_count,
            last_loss_time,  # F10: can be None (NULL in DB)
            today,
        )

    async def reset_daily_risk_state(self, user_id: str, market_type: str):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO risk_state
               (user_id, market_type, daily_loss, open_trade_count, last_loss_time, day_date, updated_at)
               VALUES ($1, $2, 0, 0, NULL, CURRENT_DATE, NOW())
               ON CONFLICT (user_id, market_type, day_date)
               DO UPDATE SET daily_loss=0, open_trade_count=0, last_loss_time=NULL, updated_at=NOW()""",
            user_id, market_type,
        )

    # ── Bot status ────────────────────────────────────────────────────────────

    async def update_bot_status(
        self, user_id: str, status: str, markets: List[str],
        error: Optional[str] = None, started_at: Optional[datetime] = None,
    ):
        pool = await self.pool()
        now  = datetime.utcnow()
        await pool.execute(
            """INSERT INTO bot_statuses
               (user_id, status, active_markets, started_at, last_heartbeat, error_message, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (user_id) DO UPDATE SET
                 status=$2, active_markets=$3,
                 started_at=COALESCE(EXCLUDED.started_at, bot_statuses.started_at),
                 last_heartbeat=$5, error_message=$6, updated_at=$7""",
            user_id, status, json.dumps(markets),
            started_at or (now if status == "running" else None),
            now, error, now,
        )

    async def update_heartbeat(self, user_id: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE bot_statuses SET last_heartbeat=NOW(), updated_at=NOW() WHERE user_id=$1", user_id,
        )

    async def get_bot_status(self, user_id: str) -> Optional[str]:
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT status FROM bot_statuses WHERE user_id=$1",
            user_id,
        )
        return row["status"] if row else None

    async def get_bot_stop_mode(self, user_id: str) -> Optional[str]:
        pool = await self.pool()
        row  = await pool.fetchrow(
            "SELECT stop_mode, status FROM bot_statuses WHERE user_id=$1", user_id,
        )
        if not row:
            return None
        return row["stop_mode"] if row["status"] == "stopping" else None

    async def force_set_status(self, user_id: str, status: str):
        pool = await self.pool()
        await pool.execute(
            """UPDATE bot_statuses SET status=$2, updated_at=NOW(), stop_mode=NULL, stopping_at=NULL
               WHERE user_id=$1""",
            user_id, status,
        )

    async def set_bot_error(self, user_id: str, error_msg: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE bot_statuses SET error_message=$2, updated_at=NOW() WHERE user_id=$1",
            user_id, error_msg,
        )

    async def set_bot_error_state(self, user_id: str, error_msg: str):
        """
        F2/F11: Sets bot status to 'error' (not 'stopped') with a clear message.
        Used by close_all_engine when positions fail to close — bot should appear
        as failed/errored, not silently stopped, so user knows manual action needed.
        """
        pool = await self.pool()
        await pool.execute(
            """UPDATE bot_statuses
               SET status='error', error_message=$2, updated_at=NOW(),
                   stop_mode=NULL, stopping_at=NULL
               WHERE user_id=$1""",
            user_id, error_msg,
        )
        logger.error(f"🚨 Bot set to error state for user={user_id[:8]}…: {error_msg}")
