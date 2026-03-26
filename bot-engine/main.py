from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import os
from dotenv import load_dotenv
from scheduler import BotScheduler

load_dotenv()

# ── App Setup ────────────────────────────────────────────────────────────────
app = FastAPI(title="AlgoBot Engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

scheduler = BotScheduler()
BOT_SECRET = os.getenv("BOT_ENGINE_SECRET", "")

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

# ✅ ROOT ROUTE (fixes your 404)
@app.get("/")
async def root():
    return {
        "status": "AlgoBot Engine running 🚀",
        "docs": "/docs",
        "health": "/health"
    }

# ✅ Health Check
@app.get("/health")
def health():
    return {
        "status": "ok",
        "running_users": len(scheduler.active_jobs)
    }

# ▶️ Start Bot
@app.post("/bot/start")
async def start_bot(
    req: StartRequest,
    background_tasks: BackgroundTasks,
    x_bot_secret: str = Header(...)
):
    verify_secret(x_bot_secret)

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

# ⏹ Stop Bot
@app.post("/bot/stop")
async def stop_bot(
    req: StopRequest,
    x_bot_secret: str = Header(...)
):
    verify_secret(x_bot_secret)

    scheduler.stop_user_bot(req.user_id)

    return {
        "status": "stopped",
        "user_id": req.user_id
    }

# ⏹ Stop All Bots
@app.post("/bot/stop-all")
async def stop_all(x_bot_secret: str = Header(...)):
    verify_secret(x_bot_secret)

    scheduler.stop_all()

    return {
        "status": "all_stopped"
    }

# 📊 Bot Status
@app.get("/bot/status/{user_id}")
async def bot_status(
    user_id: str,
    x_bot_secret: str = Header(...)
):
    verify_secret(x_bot_secret)

    return scheduler.get_status(user_id)

# ── Run Server ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=False
    )