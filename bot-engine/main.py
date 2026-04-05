"""
bot-engine/main.py — REVISED v4
=================================
Changes from v3:
  1. StartRequest now accepts optional session_ids dict so the Next.js
     start route can pass real DB session UUIDs to the scheduler.
     The scheduler uses these as session_ref for trade ownership tracking.

  2. Auto-restart on startup still works (no session_ids on watchdog restart —
     falls back to "userId:market" placeholder which is fine for auto-restart
     because reconciliation still restores open positions correctly).

  3. Self-ping every 60s to keep Render free tier warm.
"""

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict
import os
import logging
import asyncio
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] — %(message)s",
)
logger = logging.getLogger(__name__)

BOT_SECRET = os.getenv("BOT_ENGINE_SECRET", "")

_db        = None
_scheduler = None
_watchdog  = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _scheduler, _watchdog

    from db import Database
    from scheduler import BotScheduler
    from workers.watchdog import Watchdog

    logger.info("🚀 AlgoBot Engine v4 starting up…")

    _db        = Database()
    _scheduler = BotScheduler(_db)
    _watchdog  = Watchdog(_scheduler, _db)

    # ── Step 1: Clean up stale sessions from previous run ─────────────────────
    try:
        cleaned = await _db.cleanup_stale_sessions()
        if cleaned:
            logger.info(f"🧹 Startup: reset {cleaned} stale running session(s)")
    except Exception as e:
        logger.warning(f"⚠️  Startup cleanup failed (non-fatal): {e}")

    _scheduler.start()
    asyncio.create_task(_watchdog.run(), name="watchdog")

    # ── Step 2: Auto-restart bots that were running before this restart ────────
    try:
        running_bots = await _db.get_running_user_bots()
        if running_bots:
            logger.info(
                f"♻️  Found {len(running_bots)} bot(s) to auto-restart after startup"
            )
            for user_id, markets in running_bots.items():
                logger.info(
                    f"♻️  Auto-restarting bot user={user_id[:8]}… markets={markets}"
                )
                # No session_ids on auto-restart — scheduler falls back to
                # "userId:market" placeholder, which is fine. New sessions
                # will be created by the start route next time the user starts
                # manually, and the DB sync will restore any open positions.
                asyncio.create_task(
                    _safe_auto_restart(_scheduler, _db, user_id, markets),
                    name=f"auto_restart_{user_id}",
                )
        else:
            logger.info("♻️  No bots to auto-restart — clean startup")
    except Exception as e:
        logger.warning(f"⚠️  Auto-restart check failed (non-fatal): {e}")

    # ── Step 3: Self-ping loop to keep Render free tier alive ─────────────────
    engine_url = os.getenv("BOT_ENGINE_URL", "")
    if engine_url:
        asyncio.create_task(_self_ping_loop(engine_url), name="self_ping")

    logger.info("✅ AlgoBot Engine v4 ready")
    yield

    logger.info("🛑 Shutting down…")
    if _watchdog:  _watchdog.stop()
    if _scheduler: await _scheduler.stop_all(); _scheduler.shutdown()
    if _db:        await _db.close()
    logger.info("✅ Shutdown complete")


async def _safe_auto_restart(scheduler, db, user_id: str, markets: List[str]):
    """
    Wraps start_user_bot in error handling so one failed restart doesn't
    block others. On failure, marks the bot as stopped.
    """
    try:
        await asyncio.sleep(2)
        # No session_ids for auto-restart — the scheduler falls back gracefully
        await scheduler.start_user_bot(user_id, markets)
        logger.info(
            f"✅ Auto-restart succeeded user={user_id[:8]}… markets={markets}"
        )
    except Exception as e:
        logger.error(
            f"❌ Auto-restart failed user={user_id[:8]}…: {e}", exc_info=True
        )
        try:
            await db.update_bot_status(user_id, "stopped", [])
        except Exception as db_err:
            logger.error(f"❌ Could not update status after failed restart: {db_err}")


async def _self_ping_loop(base_url: str):
    """Pings /health every 60 seconds to keep Render free tier warm."""
    import httpx
    await asyncio.sleep(30)
    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{base_url}/health")
                logger.debug(f"💓 Self-ping {r.status_code}")
        except Exception as e:
            logger.warning(f"💓 Self-ping failed: {e}")
        await asyncio.sleep(60)


