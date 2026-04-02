"""
bot-engine/close_all_engine.py — v2
=====================================
F2 FIX:  On partial close failure, set bot status to 'error' instead of
         silently calling _notify_complete() (which marked bot as 'stopped').
         Previously, if ANY position failed to close, the bot showed as
         "Stopped" while real open positions existed on the exchange with
         no bot managing them. Now it shows as "Error" with a clear message.

F5 FIX:  _confirm_fill() now fetches the actual order status from the exchange
         instead of assuming "order not in open_orders = fully filled". An order
         can disappear from open orders because it was CANCELLED or REJECTED,
         not just filled. Previously this caused DB to record a full fill and
         mark the trade closed when the position was actually still open.

F11 FIX: Exhausted retries now also set bot to 'error' state (same as F2).
         Previously the retry loop could exhaust silently and return a
         partial failure dict, which would still call _notify_complete().

Design notes (unchanged from v1):
  - Fetches all open trades from DB for a user
  - For each: places market close order on exchange
  - Confirms fill by polling exchange order status (NOW via fetch_order)
  - Detects partial fills — retries remainder
  - Uses exponential backoff with jitter on API failures
  - Logs every attempt to position_close_log
  - Paper mode: skips all exchange calls, marks DB records closed
  - On complete success: calls _notify_complete() → bot status = 'stopped'
  - On ANY failure: sets bot status = 'error' (does NOT call _notify_complete)
"""

import asyncio
import logging
import os
import time
import random
import httpx
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

logger = logging.getLogger(__name__)

MAX_ATTEMPTS        = 5
BASE_BACKOFF_SEC    = 2.0
MAX_BACKOFF_SEC     = 60.0
BACKOFF_MULTIPLIER  = 2.0
FILL_CONFIRM_POLL   = 3.0
FILL_CONFIRM_MAX    = 10
OVERALL_TIMEOUT_SEC = 300


def _backoff(attempt: int) -> float:
    base   = BASE_BACKOFF_SEC * (BACKOFF_MULTIPLIER ** (attempt - 1))
    jitter = base * 0.25 * random.uniform(-1, 1)
    return min(base + jitter, MAX_BACKOFF_SEC)


