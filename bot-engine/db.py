"""
bot-engine/db.py
================
Production database layer.

KEY ADDITIONS for trade lifecycle:
- get_open_trade()     → find an existing open trade for a symbol
- close_paper_trade()  → mark trade closed with exit price + PnL
- close_live_trade()   → same for live trades
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
    ) -> Optional[str]:
        """Save an open paper trade. Returns the new trade ID."""
        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, status, algo_used, is_paper, opened_at)
               VALUES ($1,'paper',$2,$3,$4,$5,$6,'open',$7,true,$8)
               RETURNING id""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price), algo_name,
            datetime.utcnow(),
        )
        logger.info(f"📝 Paper trade opened: {side.upper()} {quantity:.6f} {symbol} @ {price}")
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
    ):
        pool = await self.pool()
        await pool.execute(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, status, algo_used,
                is_paper, exchange_order_id, opened_at)
               VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,'open',$9,false,$10,$11)""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            str(stop_loss), str(take_profit), algo_name, order_id,
            datetime.utcnow(),
        )
        logger.info(f"📝 Live trade opened: {side.upper()} {quantity} {symbol} @ {price}")

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