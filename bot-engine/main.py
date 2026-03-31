"""
bot-engine/main.py — REVISED v2
=================================
Adds:
  POST /bot/drain      → enter graceful stop (no new entries, keep exits)
  POST /bot/close-all  → start CloseAllEngine for user
"""

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
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

    logger.info("🚀 AlgoBot Engine v2 starting up…")

    _db        = Database()
    _scheduler = BotScheduler(_db)
    _watchdog  = Watchdog(_scheduler, _db)

    try:
        cleaned = await _db.cleanup_stale_sessions()
        if cleaned:
            logger.info(f"🧹 Startup: reset {cleaned} stale running session(s)")
    except Exception as e:
        logger.warning(f"⚠️  Startup cleanup failed (non-fatal): {e}")

    _scheduler.start()
    asyncio.create_task(_watchdog.run(), name="watchdog")

    engine_url = os.getenv("BOT_ENGINE_URL", "")
    if engine_url:
        asyncio.create_task(_self_ping_loop(engine_url), name="self_ping")

    logger.info("✅ AlgoBot Engine v2 ready")
    yield

    logger.info("🛑 Shutting down…")
    if _watchdog:  _watchdog.stop()
    if _scheduler: await _scheduler.stop_all(); _scheduler.shutdown()
    if _db:        await _db.close()
    logger.info("✅ Shutdown complete")


async def _self_ping_loop(base_url: str):
    import httpx
    await asyncio.sleep(120)
    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{base_url}/health")
                logger.debug(f"💓 Self-ping {r.status_code}")
        except Exception as e:
            logger.warning(f"💓 Self-ping failed: {e}")
        await asyncio.sleep(600)


app = FastAPI(title="AlgoBot Engine", version="2.1.0", lifespan=lifespan)

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
    user_id: str
    markets: List[str]

class StopRequest(BaseModel):
    user_id: str

class DrainRequest(BaseModel):
    user_id: str

class CloseAllRequest(BaseModel):
    user_id: str


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "AlgoBot Engine running 🚀", "version": "2.1.0"}

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
        await _scheduler.start_user_bot(req.user_id, req.markets)
    except Exception as e:
        logger.error(f"start_bot failed user={req.user_id}: {e}", exc_info=True)
        raise HTTPException(500, str(e))
    return {"status": "started", "user_id": req.user_id, "markets": req.markets}


@app.post("/bot/stop", dependencies=[Depends(_verify)])
async def stop_bot(req: StopRequest):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    await _scheduler.stop_user_bot(req.user_id)
    return {"status": "stopped", "user_id": req.user_id}


@app.post("/bot/drain", dependencies=[Depends(_verify)])
async def drain_bot(req: DrainRequest):
    """
    Enter graceful drain mode: no new entries, keep running exit logic.
    Algo cycles read DB status each time — no in-memory flag needed.
    """
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")
    await _scheduler.enter_drain_mode(req.user_id)
    return {"status": "draining", "user_id": req.user_id}


@app.post("/bot/close-all", dependencies=[Depends(_verify)])
async def close_all_bot(req: CloseAllRequest):
    """
    Immediately market-close all open positions for this user.
    Runs CloseAllEngine as a background task.
    Algo cycles are stopped first.
    """
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