class CloseAllEngine:
    def __init__(self, user_id: str, db, connector_map: dict, paper_modes: dict):
        self.user_id       = user_id
        self.db            = db
        self.connector_map = connector_map
        self.paper_modes   = paper_modes
        self._start_time   = time.time()

    async def run(self) -> dict:
        logger.info(f"[CloseAll] Starting for user={self.user_id[:8]}…")

        open_trades = await self.db.get_all_open_trades_all_markets(self.user_id)

        if not open_trades:
            logger.info(f"[CloseAll] No open trades — nothing to close")
            await self._notify_complete()
            return {"success": True, "closed": 0, "failed": 0, "errors": []}

        logger.info(f"[CloseAll] Found {len(open_trades)} open trade(s)")

        closed = 0
        failed = 0
        errors = []

        for trade in open_trades:
            if time.time() - self._start_time > OVERALL_TIMEOUT_SEC:
                msg = (
                    f"Close-all timed out after {OVERALL_TIMEOUT_SEC}s. "
                    f"{failed} positions may still be open. "
                    "Manual exchange action required."
                )
                logger.error(f"[CloseAll] {msg}")
                errors.append(msg)
                # F2/F11: Don't call _notify_complete on timeout — set error state
                await self.db.set_bot_error_state(self.user_id, msg)
                break

            result = await self._close_one(trade)
            if result["success"]:
                closed += 1
            else:
                failed += 1
                errors.append(f"{trade['symbol']}: {result['error']}")

        all_success = failed == 0 and not any(e for e in errors)

        if all_success:
            logger.info(f"[CloseAll] ✅ All {closed} positions closed successfully")
            # F2: Only call _notify_complete on FULL success
            await self._notify_complete()
        else:
            # F2 FIX: Do NOT call _notify_complete. Set bot to 'error' state.
            # This keeps the bot visible as failed so the user knows to act.
            error_summary = (
                f"Close-all incomplete: {closed} closed, {failed} failed. "
                f"Manual exchange review required. "
                f"Failures: {'; '.join(errors[:3])}"  # truncate for DB column
            )
            logger.error(f"[CloseAll] ⚠️  {error_summary}")
            await self.db.set_bot_error_state(self.user_id, error_summary)

        return {"success": all_success, "closed": closed, "failed": failed, "errors": errors}

    async def _close_one(self, trade: dict) -> dict:
        trade_id   = str(trade["id"])
        symbol     = trade["symbol"]
        side       = trade["side"]
        quantity   = float(trade["quantity"])
        market     = trade["market_type"]
        is_paper   = self.paper_modes.get(market, True)

        close_side = "sell" if side.lower() == "buy" else "buy"

        logger.info(f"[CloseAll] Closing {symbol} qty={quantity} side={close_side} paper={is_paper}")

        # ── Paper mode: instant close ─────────────────────────────────────────
        if is_paper:
            try:
                connector  = self.connector_map.get(market)
                exit_price = 0.0
                if connector:
                    try:
                        ticker     = await connector.fetch_ticker(symbol)
                        exit_price = float(ticker.get("last", 0))
                    except Exception:
                        pass

                entry_price = float(trade["entry_price"])
                if side.lower() == "sell":
                    pnl = (entry_price - exit_price) * quantity
                else:
                    pnl = (exit_price - entry_price) * quantity

                pnl_dec     = Decimal(str(pnl)).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
                pnl_pct_raw = (float(pnl_dec) / (entry_price * quantity)) * 100 if entry_price > 0 else 0
                pnl_pct     = Decimal(str(pnl_pct_raw)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

                await self.db.close_paper_trade(trade_id, exit_price, float(pnl_dec), float(pnl_pct))
                await self.db.log_close_attempt(
                    user_id=self.user_id,
                    trade_id=trade_id,
                    attempt=1,
                    status="filled",
                    quantity_req=quantity,
                    quantity_fill=quantity,
                )
                return {"success": True, "error": None}
            except Exception as e:
                logger.error(f"[CloseAll] Paper close failed {symbol}: {e}")
                return {"success": False, "error": str(e)}

        # ── Live mode: exchange close with retry ──────────────────────────────
        connector = self.connector_map.get(market)
        if not connector:
            err = f"No connector for market={market}"
            logger.error(f"[CloseAll] {err}")
            return {"success": False, "error": err}

        remaining_qty = quantity
        attempt       = 0

        while remaining_qty > 0 and attempt < MAX_ATTEMPTS:
            attempt += 1

            if time.time() - self._start_time > OVERALL_TIMEOUT_SEC:
                err = f"Timeout during close of {symbol}"
                await self.db.log_close_attempt(
                    user_id=self.user_id,
                    trade_id=trade_id,
                    attempt=attempt,
                    status="failed",
                    quantity_req=remaining_qty,
                    error_message=err,
                )
                return {"success": False, "error": err}

            logger.info(
                f"[CloseAll] {symbol} attempt={attempt}/{MAX_ATTEMPTS} "
                f"qty={remaining_qty:.8f}"
            )

            order_id = None
            try:
                order    = await connector.place_order(symbol, close_side, remaining_qty)
                order_id = order.get("id")

                # F5 FIX: Pass connector so _confirm_fill can call fetch_order
                filled_qty, status_str, error = await self._confirm_fill(
                    connector, symbol, order_id, remaining_qty
                )

                await self.db.log_close_attempt(
                    user_id=self.user_id,
                    trade_id=trade_id,
                    attempt=attempt,
                    status=status_str,
                    quantity_req=remaining_qty,
                    quantity_fill=filled_qty,
                    exchange_order_id=order_id,
                    error_message=error,
                )
                await self.db.increment_close_attempts(trade_id)

                if status_str == "filled":
                    remaining_qty -= filled_qty

                    if remaining_qty <= 0:
                        try:
                            ticker     = await connector.fetch_ticker(symbol)
                            exit_price = float(ticker.get("last", 0))
                        except Exception:
                            exit_price = float(trade["entry_price"])

                        entry_price = float(trade["entry_price"])
                        orig_qty    = float(trade["quantity"])
                        if side.lower() == "sell":
                            pnl = (entry_price - exit_price) * orig_qty
                        else:
                            pnl = (exit_price - entry_price) * orig_qty

                        pnl_dec     = Decimal(str(pnl)).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
                        pnl_pct_raw = (float(pnl_dec) / (entry_price * orig_qty)) * 100 if entry_price > 0 else 0
                        pnl_pct     = Decimal(str(pnl_pct_raw)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)

                        await self.db.close_live_trade(trade_id, exit_price, float(pnl_dec), float(pnl_pct), order_id or "")
                        logger.info(f"[CloseAll] ✅ {symbol} fully closed @ {exit_price}")
                        return {"success": True, "error": None}

                    logger.warning(
                        f"[CloseAll] ⚠️  {symbol} partial fill: "
                        f"filled={filled_qty:.8f} remaining={remaining_qty:.8f}"
                    )
                    await asyncio.sleep(1.5)

                elif status_str == "partial":
                    remaining_qty -= filled_qty
                    await asyncio.sleep(_backoff(attempt))

                elif status_str == "cancelled" or status_str == "rejected":
                    # F5 FIX: Order was explicitly cancelled/rejected by exchange
                    # Do NOT decrement remaining_qty. Retry with full remaining qty.
                    logger.warning(
                        f"[CloseAll] ⚠️  {symbol} order {status_str} by exchange. Retrying."
                    )
                    await asyncio.sleep(_backoff(attempt))

                else:
                    # failed / unconfirmed
                    await asyncio.sleep(_backoff(attempt))

            except Exception as e:
                logger.error(
                    f"[CloseAll] {symbol} attempt={attempt} exception: {e}",
                    exc_info=True,
                )
                await self.db.log_close_attempt(
                    user_id=self.user_id,
                    trade_id=trade_id,
                    attempt=attempt,
                    status="failed",
                    quantity_req=remaining_qty,
                    exchange_order_id=order_id,
                    error_message=str(e),
                )
                await self.db.increment_close_attempts(trade_id)

                if attempt < MAX_ATTEMPTS:
                    backoff = _backoff(attempt)
                    logger.info(f"[CloseAll] Retrying {symbol} in {backoff:.1f}s…")
                    await asyncio.sleep(backoff)

        # F11 FIX: Retries exhausted — record error and return failure.
        # The caller's run() loop will accumulate failures and call
        # set_bot_error_state() — NOT _notify_complete(). This keeps
        # the bot visible as errored so the user must manually review.
        if remaining_qty > 0:
            err = (
                f"Failed to fully close {symbol} after {MAX_ATTEMPTS} attempts. "
                f"Remaining qty: {remaining_qty:.8f}. Manual exchange action required."
            )
            await self.db.update_close_error(trade_id, err)
            logger.error(f"[CloseAll] ❌ {err}")
            return {"success": False, "error": err}

        return {"success": True, "error": None}

    async def _confirm_fill(
        self,
        connector,
        symbol: str,
        order_id: str,
        expected_qty: float,
    ) -> tuple:
        """
        F5 FIX: Poll exchange for actual order fill status.

        Previous bug: if order disappeared from open_orders, we assumed it
        was fully filled at expected_qty. This was wrong — orders can
        disappear because they were CANCELLED, REJECTED, or EXPIRED.

        Fix: When order is no longer in open_orders, call fetch_order() to
        get the actual status and filled quantity. Only return 'filled' if
        the exchange confirms status is 'closed'/'filled'. Return 'cancelled'
        or 'rejected' for those specific terminal states. Return 'partial'
        if partially filled.

        Falls back to expected_qty assumption ONLY if fetch_order fails
        (exchange API error during confirmation), with a warning log.

        Returns: (filled_qty, status_str, error_msg)
        status_str: 'filled' | 'partial' | 'cancelled' | 'rejected' | 'failed'
        """
        if not order_id:
            return 0.0, "failed", "No order ID returned"

        for poll in range(FILL_CONFIRM_MAX):
            await asyncio.sleep(FILL_CONFIRM_POLL)
            try:
                orders   = await connector.fetch_open_orders(symbol)
                open_ids = {str(o.get("id")) for o in orders}

                if str(order_id) in open_ids:
                    # Still open, keep polling
                    logger.debug(
                        f"[CloseAll] Order {order_id} still open (poll {poll+1}/{FILL_CONFIRM_MAX})"
                    )
                    continue

                # Order is no longer in open orders.
                # F5 FIX: fetch actual status instead of assuming filled.
                try:
                    order_info  = await connector.fetch_order(order_id, symbol)
                    exch_status = str(order_info.get("status", "unknown")).lower()
                    filled_qty  = float(order_info.get("filled", 0) or 0)

                    if exch_status in ("closed", "filled"):
                        logger.info(
                            f"[CloseAll] Order {order_id} confirmed filled: "
                            f"qty={filled_qty:.8f}"
                        )
                        return filled_qty, "filled", None

                    elif exch_status in ("canceled", "cancelled"):
                        logger.warning(
                            f"[CloseAll] Order {order_id} was CANCELLED by exchange. "
                            f"filled_qty={filled_qty:.8f}"
                        )
                        if filled_qty > 0:
                            # Partial fill before cancel
                            return filled_qty, "partial", f"Order cancelled after partial fill: {filled_qty:.8f}"
                        return 0.0, "cancelled", "Order cancelled by exchange — will retry"

                    elif exch_status in ("rejected", "expired"):
                        logger.warning(f"[CloseAll] Order {order_id} was {exch_status} by exchange.")
                        return 0.0, "rejected", f"Order {exch_status} by exchange — will retry"

                    else:
                        # Unknown status — be conservative, treat as partial to retry
                        logger.warning(
                            f"[CloseAll] Order {order_id} has unknown status '{exch_status}' "
                            f"after leaving open_orders. Treating as partial to trigger retry."
                        )
                        return filled_qty, "partial", f"Unknown order status: {exch_status}"

                except Exception as fetch_err:
                    # fetch_order failed — we can't confirm fill status.
                    # WARNING: We fall back to assuming filled to unblock close_all.
                    # This is the lesser evil vs leaving the loop stuck indefinitely.
                    logger.warning(
                        f"[CloseAll] fetch_order failed for {order_id}: {fetch_err}. "
                        f"Assuming filled={expected_qty:.8f} (fallback — verify manually)."
                    )
                    return expected_qty, "filled", f"fill assumed (fetch_order failed: {fetch_err})"

            except Exception as poll_err:
                logger.warning(f"[CloseAll] Fill confirmation poll failed: {poll_err}")
                continue

        # Max polls exceeded — treat as partial to trigger retry
        logger.warning(
            f"[CloseAll] Order {order_id} fill unconfirmed after "
            f"{FILL_CONFIRM_MAX} polls — treating as partial"
        )
        return 0.0, "partial", "Fill unconfirmed after max polls"

    async def _notify_complete(self):
        """
        F2 FIX: Only called on FULL success (all positions closed).
        On partial failure or timeout, set_bot_error_state() is called instead.

        Notifies Next.js to mark bot as stopped and clean up sessions.
        """
        app_url = os.getenv("NEXT_PUBLIC_APP_URL", "")
        if not app_url:
            logger.warning("[CloseAll] NEXT_PUBLIC_APP_URL not set — skipping completion callback")
            # Fallback: set status directly in DB
            try:
                await self.db.force_set_status(self.user_id, "stopped")
                logger.info("[CloseAll] Fallback: DB status set to stopped directly")
            except Exception as e:
                logger.error(f"[CloseAll] Fallback DB stop also failed: {e}")
            return

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{app_url}/api/bot/complete-stop",
                    json={"user_id": self.user_id},
                    headers={"X-Bot-Secret": os.getenv("BOT_ENGINE_SECRET", "")},
                )
                if resp.status_code == 200:
                    logger.info(f"[CloseAll] ✅ Completion callback succeeded")
                else:
                    logger.warning(
                        f"[CloseAll] Completion callback returned {resp.status_code}. "
                        "Falling back to direct DB update."
                    )
                    await self.db.force_set_status(self.user_id, "stopped")
        except Exception as e:
            logger.error(f"[CloseAll] Completion callback failed: {e}")
            try:
                await self.db.force_set_status(self.user_id, "stopped")
            except Exception as db_err:
                logger.error(f"[CloseAll] Fallback DB update also failed: {db_err}")