app = FastAPI(title="AlgoBot Engine", version="4.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _verify(x_bot_secret: str = Header(...)):
    if not BOT_SECRET or x_bot_secret != BOT_SECRET:
        raise HTTPException(status_code=401, detail="Invalid bot secret")


# ── Schemas ────────────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    user_id:     str
    markets:     List[str]
    # Real DB session UUIDs passed from Next.js /api/bot/start.
    # Used as session_ref for trade ownership tracking.
    # Optional for backwards compatibility with watchdog auto-restart.
    session_ids: Optional[Dict[str, str]] = None

class StopRequest(BaseModel):
    user_id: str

class DrainRequest(BaseModel):
    user_id: str

class CloseAllRequest(BaseModel):
    user_id: str

class BacktestRequest(BaseModel):
    user_id: str
    market_type: str
    asset: str
    timeframe: str
    date_from: str
    date_to: str
    initial_capital: float
    execution_mode: str
    position_mode: str = "NET"
    allow_hedge_opposition: bool = False
    strategy_keys: List[str]


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "AlgoBot Engine running 🚀", "version": "4.0.0"}

@app.api_route("/health", methods=["GET", "HEAD"])
async def health():
    try:
        running = len(_scheduler.active_bots) if _scheduler else 0
        markets = _scheduler.get_all_active_markets() if _scheduler else []
    except Exception:
        running, markets = 0, []
    return {"status": "ok", "running_bots": running, "active_markets": markets}


@app.post("/bot/start", dependencies=[Depends(_verify)])
async def start_bot(req: StartRequest):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    if _scheduler.is_running(req.user_id):
        return {"status": "already_running", "user_id": req.user_id}
    try:
        # Pass session_ids so the scheduler uses real DB UUIDs as session_ref.
        # Falls back to "userId:market" if not provided (auto-restart case).
        await _scheduler.start_user_bot(
            req.user_id,
            req.markets,
            session_ids=req.session_ids,
        )
    except Exception as e:
        logger.error(f"start_bot failed user={req.user_id}: {e}", exc_info=True)
        raise HTTPException(500, str(e))
    return {
        "status":      "started",
        "user_id":     req.user_id,
        "markets":     req.markets,
        "session_ids": req.session_ids,
    }


@app.post("/bot/stop", dependencies=[Depends(_verify)])
async def stop_bot(req: StopRequest):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    await _scheduler.stop_user_bot(req.user_id)
    return {"status": "stopped", "user_id": req.user_id}


@app.post("/bot/drain", dependencies=[Depends(_verify)])
async def drain_bot(req: DrainRequest):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    await _scheduler.enter_drain_mode(req.user_id)
    return {"status": "draining", "user_id": req.user_id}


@app.post("/bot/close-all", dependencies=[Depends(_verify)])
async def close_all_bot(req: CloseAllRequest):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    try:
        await _scheduler.start_close_all(req.user_id)
    except Exception as e:
        logger.error(f"close_all failed user={req.user_id}: {e}", exc_info=True)
        raise HTTPException(500, str(e))
    return {"status": "closing_all", "user_id": req.user_id}


@app.post("/bot/stop-all", dependencies=[Depends(_verify)])
async def stop_all():
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    await _scheduler.stop_all()
    return {"status": "all_stopped"}


@app.get("/bot/status/{user_id}", dependencies=[Depends(_verify)])
async def bot_status(user_id: str):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    return _scheduler.get_status(user_id)


@app.post("/backtests/run", dependencies=[Depends(_verify)])
async def run_backtest_endpoint(req: BacktestRequest):
    from datetime import datetime, timezone

    from exchange_connector import ExchangeConnector
    from strategy_engine import run_backtest, timeframe_to_millis

    if not _db:
        raise HTTPException(500, "Database not initialized")

    exchange_configs = await _db.get_exchange_apis(req.user_id)
    cfg = exchange_configs.get(req.market_type)
    if not cfg:
        raise HTTPException(400, f"No exchange API configured for market {req.market_type}")

    connector = ExchangeConnector(
        exchange_name=cfg["exchange_name"],
        api_key=cfg["api_key"],
        api_secret=cfg["api_secret"],
        extra=cfg.get("extra", {}),
        market_type=req.market_type,
    )

    try:
        start = datetime.fromisoformat(req.date_from.replace("Z", "+00:00"))
        end = datetime.fromisoformat(req.date_to.replace("Z", "+00:00"))
        if end <= start:
            raise HTTPException(400, "date_to must be after date_from")

        candle_ms = timeframe_to_millis(req.timeframe)
        limit = min(max(int(((end - start).total_seconds() * 1000) / candle_ms) + 5, 100), 2000)
        since_ms = int(start.replace(tzinfo=timezone.utc).timestamp() * 1000)
        df = await connector.fetch_ohlcv(req.asset, req.timeframe, limit=limit, since_ms=since_ms)
        result = run_backtest(
            df=df,
            strategy_keys=req.strategy_keys,
            execution_mode=req.execution_mode,
            position_mode=req.position_mode,
            allow_hedge_opposition=req.allow_hedge_opposition,
            initial_capital=req.initial_capital,
        )
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"backtest failed user={req.user_id}: {e}", exc_info=True)
        raise HTTPException(500, str(e))
