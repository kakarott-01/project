"""
bot-engine/scheduler.py — REVISED v2
======================================
Key changes from v1:

1. Drain mode read from DB (not in-memory flag).
   _draining set removed. Algos call db.get_bot_stop_mode() directly.
   This survives Render restarts correctly.

2. close_all_task: a separate asyncio Task (not an APScheduler job)
   that runs CloseAllEngine and then calls complete-stop.

3. enter_drain_mode: just logs — actual drain signal is the DB status.
   Algos read DB each cycle.

4. session_ref passed to each algo instance for position ownership.

5. stop_user_bot: cancels any running close_all task for the user.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from db import Database
from exchange_connector import ExchangeConnector, clear_ohlcv_cache
from risk_manager import RiskManager
from close_all_engine import CloseAllEngine
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
    "indian":      60,
    "crypto":     120,
    "commodities": 90,
    "global":     120,
}


@dataclass
class BotContext:
    user_id:         str
    markets:         List[str]
    session_ids:     Dict[str, str]         = field(default_factory=dict)  # market→sessionId
    connectors:      Dict[str, object]      = field(default_factory=dict)  # market→connector
    job_ids:         List[str]              = field(default_factory=list)
    started_at:      datetime               = field(default_factory=datetime.utcnow)
    last_heartbeat:  Optional[datetime]     = None
    close_all_task:  Optional[asyncio.Task] = None


class BotScheduler:
    def __init__(self, db: Database):
        self._db        = db
        self._scheduler = AsyncIOScheduler()
        self.active_bots: Dict[str, BotContext] = {}

    def start(self):
        self._scheduler.start()

    def shutdown(self):
        try:
            self._scheduler.shutdown(wait=False)
        except Exception:
            pass

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

    def get_all_contexts(self) -> Dict[str, BotContext]:
        return dict(self.active_bots)

    # ── Start ──────────────────────────────────────────────────────────────────

    async def start_user_bot(self, user_id: str, markets: List[str]):
        logger.info(f"🚀 Starting bot user={user_id} markets={markets}")

        await self._stop_jobs(user_id)

        try:
            exchange_configs = await self._db.get_exchange_apis(user_id)
            risk_cfg         = await self._db.get_risk_settings(user_id)
            risk_mgr         = RiskManager(risk_cfg)
            market_modes     = await self._db.get_market_modes(user_id)

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
                ctx.connectors[market] = connector

                paper_mode  = market_modes.get(market, True)
                AlgoClass   = ALGO_MAP.get(market, GlobalAlgo)

                # session_ref for ownership tagging: "userId:market"
                # (simplified; in full impl use the actual sessionId from DB)
                session_ref = f"{user_id}:{market}"

                algo = AlgoClass(
                    connector=connector,
                    risk_mgr=risk_mgr,
                    db=self._db,
                    user_id=user_id,
                    paper_mode=paper_mode,
                    session_ref=session_ref,
                )

                interval = MARKET_INTERVAL.get(market, 60)
                job_id   = f"{user_id}_{market}"

                async def _wrapped_cycle(
                    _algo=algo,
                    _uid=user_id,
                    _scheduler=self,
                ):
                    await _algo.run_cycle()
                    now = datetime.utcnow()
                    if _uid in _scheduler.active_bots:
                        _scheduler.active_bots[_uid].last_heartbeat = now
                    try:
                        await _scheduler._db.update_heartbeat(_uid)
                    except Exception as e:
                        logger.warning(f"⚠️  Heartbeat update failed: {e}")

                    # ── Drain completion check ────────────────────────────────
                    # After each cycle, if we are in graceful mode and
                    # open trades = 0, self-stop.
                    try:
                        stop_mode = await _scheduler._db.get_bot_stop_mode(_uid)
                        if stop_mode == "graceful":
                            open_count = await _scheduler._db.count_open_trades(_uid)
                            if open_count == 0:
                                logger.info(
                                    f"✅ Drain complete for user={_uid[:8]}… "
                                    "— all positions closed, stopping"
                                )
                                asyncio.create_task(
                                    _scheduler._complete_stop_callback(_uid),
                                    name=f"complete_stop_{_uid}",
                                )
                    except Exception as e:
                        logger.error(f"❌ Drain completion check error: {e}")

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
                raise RuntimeError("No markets could be started — check exchange API keys")

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

    # ── Drain (graceful stop) ──────────────────────────────────────────────────

    async def enter_drain_mode(self, user_id: str):
        """
        No in-memory state needed — algos read DB stop_mode each cycle.
        This method just logs for observability.
        """
        logger.info(
            f"🚿 Drain mode signal received for user={user_id[:8]}… "
            "(algos will read DB next cycle)"
        )

    # ── Close All (active position closing) ────────────────────────────────────

    async def start_close_all(self, user_id: str):
        """
        Launch CloseAllEngine as a background asyncio Task.
        APScheduler jobs are stopped first so the algo doesn't interfere.
        """
        logger.info(f"🔴 Starting close_all for user={user_id[:8]}…")

        # Stop algo cycles — CloseAllEngine handles position closing directly
        await self._stop_jobs(user_id)

        ctx = self.active_bots.get(user_id)
        if not ctx:
            # Bot context might not exist if this is called after a restart
            # Still run close_all using DB data
            logger.warning(f"[CloseAll] No active context for {user_id[:8]}… — running from DB")

        # Build connector map from DB (handles restart scenario)
        exchange_configs = await self._db.get_exchange_apis(user_id)
        market_modes     = await self._db.get_market_modes(user_id)

        connector_map = {}
        paper_modes   = {}

        for market, cfg in exchange_configs.items():
            try:
                connector = ExchangeConnector(
                    exchange_name=cfg["exchange_name"],
                    api_key=cfg["api_key"],
                    api_secret=cfg["api_secret"],
                    extra=cfg.get("extra", {}),
                    market_type=market,
                )
                connector_map[market] = connector
                paper_modes[market]   = market_modes.get(market, True)
            except Exception as e:
                logger.error(f"[CloseAll] Failed to create connector for {market}: {e}")

        engine = CloseAllEngine(
            user_id=user_id,
            db=self._db,
            connector_map=connector_map,
            paper_modes=paper_modes,
        )

        task = asyncio.create_task(
            engine.run(),
            name=f"close_all_{user_id}",
        )

        if ctx:
            ctx.close_all_task = task

        logger.info(f"🔴 CloseAllEngine task started for user={user_id[:8]}…")

    # ── Stop ───────────────────────────────────────────────────────────────────

    async def stop_user_bot(self, user_id: str):
        logger.info(f"🛑 Stopping bot user={user_id}")

        # Cancel any running close_all task
        ctx = self.active_bots.get(user_id)
        if ctx and ctx.close_all_task and not ctx.close_all_task.done():
            ctx.close_all_task.cancel()
            try:
                await ctx.close_all_task
            except asyncio.CancelledError:
                pass
            logger.info(f"🛑 close_all task cancelled for user={user_id[:8]}…")

        await self._stop_jobs(user_id)
        await self._db.update_bot_status(user_id, "stopped", [])
        clear_ohlcv_cache()
        logger.info(f"✅ Bot stopped user={user_id}")

    async def stop_all(self):
        logger.info("🛑 Stopping all bots…")
        for user_id in list(self.active_bots.keys()):
            try:
                await self.stop_user_bot(user_id)
            except Exception as e:
                logger.error(f"❌ Error stopping user={user_id}: {e}")
        logger.info("✅ All bots stopped")

    # ── Internal ───────────────────────────────────────────────────────────────

    async def _stop_jobs(self, user_id: str):
        ctx = self.active_bots.pop(user_id, None)
        if not ctx:
            return
        for job_id in ctx.job_ids:
            try:
                self._scheduler.remove_job(job_id)
                logger.info(f"  ✂️  Removed job {job_id}")
            except Exception:
                pass

    async def _complete_stop_callback(self, user_id: str):
        """Called when drain detects zero open trades — transitions DB to stopped."""
        import httpx, os
        app_url = os.getenv("NEXT_PUBLIC_APP_URL", "")
        if app_url:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.post(
                        f"{app_url}/api/bot/complete-stop",
                        json={"user_id": user_id},
                        headers={"X-Bot-Secret": os.getenv("BOT_ENGINE_SECRET", "")},
                    )
                    logger.info(f"✅ complete-stop callback succeeded for {user_id[:8]}…")
                    return
            except Exception as e:
                logger.error(f"❌ complete-stop callback failed: {e}")

        # Fallback: update DB directly
        try:
            await self._db.force_set_status(user_id, "stopped")
            await self.stop_user_bot(user_id)
        except Exception as e:
            logger.error(f"❌ Fallback stop also failed: {e}")