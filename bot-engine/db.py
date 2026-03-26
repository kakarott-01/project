import os
import logging
from typing import Optional, Dict, List
from datetime import datetime
from cryptography.fernet import Fernet
import base64
import hashlib
import asyncpg
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

def _get_fernet() -> Fernet:
    key_hex = os.getenv("ENCRYPTION_KEY", "")
    key_bytes = bytes.fromhex(key_hex)[:32]
    fernet_key = base64.urlsafe_b64encode(key_bytes)
    return Fernet(fernet_key)

def decrypt_field(ciphertext: str) -> str:
    try:
        from Cryptodome.Cipher import AES
        import base64, hashlib

        key = os.getenv("ENCRYPTION_KEY", "").encode()[:32]

        if not ciphertext:
            return None

        raw = base64.b64decode(ciphertext)

        if raw[:8] == b'Salted__':
            salt = raw[8:16]
            data = raw[16:]

            d, d_i = b'', b''
            while len(d) < 48:
                d_i = hashlib.md5(d_i + key + salt).digest()
                d += d_i

            aes_key, iv = d[:32], d[32:48]
            cipher = AES.new(aes_key, AES.MODE_CBC, iv)
            decrypted = cipher.decrypt(data)
            pad = decrypted[-1]

            return decrypted[:-pad].decode('utf-8')

        return ciphertext

    except Exception as e:
        logger.error(f"❌ Decryption failed: {e}")
        return None

class Database:
    def __init__(self):
        self.url = os.getenv("DATABASE_URL")
        self._pool: Optional[asyncpg.Pool] = None

    async def _get_pool(self) -> asyncpg.Pool:
        if not self._pool:
            self._pool = await asyncpg.create_pool(self.url, min_size=1, max_size=5)
        return self._pool

    async def get_exchange_apis(self, user_id: str) -> Dict[str, Dict]:
        """Returns {market_type: {exchange_name, api_key, api_secret, extra}}"""
        pool = await self._get_pool()
        rows = await pool.fetch(
            """SELECT market_type, exchange_name, api_key_enc, api_secret_enc, extra_fields_enc
               FROM exchange_apis
               WHERE user_id=$1 AND is_active=true""",
            user_id
        )
        result = {}
        for row in rows:
            try:
                result[row["market_type"]] = {
                    "exchange_name": row["exchange_name"],
                    "api_key":       decrypt_field(row["api_key_enc"]),
                    "api_secret":    decrypt_field(row["api_secret_enc"]),
                    "extra":         {},
                }
            except Exception as e:
                logger.error(f"Failed to decrypt API keys for user {user_id}: {e}")
        return result

    async def get_risk_settings(self, user_id: str) -> Dict:
        pool = await self._get_pool()
        row  = await pool.fetchrow(
            "SELECT * FROM risk_settings WHERE user_id=$1", user_id
        )
        if not row:
            return {}
        return dict(row)

    async def save_signal(self, user_id: str, algo_name: str, market_type: str,
                          symbol: str, signal: str, indicators: Dict = None):
        pool = await self._get_pool()
        await pool.execute(
            """INSERT INTO algo_signals
               (user_id, market_type, symbol, signal, algo_name, indicators_snapshot, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            user_id, market_type, symbol, signal, algo_name,
            str(indicators or {}), datetime.utcnow()
        )

    async def save_paper_trade(self, user_id: str, symbol: str, side: str,
                                quantity: float, price: float, algo_name: str,
                                market_type: str):
        pool = await self._get_pool()
        await pool.execute(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, status, algo_used, is_paper, opened_at)
               VALUES ($1,'paper',$2,$3,$4,$5,$6,'open',$7,true,$8)""",
            user_id, market_type, symbol, side, str(quantity),
            str(price), algo_name, datetime.utcnow()
        )

    async def save_live_trade(self, user_id: str, symbol: str, side: str,
                               quantity: float, price: float, stop_loss: float,
                               take_profit: float, order_id: str,
                               algo_name: str, market_type: str):
        pool = await self._get_pool()
        await pool.execute(
            """INSERT INTO trades
               (user_id, exchange_name, market_type, symbol, side, quantity,
                entry_price, stop_loss, take_profit, status, algo_used,
                is_paper, exchange_order_id, opened_at)
               VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,'open',$9,false,$10,$11)""",
            user_id, market_type, symbol, side, str(quantity),
            str(price), str(stop_loss), str(take_profit),
            algo_name, order_id, datetime.utcnow()
        )

    async def close_trade(self, order_id: str, exit_price: float, pnl: float):
        pool = await self._get_pool()
        await pool.execute(
            """UPDATE trades
               SET exit_price=$1, pnl=$2, status='closed', closed_at=$3
               WHERE exchange_order_id=$4""",
            str(exit_price), str(pnl), datetime.utcnow(), order_id
        )

    async def update_bot_status(self, user_id: str, status: str,
                                 markets: List[str], error: str = None):
        import json

        pool = await self._get_pool()

        # Make active_markets safe for the DB driver (json/list mismatch in some schemas).
        active_markets = json.dumps(markets)

        await pool.execute(
            """INSERT INTO bot_statuses (user_id, status, active_markets, updated_at)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (user_id) DO UPDATE
               SET status=$2, active_markets=$3, updated_at=$4, error_message=$5""",
            user_id, status, active_markets, datetime.utcnow(), error
        )