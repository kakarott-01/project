"""
bot-engine/workers/watchdog.py
================================
Background watchdog that runs every 60 seconds.

Responsibilities:
1. Detect bots whose heartbeat hasn't updated in > 3 minutes (stuck/dead)
2. Restart them automatically
3. Log health summaries
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from scheduler import BotScheduler
    from db import Database

logger = logging.getLogger(__name__)

HEARTBEAT_TIMEOUT_SECONDS = 180   # restart bot if no heartbeat for 3 minutes
WATCHDOG_INTERVAL_SECONDS =  60   # check every 60 seconds


class Watchdog:
    def __init__(self, scheduler: "BotScheduler", db: "Database"):
        self._scheduler = scheduler
        self._db        = db
        self._running   = False

    def stop(self):
        self._running = False

    async def run(self):
        self._running = True
        logger.info(f"🐕 Watchdog running (checks every {WATCHDOG_INTERVAL_SECONDS}s)")

        while self._running:
            await asyncio.sleep(WATCHDOG_INTERVAL_SECONDS)
            try:
                await self._check()
            except Exception as e:
                logger.error(f"🐕 Watchdog error (non-fatal): {e}", exc_info=True)

    async def _check(self):
        contexts = self._scheduler.get_all_contexts()
        if not contexts:
            return

        now     = datetime.utcnow()
        timeout = timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)

        for user_id, ctx in contexts.items():
            if ctx.last_heartbeat is None:
                # Bot just started — give it 2 full cycles before checking
                elapsed = now - ctx.started_at
                if elapsed < timeout:
                    continue

            elif (now - ctx.last_heartbeat) < timeout:
                # Heartbeat is fresh — all good
                logger.debug(
                    f"🐕 {user_id[:8]}… heartbeat OK "
                    f"({int((now - ctx.last_heartbeat).total_seconds())}s ago)"
                )
                continue

            # Heartbeat is stale — restart the bot
            since = ctx.last_heartbeat or ctx.started_at
            logger.warning(
                f"🐕 DEAD BOT DETECTED user={user_id[:8]}… "
                f"last heartbeat {int((now - since).total_seconds())}s ago — restarting"
            )
            try:
                markets = ctx.markets
                await self._scheduler.stop_user_bot(user_id)
                await asyncio.sleep(2)
                await self._scheduler.start_user_bot(user_id, markets)
                logger.info(f"🐕 Bot restarted for user={user_id[:8]}… markets={markets}")
            except Exception as e:
                logger.error(f"🐕 Restart failed for user={user_id[:8]}…: {e}", exc_info=True)
                await self._db.update_bot_status(
                    user_id, "error", ctx.markets,
                    error=f"Watchdog restart failed: {e}"
                )