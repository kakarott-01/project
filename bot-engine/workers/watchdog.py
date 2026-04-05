"""
bot-engine/workers/watchdog.py  — v2
=======================================
FIX: Watchdog restart counter is now persisted to bot_statuses.watchdog_restart_count
     in the DB. Previously it was stored in-memory only, so every Render process
     restart (even on free tier due to OOM, deploy events, or infra maintenance)
     reset the counter to zero, allowing a bot with broken API keys to loop
     indefinitely: crash → Render restart → 3 more attempts → crash → repeat.

     With DB persistence, the counter survives process restarts. It resets
     to zero only when the bot produces a healthy heartbeat.

     REQUIRES DB MIGRATION: ALTER TABLE bot_statuses ADD COLUMN IF NOT EXISTS
       watchdog_restart_count integer NOT NULL DEFAULT 0;
     (Already added to lib/schema.ts in this fix batch.)
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
        self._db        = db
        self._running   = False
        # FIX: In-memory cache of counts — loaded from DB on first check, then kept
        # in sync. DB is the source of truth so process restarts don't reset counts.
        self._restart_counts_cache: Dict[str, int] = {}
        self._counts_loaded: set = set()   # track which user_ids have been loaded from DB

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

    async def _get_restart_count(self, user_id: str) -> int:
        """Load from DB on first access, use cache thereafter."""
        if user_id not in self._counts_loaded:
            try:
                db_count = await self._db.get_watchdog_restart_count(user_id)
                self._restart_counts_cache[user_id] = db_count
                self._counts_loaded.add(user_id)
                if db_count > 0:
                    logger.info(f"🐕 Loaded watchdog restart count from DB: user={user_id[:8]}… count={db_count}")
            except Exception as e:
                logger.warning(f"🐕 Could not load restart count from DB for {user_id[:8]}…: {e}")
                self._restart_counts_cache.setdefault(user_id, 0)
                self._counts_loaded.add(user_id)
        return self._restart_counts_cache.get(user_id, 0)

    async def _set_restart_count(self, user_id: str, count: int):
        """Update in-memory cache and persist to DB."""
        self._restart_counts_cache[user_id] = count
        try:
            await self._db.set_watchdog_restart_count(user_id, count)
        except Exception as e:
            logger.warning(f"🐕 Failed to persist restart count to DB for {user_id[:8]}…: {e}")

    async def _reset_restart_count(self, user_id: str):
        """Reset to zero — called when a healthy heartbeat is observed."""
        if self._restart_counts_cache.get(user_id, 0) == 0:
            return  # already zero, skip DB write
        self._restart_counts_cache[user_id] = 0
        try:
            await self._db.reset_watchdog_restart_count(user_id)
            logger.info(f"🐕 Watchdog restart count reset for user={user_id[:8]}…")
        except Exception as e:
            logger.warning(f"🐕 Failed to reset restart count in DB: {e}")

    async def _check(self):
        contexts = self._scheduler.get_all_contexts()
        if not contexts:
            return

        now     = datetime.utcnow()
        timeout = timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)

        for user_id, ctx in contexts.items():
            if ctx.last_heartbeat is None:
                elapsed = now - ctx.started_at
                if elapsed < timeout:
                    continue

            elif (now - ctx.last_heartbeat) < timeout:
                healthy_for = (now - ctx.started_at).total_seconds()
                if healthy_for >= HEALTHY_SUSTAIN_SECONDS:
                    await self._reset_restart_count(user_id)
                logger.debug(
                    f"🐕 {user_id[:8]}… heartbeat OK "
                    f"({int((now - ctx.last_heartbeat).total_seconds())}s ago, "
                    f"healthy_for={int(healthy_for)}s)"
                )
                continue

            # ── Heartbeat is stale ────────────────────────────────────────────

            current_count = await self._get_restart_count(user_id)

            if current_count >= MAX_RESTARTS:
                logger.error(
                    f"🐕 GIVING UP on user={user_id[:8]}… "
                    f"after {current_count} consecutive restart attempts "
                    f"(counter survived process restarts — this is a persistent failure). "
                    "Marking bot as error — manual intervention required."
                )
                try:
                    await self._db.update_bot_status(
                        user_id, "error", ctx.markets,
                        error=(
                            f"Watchdog gave up after {current_count} restart attempts "
                            f"(persisted across process restarts). "
                            "Check exchange API keys and logs."
                        )
                    )
                    await self._scheduler.stop_user_bot(user_id)
                except Exception as e:
                    logger.error(f"🐕 Failed to mark error state for {user_id[:8]}…: {e}")
                # Reset so the user can manually restart later
                await self._reset_restart_count(user_id)
                # Remove from loaded set so next time it re-reads from DB
                self._counts_loaded.discard(user_id)
                continue

            # Attempt restart
            since = ctx.last_heartbeat or ctx.started_at
            logger.warning(
                f"🐕 DEAD BOT DETECTED user={user_id[:8]}… "
                f"last heartbeat {int((now - since).total_seconds())}s ago — "
                f"restarting (attempt {current_count + 1}/{MAX_RESTARTS})"
            )

            new_count = current_count + 1
            await self._set_restart_count(user_id, new_count)  # FIX: persisted to DB

            try:
                markets = ctx.markets
                await self._scheduler.stop_user_bot(user_id)
                await asyncio.sleep(2)
                await self._scheduler.start_user_bot(user_id, markets)
                logger.info(
                    f"🐕 Bot restarted for user={user_id[:8]}… markets={markets} "
                    f"(attempt {new_count}/{MAX_RESTARTS})"
                )
            except Exception as e:
                logger.error(
                    f"🐕 Restart attempt {new_count} failed for user={user_id[:8]}…: {e}",
                    exc_info=True,
                )
                await self._db.update_bot_status(
                    user_id, "error", ctx.markets,
                    error=f"Watchdog restart attempt {new_count} failed: {e}"
                )
