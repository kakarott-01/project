"""
bot-engine/workers/watchdog.py  — v3
=======================================

FIXES from v2:
  1. HEARTBEAT_TIMEOUT_SECONDS raised from 180 → 420.
     Root cause of the infinite-restart loop: the cycle interval is 180s and
     the watchdog timeout was also 180s.  The watchdog fired at the exact same
     moment as the first cycle, before the cycle had a chance to update
     ctx.last_heartbeat, so every bot was considered dead immediately after
     its first cycle.  420s = 2.3× the cycle interval — the bot must now miss
     at least two full cycles before a restart is triggered.

  2. Double grace period for new-context bots (last_heartbeat is None).
     The existing grace `elapsed < timeout` was still the same 180s that the
     cycle fires at.  Changed to `elapsed < timeout * _NEW_BOT_GRACE_MULTIPLIER`
     (2×, so 840s) so a freshly-started bot is never restarted before it has
     had a chance to complete two cycles.

  3. Preserve original started_at on restart.
     Previously start_user_bot was called with `started_at=now`, which wrote
     the restart timestamp into bot_statuses.started_at, making the TopBar
     show "38s" while Bot History (which reads bot_sessions, written once at
     user-initiated start) showed the correct duration.
     Fix: pass `ctx.started_at` — the original start time preserved in the
     BotContext — so the DB never loses the true session origin.

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

# FIX 1: was 180 — equalled the cycle interval, causing a race-condition restart
# on every first cycle.  420s = 2.3× the 180s crypto cycle.
HEARTBEAT_TIMEOUT_SECONDS = 420
WATCHDOG_INTERVAL_SECONDS =  60   # check every 60 seconds
MAX_RESTARTS              =   3   # give up after this many consecutive restart attempts
HEALTHY_SUSTAIN_SECONDS   = 300   # require 5 minutes of healthy runtime before reset

# FIX 2: grace multiplier for bots that haven't produced a heartbeat yet.
# Allows 2 full cycles (2 × 420 = 840s) before considering a new bot dead.
_NEW_BOT_GRACE_MULTIPLIER = 2


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
        logger.info(
            "🐕 Watchdog running (checks every %ds, timeout=%ds, max restarts=%d)",
            WATCHDOG_INTERVAL_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, MAX_RESTARTS,
        )

        while self._running:
            await asyncio.sleep(WATCHDOG_INTERVAL_SECONDS)
            try:
                await self._check()
            except Exception as e:
                logger.error("🐕 Watchdog error (non-fatal): %s", e, exc_info=True)

    async def _check(self):
        contexts = self._scheduler.get_all_contexts()
        if not contexts:
            return

        now = datetime.utcnow()
        timeout = timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
        # FIX 2: wider grace window for bots whose first cycle hasn't fired yet
        grace = timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS * _NEW_BOT_GRACE_MULTIPLIER)

        for user_id, ctx in contexts.items():
            if ctx.last_heartbeat is None:
                # Use last_restart_at — the time THIS execution attempt started.
            # ctx.started_at is the original session time (preserved for TopBar)
            # and can be hours/days old, which would collapse the grace window.
                elapsed = now - ctx.last_restart_at          # WAS: ctx.started_at
                if elapsed < grace:
                    continue
                # Grace expired with no heartbeat at all → treat as dead
            elif (now - ctx.last_heartbeat) < timeout:
                # Active heartbeat within the timeout window
                healthy_for = (now - ctx.last_restart_at).total_seconds()
                if healthy_for >= HEALTHY_SUSTAIN_SECONDS:
                    self._restart_counts[user_id] = 0
                logger.debug(
                    "🐕 %s… heartbeat OK (%ds ago, healthy_for=%ds)",
                    user_id[:8],
                    int((now - ctx.last_heartbeat).total_seconds()),
                    int(healthy_for),
                )
                continue

            current_count = self._restart_counts.get(user_id, 0)

            if current_count >= MAX_RESTARTS:
                logger.error(
                    "🐕 GIVING UP on user=%s… after %d consecutive restart attempts. "
                    "Marking bot as error — manual intervention required.",
                    user_id[:8], current_count,
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
                    logger.error("🐕 Failed to mark error state for %s…: %s", user_id[:8], e)
                self._restart_counts[user_id] = 0
                continue

            since = ctx.last_heartbeat or ctx.started_at
            logger.warning(
                "🐕 DEAD BOT DETECTED user=%s… last heartbeat %ds ago — "
                "restarting (attempt %d/%d)",
                user_id[:8], int((now - since).total_seconds()),
                current_count + 1, MAX_RESTARTS,
            )

            new_count = current_count + 1
            self._restart_counts[user_id] = new_count

            try:
                markets = ctx.markets
                # FIX 3: preserve the ORIGINAL started_at so bot_statuses.started_at
                # is never overwritten with the watchdog-restart timestamp.
                # The TopBar reads started_at from bot_statuses; overwriting it caused
                # the display to reset to "0s" / "38s" on every watchdog restart.
                original_started_at = ctx.started_at

                await self._scheduler.stop_user_bot(user_id)
                await asyncio.sleep(2)
                await self._scheduler.start_user_bot(
                    user_id,
                    markets,
                    started_at=original_started_at,   # FIX 3
                )
                logger.info(
                    "🐕 Bot restarted for user=%s… markets=%s (attempt %d/%d, original_started_at=%s)",
                    user_id[:8], markets, new_count, MAX_RESTARTS,
                    original_started_at.isoformat(),
                )
                self._restart_counts[user_id] = 0
            except Exception as e:
                logger.error(
                    "🐕 Restart attempt %d failed for user=%s…: %s",
                    new_count, user_id[:8], e, exc_info=True,
                )
                await self._db.update_bot_status(
                    user_id, "error", ctx.markets,
                    error=f"Watchdog restart attempt {new_count} failed: {e}"
                )
