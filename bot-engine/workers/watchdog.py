"""
bot-engine/workers/watchdog.py  — v2
=======================================
Watchdog restart counters are tracked in memory per process.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Dict

if TYPE_CHECKING:
    from scheduler import BotScheduler
    from db import Database

logger = logging.getLogger(__name__)

HEARTBEAT_TIMEOUT_SECONDS = 180   # restart bot if no heartbeat for 3 minutes
WATCHDOG_INTERVAL_SECONDS =  60   # check every 60 seconds
MAX_RESTARTS              =   3   # give up after this many consecutive restart attempts
HEALTHY_SUSTAIN_SECONDS   = 300   # require 5 minutes of healthy runtime before reset


class Watchdog:
    def __init__(self, scheduler: "BotScheduler", db: "Database"):
        self._scheduler = scheduler
        self._db = db
        self._running = False
        self._restart_counts: Dict[str, int] = {}

    def stop(self):
        self._running = False

    async def run(self):
        self._running = True
        logger.info(f"🐕 Watchdog running (checks every {WATCHDOG_INTERVAL_SECONDS}s, max restarts={MAX_RESTARTS})")

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

        now = datetime.utcnow()
        timeout = timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)

        for user_id, ctx in contexts.items():
            if ctx.last_heartbeat is None:
                elapsed = now - ctx.started_at
                if elapsed < timeout:
                    continue
            elif (now - ctx.last_heartbeat) < timeout:
                healthy_for = (now - ctx.started_at).total_seconds()
                if healthy_for >= HEALTHY_SUSTAIN_SECONDS:
                    self._restart_counts[user_id] = 0
                logger.debug(
                    f"🐕 {user_id[:8]}… heartbeat OK "
                    f"({int((now - ctx.last_heartbeat).total_seconds())}s ago, "
                    f"healthy_for={int(healthy_for)}s)"
                )
                continue

            current_count = self._restart_counts.get(user_id, 0)

            if current_count >= MAX_RESTARTS:
                logger.error(
                    f"🐕 GIVING UP on user={user_id[:8]}… "
                    f"after {current_count} consecutive restart attempts. "
                    "Marking bot as error — manual intervention required."
                )
                try:
                    await self._db.update_bot_status(
                        user_id, "error", ctx.markets,
                        error=(
                            f"Watchdog gave up after {current_count} restart attempts. "
                            "Check exchange API keys and logs."
                        )
                    )
                    await self._scheduler.stop_user_bot(user_id)
                except Exception as e:
                    logger.error(f"🐕 Failed to mark error state for {user_id[:8]}…: {e}")
                self._restart_counts[user_id] = 0
                continue

            since = ctx.last_heartbeat or ctx.started_at
            logger.warning(
                f"🐕 DEAD BOT DETECTED user={user_id[:8]}… "
                f"last heartbeat {int((now - since).total_seconds())}s ago — "
                f"restarting (attempt {current_count + 1}/{MAX_RESTARTS})"
            )

            new_count = current_count + 1
            self._restart_counts[user_id] = new_count

            try:
                markets = ctx.markets
                await self._scheduler.stop_user_bot(user_id)
                await asyncio.sleep(2)
                # Use the current time as the restarted bot's `started_at`
                # so the watchdog doesn't immediately treat an old
                # `started_at` (from previous runs) as a missing heartbeat
                # and trigger another restart loop.
                await self._scheduler.start_user_bot(
                    user_id,
                    markets,
                    started_at=now,
                )
                logger.info(
                    f"🐕 Bot restarted for user={user_id[:8]}… markets={markets} "
                    f"(attempt {new_count}/{MAX_RESTARTS})"
                )
                self._restart_counts[user_id] = 0
            except Exception as e:
                logger.error(
                    f"🐕 Restart attempt {new_count} failed for user={user_id[:8]}…: {e}",
                    exc_info=True,
                )
                await self._db.update_bot_status(
                    user_id, "error", ctx.markets,
                    error=f"Watchdog restart attempt {new_count} failed: {e}"
                )
