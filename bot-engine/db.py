"""
bot-engine/db.py
================
Production database layer — v2.

Fixes applied:
  FIX C: close_paper_trade / close_live_trade now use WHERE status='open'
          and check rowcount to prevent double-close.
  FIX E: save_paper_trade / save_live_trade use INSERT ... ON CONFLICT DO NOTHING
          (relies on the partial unique index idx_trades_one_open_per_symbol).
  FIX K: New methods for risk state persistence (daily_loss, open_trade_count).
  FIX 5: New method for runtime reconciliation — get_open_trade_ids_for_market()
          and bulk_cancel_orphan_trades().
  PERF:  get_all_open_trades() returns bot_session_ref for reconciliation filtering.
"""

import os
import json
import logging
import base64
import hashlib
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional, Dict, List, Any
from datetime import datetime, date

import asyncpg
from Crypto.Cipher import AES
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)


# ── CryptoJS-compatible AES decryption ────────────────────────────────────────

def _evp_bytes_to_key(password: bytes, salt: bytes, key_len: int = 32, iv_len: int = 16):
    d, result = b"", b""
    while len(result) < key_len + iv_len:
        d = hashlib.md5(d + password + salt).digest()
        result += d
    return result[:key_len], result[key_len:key_len + iv_len]


def decrypt_field(ciphertext: str) -> Optional[str]:
    try:
        if not ciphertext:
            return None
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
        logger.error(f"❌ Decryption failed: {e}")
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

    async def get_running_user_bots(self) -> Dict[str, List[str]]:
        pool = await self.pool()
        rows = await pool.fetch(
            """
            SELECT user_id::text, active_markets
            FROM bot_statuses
            WHERE status = 'running'
            """
        )
        result: Dict[str, List[str]] = {}
        for row in rows:
            try:
                raw = row["active_markets"]
                if isinstance(raw, str):
                    markets = json.loads(raw)
                elif isinstance(raw, list):
                    markets = raw
                else:
                    markets = []

                if markets:
                    result[str(row["user_id"])] = markets
            except Exception as e:
                logger.error(
                    f"❌ get_running_user_bots parse error user={row['user_id']}: {e}"
                )
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

    async def get_risk_settings(self, user_id: str) -> Dict:
        pool = await self.pool()
        row  = await pool.fetchrow("SELECT * FROM risk_settings WHERE user_id=$1", user_id)
        return dict(row) if row else {}

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
        algo_name: str,
        market_type: str,
        session_ref: str = "",
    ) -> Optional[str]:
        """
        Save an open paper trade. Returns the new trade ID, or None if a
        duplicate open trade already exists for this user+symbol+market
        (relies on the partial unique index idx_trades_one_open_per_symbol).

        FIX E: ON CONFLICT DO NOTHING prevents duplicate open trades.
        """
        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, status, algo_used, is_paper, bot_session_ref, opened_at)
               VALUES ($1,'paper',$2,$3,$4,$5,$6,'open',$7,true,$8,$9)
               ON CONFLICT ON CONSTRAINT idx_trades_one_open_per_symbol DO NOTHING
               RETURNING id""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            algo_name, session_ref or None,
            datetime.utcnow(),
        )
        if row:
            logger.info(
                f"📝 Paper trade opened: {side.upper()} {quantity:.6f} {symbol} @ {price} "
                f"ref={session_ref}"
            )
            return str(row["id"])
        else:
            logger.warning(
                f"⚠️  Duplicate open trade blocked for {symbol} (user={user_id[:8]}…). "
                "An open position already exists in DB."
            )
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
    ) -> Optional[str]:
        """
        Save an open live trade.
        FIX E: ON CONFLICT DO NOTHING prevents duplicate opens.
        """
        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, status, algo_used,
                is_paper, exchange_order_id, bot_session_ref, opened_at)
               VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,'open',$9,false,$10,$11,$12)
               ON CONFLICT ON CONSTRAINT idx_trades_one_open_per_symbol DO NOTHING
               RETURNING id""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            str(stop_loss), str(take_profit),
            algo_name, order_id,
            session_ref or None,
            datetime.utcnow(),
        )
        if row:
            logger.info(
                f"📝 Live trade opened: {side.upper()} {quantity} {symbol} @ {price} "
                f"ref={session_ref}"
            )
            return str(row["id"])
        else:
            logger.warning(
                f"⚠️  Duplicate live trade blocked for {symbol} (user={user_id[:8]}…)."
            )
            return None

    # ── Trade: FIND OPEN ──────────────────────────────────────────────────────

    async def get_open_trade(
        self,
        user_id: str,
        symbol: str,
        market_type: str,
    ) -> Optional[Dict[str, Any]]:
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT id, side, quantity, entry_price, opened_at
               FROM trades
               WHERE user_id=$1 AND symbol=$2 AND market_type=$3
                 AND status='open'
               ORDER BY opened_at DESC
               LIMIT 1""",
            user_id, symbol, market_type,
        )
        return dict(row) if row else None

    async def get_all_open_trades(
        self,
        user_id: str,
        market_type: str,
    ) -> List[Dict[str, Any]]:
        pool = await self.pool()
        rows = await pool.fetch(
            """SELECT id, symbol, side, quantity, entry_price,
                      market_type, is_paper, bot_session_ref, opened_at
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
                      market_type, is_paper, bot_session_ref, opened_at
               FROM trades
               WHERE user_id=$1 AND status='open'
               ORDER BY opened_at ASC""",
            user_id,
        )
        return [dict(row) for row in rows]

    async def count_open_trades(self, user_id: str) -> int:
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT count(*)::int AS n FROM trades WHERE user_id=$1 AND status='open'",
            user_id,
        )
        return row["n"] if row else 0

    # ── FIX 5: Runtime reconciliation helpers ──────────────────────────────────

    async def get_open_symbols_for_market(
        self,
        user_id: str,
        market_type: str,
    ) -> Dict[str, str]:
        """
        Returns {symbol: trade_id} for all open trades for user+market.
        Used by runtime reconciliation to compare against exchange positions.
        """
        pool = await self.pool()
        rows = await pool.fetch(
            """SELECT id::text, symbol
               FROM trades
               WHERE user_id=$1 AND market_type=$2 AND status='open'""",
            user_id, market_type,
        )
        return {row["symbol"]: str(row["id"]) for row in rows}

    async def get_reconciliation_last_run(
        self,
        user_id: str,
        market_type: str,
    ) -> Optional[datetime]:
        """Returns the last time reconciliation ran for user+market."""
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT last_run_at FROM reconciliation_log WHERE user_id=$1 AND market_type=$2",
            user_id, market_type,
        )
        return row["last_run_at"] if row else None

    async def update_reconciliation_log(
        self,
        user_id: str,
        market_type: str,
        trades_fixed: int,
    ):
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
    ) -> bool:
        """
        Mark a paper trade as closed.

        FIX C: WHERE status='open' guard prevents double-close.
        Returns True if a row was updated, False if trade was already closed.
        """
        pool = await self.pool()
        result = await pool.execute(
            """UPDATE trades
               SET status='closed',
                   exit_price=$2,
                   pnl=$3,
                   pnl_pct=$4,
                   closed_at=$5
               WHERE id=$1
                 AND status='open'""",   # FIX C: atomic guard
            trade_id,
            str(exit_price),
            _round_pnl(pnl),
            _round_pct(pnl_pct),
            datetime.utcnow(),
        )
        # asyncpg execute() returns "UPDATE N" where N is the number of rows affected
        rows_affected = int(result.split()[-1])

        if rows_affected == 0:
            logger.warning(
                f"⚠️  close_paper_trade: trade {trade_id} was already closed or not found. "
                "Double-close prevented."
            )
            return False

        logger.info(
            f"📝 Paper trade closed id={trade_id} "
            f"exit={exit_price} PnL={pnl:+.4f} ({pnl_pct:+.2f}%)"
        )
        return True

    async def close_live_trade(
        self,
        trade_id: str,
        exit_price: float,
        pnl: float,
        pnl_pct: float,
        close_order_id: str = "",
    ) -> bool:
        """
        Mark a live trade as closed.
        FIX C: WHERE status='open' prevents double-close.
        Returns True if updated, False if already closed.
        """
        pool = await self.pool()
        result = await pool.execute(
            """UPDATE trades
               SET status='closed',
                   exit_price=$2,
                   pnl=$3,
                   pnl_pct=$4,
                   closed_at=$5
               WHERE id=$1
                 AND status='open'""",   # FIX C
            trade_id,
            str(exit_price),
            _round_pnl(pnl),
            _round_pct(pnl_pct),
            datetime.utcnow(),
        )
        rows_affected = int(result.split()[-1])

        if rows_affected == 0:
            logger.warning(
                f"⚠️  close_live_trade: trade {trade_id} was already closed. "
                "Double-close prevented."
            )
            return False

        logger.info(
            f"📝 Live trade closed id={trade_id} exit={exit_price} "
            f"PnL={pnl:+.4f} ({pnl_pct:+.2f}%) order={close_order_id}"
        )
        return True

    # ── Trade: CLOSE TRACKING ─────────────────────────────────────────────────

    async def log_close_attempt(
        self,
        user_id: str,
        trade_id: str,
        attempt: int,
        status: str,
        quantity_req: float = 0,
        quantity_fill: float = 0,
        exchange_order_id: Optional[str] = None,
        error_message: Optional[str] = None,
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO position_close_log
               (user_id, trade_id, attempt, status, quantity_req, quantity_fill,
                exchange_order_id, error_message, attempted_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())""",
            user_id, trade_id, attempt, status,
            str(quantity_req), str(quantity_fill),
            exchange_order_id, error_message,
        )

    async def increment_close_attempts(self, trade_id: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE trades SET close_attempts = COALESCE(close_attempts,0)+1 WHERE id=$1",
            trade_id,
        )

    async def update_close_error(self, trade_id: str, error: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE trades SET close_error=$2 WHERE id=$1",
            trade_id, error,
        )

    # ── Trade: RECONCILIATION ─────────────────────────────────────────────────

    async def cancel_orphan_trade(self, trade_id: str):
        """
        Mark a trade as 'cancelled' when it's open in DB but gone from exchange.
        FIX C: WHERE status='open' guard ensures idempotency.
        """
        pool = await self.pool()
        result = await pool.execute(
            """UPDATE trades
               SET status='cancelled', closed_at=NOW()
               WHERE id=$1 AND status='open'""",
            trade_id,
        )
        rows_affected = int(result.split()[-1])
        if rows_affected > 0:
            logger.info(f"📝 Orphan trade cancelled: id={trade_id}")
        return rows_affected > 0

    # ── FIX K: Risk state persistence ─────────────────────────────────────────

    async def get_risk_state(
        self,
        user_id: str,
        market_type: str,
    ) -> Dict[str, Any]:
        """
        Load today's risk state from DB. Returns defaults if not found.
        Called on RiskManager init to restore counters after restart.
        """
        pool = await self.pool()
        today = date.today().isoformat()
        row = await pool.fetchrow(
            """SELECT daily_loss, open_trade_count
               FROM risk_state
               WHERE user_id=$1 AND market_type=$2 AND day_date=$3::date""",
            user_id, market_type, today,
        )
        if row:
            return {
                "daily_loss":       float(row["daily_loss"]),
                "open_trade_count": int(row["open_trade_count"]),
            }
        return {"daily_loss": 0.0, "open_trade_count": 0}

    async def update_risk_state(
        self,
        user_id: str,
        market_type: str,
        daily_loss: float,
        open_trade_count: int,
    ):
        """
        Persist risk state so restarts don't reset daily loss or open count.
        Uses UPSERT — safe to call after every trade event.
        """
        pool = await self.pool()
        today = date.today().isoformat()
        await pool.execute(
            """INSERT INTO risk_state
               (user_id, market_type, daily_loss, open_trade_count, day_date, updated_at)
               VALUES ($1, $2, $3, $4, $5::date, NOW())
               ON CONFLICT (user_id, market_type, day_date)
               DO UPDATE SET
                 daily_loss       = $3,
                 open_trade_count = $4,
                 updated_at       = NOW()""",
            user_id, market_type,
            _round_pnl(daily_loss),
            open_trade_count,
            today,
        )

    async def reset_daily_risk_state(self, user_id: str, market_type: str):
        """Reset daily loss counter (called at start of new trading day)."""
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO risk_state
               (user_id, market_type, daily_loss, open_trade_count, day_date, updated_at)
               VALUES ($1, $2, 0, 0, CURRENT_DATE, NOW())
               ON CONFLICT (user_id, market_type, day_date)
               DO UPDATE SET daily_loss=0, updated_at=NOW()""",
            user_id, market_type,
        )

    # ── Bot status ────────────────────────────────────────────────────────────

    async def update_bot_status(
        self,
        user_id: str,
        status: str,
        markets: List[str],
        error: Optional[str] = None,
        started_at: Optional[datetime] = None,
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
            "UPDATE bot_statuses SET last_heartbeat=NOW(), updated_at=NOW() WHERE user_id=$1",
            user_id,
        )

    async def get_bot_stop_mode(self, user_id: str) -> Optional[str]:
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT stop_mode, status FROM bot_statuses WHERE user_id=$1",
            user_id,
        )
        if not row:
            return None
        if row["status"] == "stopping":
            return row["stop_mode"]
        return None

    async def force_set_status(self, user_id: str, status: str):
        pool = await self.pool()
        await pool.execute(
            """UPDATE bot_statuses
               SET status=$2, updated_at=NOW(),
                   stop_mode=NULL, stopping_at=NULL
               WHERE user_id=$1""",
            user_id, status,
        )

    async def set_bot_error(self, user_id: str, error_msg: str):
        pool = await self.pool()
        await pool.execute(
            "UPDATE bot_statuses SET error_message=$2, updated_at=NOW() WHERE user_id=$1",
            user_id, error_msg,
        )