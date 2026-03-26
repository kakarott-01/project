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
    "indian": IndianMarketsAlgo,
    "crypto": CryptoAlgo,
    "commodities": CommoditiesAlgo,
    "global": GlobalAlgo,
}


class BotScheduler:
    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self.active_jobs: Dict[str, List[str]] = {}
        self.db = Database()

        self.scheduler.start()
        logger.info("✅ BotScheduler started")

    async def start_user_bot(self, user_id: str, markets: List[str]):
        try:
            logger.info(f"🚀 Starting bot for user={user_id} markets={markets}")

            # Stop existing jobs first
            self.stop_user_bot(user_id)
            self.active_jobs[user_id] = []

            # Load configs
            exchange_configs = await self.db.get_exchange_apis(user_id)
            risk_cfg = await self.db.get_risk_settings(user_id)
            risk_mgr = RiskManager(risk_cfg)

            logger.info(f"📊 Exchange configs: {exchange_configs}")

            for market in markets:
                try:
                    cfg = exchange_configs.get(market)

                    if not cfg:
                        logger.warning(f"⚠️ No exchange config for {market}")
                        continue

                    api_key = cfg.get("api_key")
                    api_secret = cfg.get("api_secret")

                    if not api_key or not api_secret:
                        logger.error(f"❌ Missing API keys for {market}")
                        continue

                    exchange_name = cfg.get("exchange_name")
                    extra = cfg.get("extra", {})

                    logger.info(f"🔌 Connecting to {exchange_name} for {market}")

                    connector = ExchangeConnector(
                        exchange_name,
                        api_key,
                        api_secret,
                        extra
                    )

                    AlgoClass = ALGO_MAP.get(market, GlobalAlgo)

                    algo = AlgoClass(
                        connector,
                        risk_mgr,
                        self.db,
                        user_id
                    )

                    interval = 60 if market == "indian" else 30

                    job_id = f"{user_id}_{market}"

                    job = self.scheduler.add_job(
                        algo.run_cycle,
                        trigger=IntervalTrigger(seconds=interval),
                        id=job_id,
                        replace_existing=True,
                        max_instances=1,
                        coalesce=True
                    )

                    self.active_jobs[user_id].append(job_id)

                    logger.info(
                        f"✅ Bot started user={user_id} market={market} interval={interval}s"
                    )

                except Exception as e:
                    logger.error(
                        f"❌ Failed to start market={market} for user={user_id}: {e}",
                        exc_info=True
                    )

            await self.db.update_bot_status(user_id, "running", markets)

        except Exception as e:
            logger.error(f"❌ start_user_bot failed: {e}", exc_info=True)
            await self.db.update_bot_status(user_id, "error", [], str(e))

    def stop_user_bot(self, user_id: str):
        try:
            jobs = self.active_jobs.get(user_id, [])

            for job_id in jobs:
                try:
                    self.scheduler.remove_job(job_id)
                    logger.info(f"🛑 Removed job {job_id}")
                except Exception:
                    pass

            self.active_jobs.pop(user_id, None)

            asyncio.create_task(
                self.db.update_bot_status(user_id, "stopped", [])
            )

            logger.info(f"🛑 Bot stopped for user={user_id}")

        except Exception as e:
            logger.error(f"❌ stop_user_bot error: {e}", exc_info=True)

    def stop_all(self):
        logger.info("🛑 Stopping all bots")
        for user_id in list(self.active_jobs.keys()):
            self.stop_user_bot(user_id)

    def get_status(self, user_id: str) -> dict:
        jobs = self.active_jobs.get(user_id, [])

        return {
            "user_id": user_id,
            "running": len(jobs) > 0,
            "markets": [j.split("_", 1)[1] for j in jobs],
            "job_count": len(jobs),
        }