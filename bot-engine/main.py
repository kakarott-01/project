"""
bot-engine/main.py
==================
Production-grade FastAPI entry point.
- Lifespan manages startup/shutdown cleanly
- All exchanges closed on shutdown (no resource leaks)
- Self-ping keepalive for Render free tier
- Watchdog detects stuck jobs
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

# ── Globals (set during lifespan) ─────────────────────────────────────────────
_db        = None
_scheduler = None
_watchdog  = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _scheduler, _watchdog

    # Import here so env is loaded first
    from db import Database
    from scheduler import BotScheduler
    from workers.watchdog import Watchdog

    logger.info("🚀 AlgoBot Engine starting up…")

    _db        = Database()
    _scheduler = BotScheduler(_db)
    _watchdog  = Watchdog(_scheduler, _db)

    # ── Step 1: Clean stale sessions (Render killed us last time) ─────────────
    try:
        cleaned = await _db.cleanup_stale_sessions()
        if cleaned:
            logger.info(f"🧹 Startup: reset {cleaned} stale running session(s)")
    except Exception as e:
        logger.warning(f"⚠️  Startup cleanup failed (non-fatal): {e}")

    # ── Step 2: Start scheduler ───────────────────────────────────────────────
    _scheduler.start()
    logger.info("✅ Scheduler started")

    # ── Step 3: Start watchdog as background task ─────────────────────────────
    asyncio.create_task(_watchdog.run(), name="watchdog")
    logger.info("🐕 Watchdog started")

    # ── Step 4: Self-ping to prevent Render spindown ──────────────────────────
    engine_url = os.getenv("BOT_ENGINE_URL", "")
    if engine_url:
        asyncio.create_task(_self_ping_loop(engine_url), name="self_ping")
        logger.info(f"💓 Self-ping started → {engine_url}/health every 10m")

    logger.info("✅ AlgoBot Engine fully ready")

    yield  # ─── Running ───────────────────────────────────────────────────────

    # ── Graceful shutdown ─────────────────────────────────────────────────────
    logger.info("🛑 AlgoBot Engine shutting down…")

    if _watchdog:
        _watchdog.stop()

    if _scheduler:
        await _scheduler.stop_all()   # closes ALL exchange connections
        _scheduler.shutdown()

    if _db:
        await _db.close()

    logger.info("✅ Shutdown complete — all resources released")


async def _self_ping_loop(base_url: str):
    """Ping /health every 10 min to prevent Render free-tier spindown."""
    import httpx
    await asyncio.sleep(120)  # wait 2 min after startup before first ping
    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(f"{base_url}/health")
                logger.debug(f"💓 Self-ping {r.status_code}")
        except Exception as e:
            logger.warning(f"💓 Self-ping failed (non-fatal): {e}")
        await asyncio.sleep(600)  # every 10 min


# ── App factory ───────────────────────────────────────────────────────────────
app = FastAPI(title="AlgoBot Engine", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth ──────────────────────────────────────────────────────────────────────
def _verify(x_bot_secret: str = Header(...)):
    if not BOT_SECRET or x_bot_secret != BOT_SECRET:
        raise HTTPException(status_code=401, detail="Invalid bot secret")


# ── Schemas ───────────────────────────────────────────────────────────────────
class StartRequest(BaseModel):
    user_id: str
    markets: List[str]

class StopRequest(BaseModel):
    user_id: str


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return {"status": "AlgoBot Engine running 🚀", "version": "2.0.0"}


@app.api_route("/health", methods=["GET", "HEAD"])
async def health():
    try:
        running = len(_scheduler.active_bots) if _scheduler else 0
        markets = _scheduler.get_all_active_markets() if _scheduler else []
    except Exception:
        running = 0
        markets = []

    return {
        "status": "ok",
        "running_bots": running,
        "active_markets": markets
    }


@app.post("/bot/start", dependencies=[Depends(_verify)])
async def start_bot(req: StartRequest):
    if not _scheduler:
        raise HTTPException(500, "Scheduler not initialized")

    if _scheduler.is_running(req.user_id):
        logger.info(f"Bot already running for user={req.user_id} — skipping")
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