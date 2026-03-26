from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import os
from dotenv import load_dotenv
from contextlib import asynccontextmanager

from scheduler import BotScheduler

load_dotenv()

BOT_SECRET = os.getenv("BOT_ENGINE_SECRET", "")

# ✅ GLOBAL scheduler (initialized in lifespan)
scheduler: BotScheduler | None = None


# ── LIFESPAN (FIXES YOUR ISSUE) ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global scheduler
    scheduler = BotScheduler()
    yield
    # optional cleanup


# ── App Setup ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="AlgoBot Engine",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth Helper ──────────────────────────────────────────────────────────────
def verify_secret(x_bot_secret: str = Header(...)):
    if x_bot_secret != BOT_SECRET:
        raise HTTPException(status_code=401, detail="Invalid bot secret")


# ── Models ───────────────────────────────────────────────────────────────────
class StartRequest(BaseModel):
    user_id: str
    markets: List[str]


class StopRequest(BaseModel):
    user_id: str


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "status": "AlgoBot Engine running 🚀",
        "docs": "/docs",
        "health": "/health"
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "running_users": len(scheduler.active_jobs) if scheduler else 0
    }


@app.post("/bot/start")
async def start_bot(
    req: StartRequest,
    background_tasks: BackgroundTasks,
    x_bot_secret: str = Header(...)
):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    background_tasks.add_task(
        scheduler.start_user_bot,
        req.user_id,
        req.markets
    )

    return {
        "status": "starting",
        "user_id": req.user_id,
        "markets": req.markets
    }


@app.post("/bot/stop")
async def stop_bot(
    req: StopRequest,
    x_bot_secret: str = Header(...)
):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    scheduler.stop_user_bot(req.user_id)

    return {
        "status": "stopped",
        "user_id": req.user_id
    }


@app.post("/bot/stop-all")
async def stop_all(x_bot_secret: str = Header(...)):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    scheduler.stop_all()

    return {
        "status": "all_stopped"
    }


@app.get("/bot/status/{user_id}")
async def bot_status(
    user_id: str,
    x_bot_secret: str = Header(...)
):
    verify_secret(x_bot_secret)

    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")

    return scheduler.get_status(user_id)