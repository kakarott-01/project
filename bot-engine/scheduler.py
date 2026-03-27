import asyncio
import logging
from typing import Dict, List
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from exchange_connector import ExchangeConnector
from risk_manager import RiskManager
from algorithms.indian_markets import IndianMarketsAlgo
from algorithms.crypto import CryptoAlgo
from algorithms.commodities import CommoditiesAlgo
from algorithms.global_general import GlobalAlgo
from db import Database

logger = logging.getLogger(__name__)

ALGO_MAP = {
    "indian":      IndianMarketsAlgo,
    "crypto":      CryptoAlgo,
    "commodities": CommoditiesAlgo,
    "global":      GlobalAlgo,
}

MARKET_INTERVAL = {
    "indian":      60,
    "crypto":      30,
    "commodities": 60,
    "global":      120,
}


class BotScheduler:
    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self.active_jobs: Dict[str, List[str]] = {}
        self.db = Database()
        self.scheduler.start()
        logger.info("✅ BotScheduler started")

    # ─────────────────────────────────────────────────────────────────────────

    async def recover_running_bots(self):
        pool = await self.db._get_pool()
        rows = await pool.fetch(
            "SELECT user_id, active_markets FROM bot_statuses WHERE status = 'running'"
        )

        if not rows:
            logger.info("🔄 No running bots to recover")
            return

        logger.info(f"🔄 Recovering {len(rows)} running bot(s) from DB...")

        for row in rows:
            user_id = row["user_id"]
            markets = row["active_markets"]

            if not markets:
                continue

            import json
            if isinstance(markets, str):
                try:
                    markets = json.loads(markets)
                except Exception:
                    markets = []

            if markets:
                logger.info(f"♻️  Recovering bot user={user_id} markets={markets}")
                try:
                    await self.start_user_bot(user_id, markets)
                except Exception as e:
                    logger.error(f"❌ Recovery failed for user={user_id}: {e}", exc_info=True)

    # ─────────────────────────────────────────────────────────────────────────

    async def start_user_bot(self, user_id: str, markets: List[str]):
        try:
            logger.info(f"🚀 Starting bot user={user_id} markets={markets}")

            # Stop any existing jobs first (synchronous — no race condition)
            self._stop_jobs_sync(user_id)
            self.active_jobs[user_id] = []

            exchange_configs = await self.db.get_exchange_apis(user_id)
            risk_cfg = await self.db.get_risk_settings(user_id)
            risk_mgr = RiskManager(risk_cfg)

            started_markets = []

            for market in markets:
                try:
                    cfg = exchange_configs.get(market)

                    if not cfg:
                        logger.warning(f"⚠️  No exchange config for market={market}, skipping")
                        continue

                    api_key    = cfg.get("api_key")
                    api_secret = cfg.get("api_secret")

                    if not api_key or not api_secret:
                        logger.error(f"❌ Missing API keys for market={market}, skipping")
                        continue

                    exchange_name = cfg.get("exchange_name")
                    extra         = cfg.get("extra", {})

                    logger.info(f"🔌 Connecting exchange={exchange_name} market={market}")

                    connector = ExchangeConnector(
                        exchange_name,
                        api_key,
                        api_secret,
                        extra,
                        market_type=market,
                    )

                    AlgoClass = ALGO_MAP.get(market, GlobalAlgo)
                    algo = AlgoClass(connector, risk_mgr, self.db, user_id)

                    interval = MARKET_INTERVAL.get(market, 60)
                    job_id   = f"{user_id}_{market}"

                    self.scheduler.add_job(
                        algo.run_cycle,
                        trigger=IntervalTrigger(seconds=interval),
                        id=job_id,
                        replace_existing=True,
                        max_instances=1,
                        coalesce=True,
                    )

                    self.active_jobs[user_id].append(job_id)
                    started_markets.append(market)
                    logger.info(f"✅ Scheduled market={market} every {interval}s")

                except Exception as e:
                    logger.error(f"❌ Failed to start market={market}: {e}", exc_info=True)

            if started_markets:
                await self.db.update_bot_status(user_id, "running", started_markets)
                logger.info(f"🟢 Bot running for user={user_id} markets={started_markets}")
            else:
                await self.db.update_bot_status(user_id, "error", [], "No markets could be started — check API keys and exchange config")
                logger.error(f"❌ No markets started for user={user_id}")

        except Exception as e:
            logger.error(f"❌ start_user_bot failed: {e}", exc_info=True)
            await self.db.update_bot_status(user_id, "error", [], str(e))
            raise

    # ─────────────────────────────────────────────────────────────────────────

    def _stop_jobs_sync(self, user_id: str):
        """
        Synchronously remove all APScheduler jobs for a user.
        Does NOT update DB — caller is responsible for that.
        """
        jobs = self.active_jobs.get(user_id, [])
        for job_id in jobs:
            try:
                self.scheduler.remove_job(job_id)
                logger.info(f"🛑 Removed job {job_id}")
            except Exception:
                pass  # Job may have already completed or been removed
        self.active_jobs.pop(user_id, None)

    # ─────────────────────────────────────────────────────────────────────────

    async def stop_user_bot(self, user_id: str):
        """
        Async stop: removes jobs synchronously, then awaits DB update.
        Call this from async contexts (e.g. FastAPI route handler).
        """
        try:
            self._stop_jobs_sync(user_id)
            # Await DB update directly — no fire-and-forget task
            await self.db.update_bot_status(user_id, "stopped", [])
            logger.info(f"🛑 Bot stopped for user={user_id}")
        except Exception as e:
            logger.error(f"❌ stop_user_bot error: {e}", exc_info=True)

    # ─────────────────────────────────────────────────────────────────────────

    async def stop_all(self):
        logger.info("🛑 Stopping all bots")
        for user_id in list(self.active_jobs.keys()):
            await self.stop_user_bot(user_id)

    # ─────────────────────────────────────────────────────────────────────────

    def get_status(self, user_id: str) -> dict:
        jobs = self.active_jobs.get(user_id, [])
        return {
            "user_id":   user_id,
            "running":   len(jobs) > 0,
            "markets":   [j.split("_", 1)[1] for j in jobs],
            "job_count": len(jobs),
        }