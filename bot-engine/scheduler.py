"""
bot-engine/scheduler.py — v5
==============================
Changes from v4:

FIX K (Risk state persistence):
  start_user_bot() now calls await risk_mgr.load_state(db, user_id, market)
  for each market BEFORE creating algo instances. This restores daily_loss
  and open_trade_count from the DB so a restarted bot picks up where it
  left off rather than resetting to zero.

  Each market gets its own RiskManager instance now (previously one shared
  instance was created and passed to all algos). This is correct because:
  - daily_loss is tracked per-market (Indian market has different hours/rules)
  - open_trade_count should be per-market (Indian bot at max trades shouldn't
    block Crypto bot from entering)

PERF Q (Duplicate DB queries on start):
  Previously get_exchange_apis() was called in the validation loop AND
  implicitly re-fetched. Now all exchange data is fetched ONCE before the
  loop and filtered in memory.

All other logic from v4 unchanged.
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
    user_id:          str
    markets:          List[str]
    session_ids:      Dict[str, str]         = field(default_factory=dict)
    connectors:       Dict[str, object]      = field(default_factory=dict)
    job_ids:          List[str]              = field(default_factory=list)
    started_at:       datetime               = field(default_factory=datetime.utcnow)
    last_heartbeat:   Optional[datetime]     = None
    close_all_task:   Optional[asyncio.Task] = None
    drain_completing: bool                   = False


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

    def get_all_contexts(self) -> Dict[str, "BotContext"]:
        return dict(self.active_bots)

    # ── Start ──────────────────────────────────────────────────────────────────

    async def start_user_bot(
        self,
        user_id: str,
        markets: List[str],
        session_ids: Optional[Dict[str, str]] = None,
    ):
        logger.info(f"🚀 Starting bot user={user_id} markets={markets}")

        await self._stop_jobs(user_id)

        try:
            # PERF Q: Fetch ALL exchange configs once, filter in memory per market
            # Previously the loop called get_exchange_apis() which does a full
            # SELECT — now it's one query total regardless of how many markets.
            exchange_configs = await self._db.get_exchange_apis(user_id)
            risk_cfg         = await self._db.get_risk_settings(user_id)
            market_modes     = await self._db.get_market_modes(user_id)
            try:
                replay = await self._db.flush_spooled_live_trades(user_id)
                if replay["restored"] or replay["remaining"]:
                    logger.info(
                        f"♻️  Pending live trade replay for user={user_id[:8]}… "
                        f"restored={replay['restored']} remaining={replay['remaining']}"
                    )
            except Exception as e:
                logger.warning(f"⚠️  Could not replay spooled live trades: {e}")

            ctx = BotContext(user_id=user_id, markets=[])
            if session_ids:
                ctx.session_ids = session_ids

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

                paper_mode = market_modes.get(market, True)
                AlgoClass  = ALGO_MAP.get(market, GlobalAlgo)

                real_session_id = (session_ids or {}).get(market)
                session_ref     = real_session_id if real_session_id else f"{user_id}:{market}"

                # FIX K: Create a per-market RiskManager and load its persisted state.
                # Each market has independent daily_loss and open_trade_count.
                # Using a shared RiskManager across markets was incorrect because
                # Indian market max trades shouldn't block Crypto from opening.
                risk_mgr = RiskManager(risk_cfg)
                try:
                    await risk_mgr.load_state(self._db, user_id, market)
                except Exception as e:
                    logger.warning(
                        f"⚠️  Could not load risk state for market={market}: {e}. "
                        "Starting with zero values."
                    )

                algo = AlgoClass(
                    connector=connector,
                    risk_mgr=risk_mgr,
                    db=self._db,
                    user_id=user_id,
                    paper_mode=paper_mode,
                    session_ref=session_ref,
                )
                # Mark risk as already loaded so base_algo doesn't reload on first cycle
                algo._risk_loaded = True

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
                    try:
                        stop_mode = await _scheduler._db.get_bot_stop_mode(_uid)
                        if stop_mode == "graceful":
                            open_count = await _scheduler._db.count_open_trades(_uid)
                            if open_count == 0:
                                ctx = _scheduler.active_bots.get(_uid)
                                if ctx and ctx.drain_completing:
                                    logger.debug(
                                        f"[drain] Completion already in progress for "
                                        f"user={_uid[:8]}… — skipping duplicate"
                                    )
                                    return
                                if ctx:
                                    ctx.drain_completing = True

                                logger.info(
                                    f"✅ Drain complete for user={_uid[:8]}… "
                                    "— all positions closed, stopping now"
                                )

                                # Stop jobs FIRST before DB update to close the race window
                                await _scheduler._stop_jobs(_uid)
                                logger.info(
                                    f"🛑 APScheduler jobs removed for user={_uid[:8]}…"
                                )

                                try:
                                    await _scheduler._db.force_set_status(_uid, "stopped")
                                    logger.info(
                                        f"✅ DB status → stopped for user={_uid[:8]}…"
                                    )
                                except Exception as e:
                                    logger.error(
                                        f"❌ Failed to update DB stop status "
                                        f"for user={_uid[:8]}…: {e}"
                                    )

                                asyncio.create_task(
                                    _scheduler._complete_stop_callback(_uid),
                                    name=f"complete_stop_cb_{_uid}",
                                )

                                clear_ohlcv_cache()

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
                    f"every {interval}s [{'PAPER' if paper_mode else '🔴 LIVE'}] "
                    f"session_ref={session_ref}"
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
        logger.info(
            f"🚿 Drain mode signal received for user={user_id[:8]}… "
            "(algos will read DB next cycle)"
        )

    # ── Close All ──────────────────────────────────────────────────────────────

    async def start_close_all(self, user_id: str):
        logger.info(f"🔴 Starting close_all for user={user_id[:8]}…")

        await self._stop_jobs(user_id)

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

        ctx = self.active_bots.get(user_id)
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
        """
        Notifies Next.js to run bot_sessions cleanup.
        DB status is already set to 'stopped' before this is called.
        This is best-effort for session record cleanup only.
        """
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
                logger.warning(
                    f"⚠️  complete-stop callback failed for {user_id[:8]}… "
                    f"(non-fatal, DB already updated): {e}"
                )

        # Fallback: DB is already stopped, ensure local state is clean
        try:
            await self.stop_user_bot(user_id)
        except Exception as e:
            logger.error(f"❌ Fallback cleanup failed: {e}")
