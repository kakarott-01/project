"""
bot-engine/main.py — REVISED v3
=================================
Changes from v2:
  1. Auto-restart: on startup, any user whose bot_statuses shows
     status='running' gets their bot automatically restarted.
     Survives Render deploys/restarts with zero manual intervention.

  2. Self-ping interval reduced from 600s → 60s to keep free tier warm.

  3. Initial self-ping delay reduced from 120s → 30s.
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

    logger.info("🚀 AlgoBot Engine v3 starting up…")

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
    # This handles Render deploys, free-tier restarts, and crashes.
    # bot_statuses rows with status='running' mean the user had an active bot.
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
                # Use create_task so startup doesn't block waiting for all restarts
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

    logger.info("✅ AlgoBot Engine v3 ready")
    yield

    logger.info("🛑 Shutting down…")
    if _watchdog:  _watchdog.stop()
    if _scheduler: await _scheduler.stop_all(); _scheduler.shutdown()
    if _db:        await _db.close()
    logger.info("✅ Shutdown complete")


async def _safe_auto_restart(scheduler, db, user_id: str, markets: List[str]):
    """
    Wraps start_user_bot in error handling so one failed restart doesn't
    block others. On failure, marks the bot as stopped so the UI reflects
    the real state.
    """
    try:
        await asyncio.sleep(2)  # brief stagger so DB pool is fully ready
        await scheduler.start_user_bot(user_id, markets)
        logger.info(
            f"✅ Auto-restart succeeded user={user_id[:8]}… markets={markets}"
        )
    except Exception as e:
        logger.error(
            f"❌ Auto-restart failed user={user_id[:8]}…: {e}", exc_info=True
        )
        # Mark as stopped so UI doesn't show a phantom "running" state
        try:
            await db.update_bot_status(user_id, "stopped", [])
        except Exception as db_err:
            logger.error(f"❌ Could not update status after failed restart: {db_err}")


async def _self_ping_loop(base_url: str):
    """
    Pings /health every 60 seconds to keep Render free tier from spinning down.
    Initial delay of 30s lets the server fully boot before first ping.
    """
    import httpx
    await asyncio.sleep(30)
    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{base_url}/health")
                logger.debug(f"💓 Self-ping {r.status_code}")
        except Exception as e:
            logger.warning(f"💓 Self-ping failed: {e}")
        await asyncio.sleep(60)  # every 60s — was 600s


app = FastAPI(title="AlgoBot Engine", version="3.0.0", lifespan=lifespan)

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
    return {"status": "AlgoBot Engine running 🚀", "version": "3.0.0"}

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