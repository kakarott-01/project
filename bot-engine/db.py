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
                markets = json.loads(raw) if isinstance(raw, str) else (raw if isinstance(raw, list) else [])
                if markets:
                    result[str(row["user_id"])] = markets
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
            SELECT c.execution_mode, s.strategy_key, sel.slot
            FROM market_strategy_configs c
            LEFT JOIN market_strategy_selections sel ON sel.config_id = c.id
            LEFT JOIN strategies s ON s.id = sel.strategy_id
            WHERE c.user_id=$1 AND c.market_type=$2
            ORDER BY sel.slot ASC
            """,
            user_id, market_type,
        )
        if not rows:
            return {"execution_mode": "SAFE", "strategy_keys": []}

        strategy_keys = [row["strategy_key"] for row in rows if row["strategy_key"]]
        return {
            "execution_mode": rows[0]["execution_mode"] or "SAFE",
            "strategy_keys": strategy_keys,
        }

    async def get_risk_settings(self, user_id: str) -> Dict:
        pool = await self.pool()
        row  = await pool.fetchrow("SELECT * FROM risk_settings WHERE user_id=$1", user_id)
        return dict(row) if row else {}

    async def get_paper_balance(self, user_id: str) -> float:
        pool = await self.pool()
        row = await pool.fetchrow(
            "SELECT paper_balance FROM risk_settings WHERE user_id=$1",
            user_id,
        )
        if row and row["paper_balance"] is not None:
            return float(row["paper_balance"])
        return 10_000.0

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
        algo_name: str,
        market_type: str,
        session_ref: str = "",
        fee_rate: float = 0.001,
    ) -> Optional[str]:
        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, fee_rate, filled_quantity, remaining_quantity,
                status, algo_used, is_paper, bot_session_ref, opened_at)
               VALUES ($1,'paper',$2,$3,$4,$5,$6,$7,0,$5,'open',$8,true,$9,$10)
               ON CONFLICT ON CONSTRAINT idx_trades_one_open_per_symbol DO NOTHING
               RETURNING id""",
            user_id, market_type, symbol,
            side.lower(), str(quantity), str(price),
            str(fee_rate), algo_name, session_ref or None,
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
    ) -> Optional[str]:
        # F9: Use actual filled quantity if provided, fall back to requested quantity
        recorded_quantity = actual_quantity if actual_quantity is not None else quantity

        if actual_quantity is not None and abs(actual_quantity - quantity) > 0.0001:
            logger.warning(
                f"⚠️  Partial fill detected for {symbol}: "
                f"requested={quantity:.8f} filled={actual_quantity:.8f}"
            )

        pool = await self.pool()
        row = await pool.fetchrow(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, fee_rate,
                filled_quantity, remaining_quantity, status, algo_used,
                is_paper, exchange_order_id, bot_session_ref, opened_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$6,'open',$11,false,$12,$13,$14)
               ON CONFLICT ON CONSTRAINT idx_trades_one_open_per_symbol DO NOTHING
               RETURNING id""",
            user_id, exchange_name, market_type, symbol,
            side.lower(), str(recorded_quantity), str(price),
            str(stop_loss), str(take_profit), str(fee_rate),
            algo_name, order_id,
            session_ref or None,
            datetime.utcnow(),
        )
        if row:
            logger.info(f"📝 Live trade opened: {side.upper()} {recorded_quantity} {symbol} @ {price}")
            return str(row["id"])
        else:
            logger.warning(f"⚠️  Duplicate live trade blocked for {symbol} (user={user_id[:8]}…)")
            return None

    # ── Trade: FIND OPEN ──────────────────────────────────────────────────────

    async def get_open_trade(self, user_id: str, symbol: str, market_type: str) -> Optional[Dict[str, Any]]:
        pool = await self.pool()
        row = await pool.fetchrow(
            """SELECT id, side, quantity, entry_price, opened_at,
                      fee_rate, fee_amount, pnl, net_pnl,
                      filled_quantity, remaining_quantity
               FROM trades
               WHERE user_id=$1 AND symbol=$2 AND market_type=$3 AND status='open'
               ORDER BY opened_at DESC LIMIT 1""",
            user_id, symbol, market_type,
        )
        return dict(row) if row else None

    async def get_all_open_trades(self, user_id: str, market_type: str) -> List[Dict[str, Any]]:
        pool = await self.pool()
        rows = await pool.fetch(
            """SELECT id, symbol, side, quantity, entry_price,
                      market_type, is_paper, bot_session_ref, opened_at,
                      fee_rate, pnl, net_pnl, filled_quantity, remaining_quantity
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

    async def get_open_symbols_for_market(self, user_id: str, market_type: str) -> Dict[str, str]:
        pool = await self.pool()
        rows = await pool.fetch(
            "SELECT id::text, symbol FROM trades WHERE user_id=$1 AND market_type=$2 AND status='open'",
            user_id, market_type,
        )
        return {row["symbol"]: str(row["id"]) for row in rows}

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
