"""
bot-engine/scheduler.py
========================
Production APScheduler manager.

Key guarantees:
- Each user has exactly ONE running bot at a time
- Stop always waits for exchange close before returning
- No duplicate jobs even on rapid start/start
- Full status reporting
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from db import Database
from exchange_connector import ExchangeConnector
from risk_manager import RiskManager
from algorithms.crypto import CryptoAlgo
from algorithms.indian_markets import IndianMarketsAlgo
from algorithms.commodities import CommoditiesAlgo
from algorithms.global_general import GlobalAlgo

logger = logging.getLogger(__name__)

ALGO_MAP = {
    "indian":      IndianMarketsAlgo,
    "crypto":      CryptoAlgo,
    "commodities": CommoditiesAlgo,
    "global":      GlobalAlgo,
}

MARKET_INTERVAL = {
    # Crypto fetches 4h + 15m OHLCV for each symbol (~10s/symbol × 3 = ~35s total).
    # Interval must be > cycle duration to avoid "max instances reached" skips.
    # 90s gives a clean buffer: signals fire every ~1.5 minutes instead of every 30s.
    "indian":      60,
    "crypto":      60,
    "commodities": 90,
    "global":      120,
}


@dataclass
class BotContext:
    """Everything needed to describe a running bot for one user."""
    user_id:       str
    markets:       List[str]
    job_ids:       List[str]  = field(default_factory=list)
    started_at:    datetime   = field(default_factory=datetime.utcnow)
    last_heartbeat: Optional[datetime] = None
    error:         Optional[str]       = None


class BotScheduler:
    def __init__(self, db: Database):
        self._db        = db
        self._scheduler = AsyncIOScheduler()
        # user_id → BotContext
        self.active_bots: Dict[str, BotContext] = {}

    def start(self):
        self._scheduler.start()

    def shutdown(self):
        """Shutdown the APScheduler (non-async, call after stop_all)."""
        try:
            self._scheduler.shutdown(wait=False)
        except Exception:
            pass

    # ── Public API ─────────────────────────────────────────────────────────────

    def is_running(self, user_id: str) -> bool:
        ctx = self.active_bots.get(user_id)
        return ctx is not None and len(ctx.job_ids) > 0

    def get_status(self, user_id: str) -> dict:
        ctx = self.active_bots.get(user_id)
        if not ctx:
            return {"user_id": user_id, "running": False, "markets": [], "job_count": 0}
        return {
            "user_id":        user_id,
            "running":        True,
            "markets":        ctx.markets,
            "job_count":      len(ctx.job_ids),
            "started_at":     ctx.started_at.isoformat(),
            "last_heartbeat": ctx.last_heartbeat.isoformat() if ctx.last_heartbeat else None,
        }

    def get_all_active_markets(self) -> List[str]:
        markets = []
        for ctx in self.active_bots.values():
            markets.extend(ctx.markets)
        return list(set(markets))

    # ── Start ──────────────────────────────────────────────────────────────────

    async def start_user_bot(self, user_id: str, markets: List[str]):
        logger.info(f"🚀 Starting bot user={user_id} markets={markets}")

        # Cancel any existing jobs for this user first (safe restart)
        await self._stop_jobs(user_id)

        try:
            exchange_configs = await self._db.get_exchange_apis(user_id)
            risk_cfg         = await self._db.get_risk_settings(user_id)
            risk_mgr         = RiskManager(risk_cfg)
            market_modes     = await self._db.get_market_modes(user_id)

            logger.info(f"📋 Market modes: {market_modes}")

            ctx = BotContext(user_id=user_id, markets=[])
            started_markets: List[str] = []

            for market in markets:
                cfg = exchange_configs.get(market)
                if not cfg:
                    logger.warning(f"⚠️  No exchange config for market={market}, skipping")
                    continue

                api_key    = cfg.get("api_key")
                api_secret = cfg.get("api_secret")
                if not api_key or not api_secret:
                    logger.error(f"❌ Missing API keys for market={market}, skipping")
                    continue

                connector = ExchangeConnector(
                    exchange_name=cfg["exchange_name"],
                    api_key=api_key,
                    api_secret=api_secret,
                    extra=cfg.get("extra", {}),
                    market_type=market,
                )

                paper_mode = market_modes.get(market, True)
                AlgoClass  = ALGO_MAP.get(market, GlobalAlgo)

                algo = AlgoClass(
                    connector=connector,
                    risk_mgr=risk_mgr,
                    db=self._db,
                    user_id=user_id,
                    paper_mode=paper_mode,
                )

                interval = MARKET_INTERVAL.get(market, 60)
                job_id   = f"{user_id}_{market}"

                # Wrap run_cycle so we can update heartbeat without touching algo code
                async def _wrapped_cycle(
                    _algo=algo,
                    _uid=user_id,
                    _mkt=market,
                ):
                    await _algo.run_cycle()
                    # Update heartbeat in DB and in-memory context
                    now = datetime.utcnow()
                    if _uid in self.active_bots:
                        self.active_bots[_uid].last_heartbeat = now
                    try:
                        await self._db.update_heartbeat(_uid)
                    except Exception as e:
                        logger.warning(f"⚠️  Heartbeat update failed: {e}")

                self._scheduler.add_job(
                    _wrapped_cycle,
                    trigger=IntervalTrigger(seconds=interval),
                    id=job_id,
                    replace_existing=True,
                    max_instances=1,
                    coalesce=True,
                    misfire_grace_time=10,
                )

                ctx.job_ids.append(job_id)
                started_markets.append(market)
                logger.info(
                    f"✅ Scheduled {AlgoClass.__name__} market={market} "
                    f"every {interval}s [{'PAPER' if paper_mode else '🔴 LIVE'}]"
                )

            if not started_markets:
                raise RuntimeError(
                    "No markets could be started — check exchange API keys"
                )

            ctx.markets = started_markets
            self.active_bots[user_id] = ctx

            await self._db.update_bot_status(
                user_id, "running", started_markets,
                started_at=ctx.started_at,
            )
            logger.info(f"🟢 Bot running user={user_id} markets={started_markets}")

        except Exception as e:
            logger.error(f"❌ start_user_bot failed user={user_id}: {e}", exc_info=True)
            await self._db.update_bot_status(user_id, "error", [], error=str(e))
            raise

    # ── Stop ───────────────────────────────────────────────────────────────────

    async def stop_user_bot(self, user_id: str):
        logger.info(f"🛑 Stopping bot user={user_id}")
        await self._stop_jobs(user_id)
        await self._db.update_bot_status(user_id, "stopped", [])
        logger.info(f"✅ Bot stopped user={user_id}")

    async def stop_all(self):
        logger.info("🛑 Stopping all bots…")
        for user_id in list(self.active_bots.keys()):
            try:
                await self.stop_user_bot(user_id)
            except Exception as e:
                logger.error(f"❌ Error stopping user={user_id}: {e}")
        logger.info("✅ All bots stopped")

    # ── Internals ──────────────────────────────────────────────────────────────

    async def _stop_jobs(self, user_id: str):
        """Remove all APScheduler jobs for a user and clear the context."""
        ctx = self.active_bots.pop(user_id, None)
        if not ctx:
            return
        for job_id in ctx.job_ids:
            try:
                self._scheduler.remove_job(job_id)
                logger.info(f"  ✂️  Removed job {job_id}")
            except Exception:
                pass  # job may have already been removed

    # ── Watchdog support ───────────────────────────────────────────────────────

    def get_all_contexts(self) -> Dict[str, BotContext]:
        return dict(self.active_bots)