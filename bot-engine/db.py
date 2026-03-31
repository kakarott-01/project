"""
bot-engine/db.py
================
Production database layer.

KEY ADDITIONS for trade lifecycle:
- get_open_trade()                  → find an existing open trade for a symbol
- close_paper_trade()               → mark trade closed with exit price + PnL
- close_live_trade()                → same for live trades

v2 ADDITIONS (Stop Bot feature):
- get_bot_stop_mode()               → read stop_mode for drain/close check
- force_set_status()                → fallback status setter if callback fails
- set_bot_error()                   → store error message on bot_statuses
- get_all_open_trades_all_markets() → used by CloseAllEngine
- count_open_trades()               → drain completion check
- log_close_attempt()               → audit trail for close_all
- increment_close_attempts()        → track retry count on trade
- update_close_error()              → store last close error on trade
- cancel_orphan_trade()             → reconciliation helper
- save_paper_trade() (updated)      → accepts optional session_ref
- save_live_trade()  (updated)      → accepts optional session_ref
"""

import os
import json
import logging
import base64
import hashlib
from typing import Optional, Dict, List, Any
from datetime import datetime

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
                await conn.execute(
                    "UPDATE bot_statuses SET status='stopped', updated_at=NOW() WHERE status='running'"
                )
        try:
            return int(result.split()[-1])
        except Exception:
            return 0

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
        """Save an open paper trade. Returns the new trade ID."""
        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, status, algo_used, is_paper, bot_session_ref, opened_at)
               VALUES ($1,'paper',$2,$3,$4,$5,$6,'open',$7,true,$8,$9)
               RETURNING id""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            algo_name, session_ref or None,
            datetime.utcnow(),
        )
        logger.info(
            f"📝 Paper trade opened: {side.upper()} {quantity:.6f} {symbol} @ {price} "
            f"ref={session_ref}"
        )
        return str(row["id"]) if row else None

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
    ):
        """Save an open live trade."""
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, status, algo_used,
                is_paper, exchange_order_id, bot_session_ref, opened_at)
               VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,'open',$9,false,$10,$11,$12)""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            str(stop_loss), str(take_profit),
            algo_name, order_id,
            session_ref or None,
            datetime.utcnow(),
        )
        logger.info(
            f"📝 Live trade opened: {side.upper()} {quantity} {symbol} @ {price} "
            f"ref={session_ref}"
        )

    # ── Trade: FIND OPEN ──────────────────────────────────────────────────────

    async def get_open_trade(
        self,
        user_id: str,
        symbol: str,
        market_type: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Returns the most recent open trade for a user+symbol+market, or None.
        """
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

    async def get_all_open_trades_all_markets(self, user_id: str) -> List[Dict[str, Any]]:
        """
        Returns ALL open trades for a user across all markets.
        Used by CloseAllEngine.
        """
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
        """Count open trades for a user (all markets). Used for drain completion check."""
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT count(*)::int AS n FROM trades WHERE user_id=$1 AND status='open'",
            user_id,
        )
        return row["n"] if row else 0

    # ── Trade: CLOSE ──────────────────────────────────────────────────────────

    async def close_paper_trade(
        self,
        trade_id: str,
        exit_price: float,
        pnl: float,
        pnl_pct: float,
    ):
        """Mark a paper trade as closed with final exit price and PnL."""
        pool = await self.pool()
        await pool.execute(
            """UPDATE trades
               SET status='closed',
                   exit_price=$2,
                   pnl=$3,
                   pnl_pct=$4,
                   closed_at=$5
               WHERE id=$1""",
            trade_id,
            str(exit_price),
            str(round(pnl, 8)),
            str(round(pnl_pct, 4)),
            datetime.utcnow(),
        )
        logger.info(
            f"📝 Paper trade closed id={trade_id} "
            f"exit={exit_price} PnL={pnl:+.4f} ({pnl_pct:+.2f}%)"
        )

    async def close_live_trade(
        self,
        trade_id: str,
        exit_price: float,
        pnl: float,
        pnl_pct: float,
        close_order_id: str = "",
    ):
        """Mark a live trade as closed."""
        pool = await self.pool()
        await pool.execute(
            """UPDATE trades
               SET status='closed',
                   exit_price=$2,
                   pnl=$3,
                   pnl_pct=$4,
                   closed_at=$5
               WHERE id=$1""",
            trade_id,
            str(exit_price),
            str(round(pnl, 8)),
            str(round(pnl_pct, 4)),
            datetime.utcnow(),
        )
        logger.info(
            f"📝 Live trade closed id={trade_id} exit={exit_price} "
            f"PnL={pnl:+.4f} ({pnl_pct:+.2f}%) order={close_order_id}"
        )

    # ── Trade: CLOSE TRACKING (v2) ────────────────────────────────────────────

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
        """Insert a row into position_close_log for audit trail."""
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
        """Increment the close_attempts counter on a trade."""
        pool = await self.pool()
        await pool.execute(
            "UPDATE trades SET close_attempts = COALESCE(close_attempts,0)+1 WHERE id=$1",
            trade_id,
        )

    async def update_close_error(self, trade_id: str, error: str):
        """Store the last close error on a trade."""
        pool = await self.pool()
        await pool.execute(
            "UPDATE trades SET close_error=$2 WHERE id=$1",
            trade_id, error,
        )

    # ── Trade: RECONCILIATION (v2) ─────────────────────────────────────────────

    async def cancel_orphan_trade(self, trade_id: str):
        """
        Mark a trade as 'cancelled' when it's open in DB but gone from exchange.
        The trade was likely closed by SL/TP on exchange while the bot was offline.
        We don't have an exit price so we use 'cancelled' rather than 'closed'.
        """
        pool = await self.pool()
        await pool.execute(
            """UPDATE trades
               SET status='cancelled', closed_at=NOW()
               WHERE id=$1 AND status='open'""",
            trade_id,
        )
        logger.info(f"📝 Orphan trade cancelled: id={trade_id}")

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

    # ── Bot status: v2 additions ──────────────────────────────────────────────

    async def get_bot_stop_mode(self, user_id: str) -> Optional[str]:
        """
        Returns the stop_mode from bot_statuses for this user when status='stopping'.
        Returns 'graceful', 'close_all', or None.
        """
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
        """
        Fallback: directly set bot status without touching other fields.
        Used when the completion callback fails after CloseAllEngine finishes.
        """
        pool = await self.pool()
        await pool.execute(
            """UPDATE bot_statuses
               SET status=$2, updated_at=NOW(),
                   stop_mode=NULL, stopping_at=NULL
               WHERE user_id=$1""",
            user_id, status,
        )

    async def set_bot_error(self, user_id: str, error_msg: str):
        """Set error_message on bot_statuses (for user-facing alerts in the UI)."""
        pool = await self.pool()
        await pool.execute(
            "UPDATE bot_statuses SET error_message=$2, updated_at=NOW() WHERE user_id=$1",
            user_id, error_msg,
        )