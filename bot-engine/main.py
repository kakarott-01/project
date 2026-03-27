from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import os
import logging
from dotenv import load_dotenv
from contextlib import asynccontextmanager

from scheduler import BotScheduler

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

BOT_SECRET = os.getenv("BOT_ENGINE_SECRET", "")

scheduler: BotScheduler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global scheduler
    scheduler = BotScheduler()

    try:
        await scheduler.recover_running_bots()
    except Exception as e:
        logger.error(f"⚠️  Startup recovery failed (non-fatal): {e}")

    yield

    # Graceful shutdown — await properly
    if scheduler:
        await scheduler.stop_all()


app = FastAPI(title="AlgoBot Engine", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_secret(x_bot_secret: str = Header(...)):
    if x_bot_secret != BOT_SECRET:
        raise HTTPException(status_code=401, detail="Invalid bot secret")


class StartRequest(BaseModel):
    user_id: str
    markets: List[str]


class StopRequest(BaseModel):
    user_id: str


@app.get("/")
async def root():
    return {"status": "AlgoBot Engine running 🚀", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health():
    running = len(scheduler.active_jobs) if scheduler else 0
    return {"status": "ok", "running_users": running}


@app.post("/bot/start")
async def start_bot(req: StartRequest, x_bot_secret: str = Header(...)):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    try:
        await scheduler.start_user_bot(req.user_id, req.markets)
    except Exception as e:
        logger.error(f"start_bot error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "started", "user_id": req.user_id, "markets": req.markets}


@app.post("/bot/stop")
async def stop_bot(req: StopRequest, x_bot_secret: str = Header(...)):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    # ✅ FIX: await the async stop (was sync before, causing race condition)
    await scheduler.stop_user_bot(req.user_id)
    return {"status": "stopped", "user_id": req.user_id}


@app.post("/bot/stop-all")
async def stop_all(x_bot_secret: str = Header(...)):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    await scheduler.stop_all()
    return {"status": "all_stopped"}


@app.get("/bot/status/{user_id}")
async def bot_status(user_id: str, x_bot_secret: str = Header(...)):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    return scheduler.get_status(user_id)