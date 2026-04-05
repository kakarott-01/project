// lib/bot-stop.ts — v3
// ================
// FIX (500 on stop): The for-loop over runningSessions previously had no
// per-iteration error handling. A single DB failure (Neon connection timeout,
// intermittent network blip) would throw out of _doImmediateStop entirely,
// propagating up through _handleStop to the route and causing an unhandled
// 500. Now each session update is wrapped individually — one failed update
// is logged but does NOT abort the rest of the cleanup.
//
// F6 FIX (from v2): DB-level idempotency guard on _doImmediateStop still
// in place — only one concurrent caller can claim the stop via the
// conditional UPDATE WHERE status IN ('stopping','running').

import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'

export async function _doImmediateStop(userId: string, now: Date) {
  // ── F6: Atomic claim — only one concurrent call succeeds ──────────────────
  const claimed = await db
    .update(botStatuses)
    .set({
      status:     'stopped',
      stoppedAt:  now,
      updatedAt:  now,
      stopMode:   null,
      stoppingAt: null,
    })
    .where(
      and(
        eq(botStatuses.userId, userId),
        sql`${botStatuses.status} IN ('stopping', 'running')`,
      )
    )
    .returning({ id: botStatuses.id })

  if (claimed.length === 0) {
    // Another instance already completed the stop, or bot was already stopped.
    return
  }

  // ── We claimed the stop — notify engine (best-effort) ────────────────────
  fetch(`${process.env.BOT_ENGINE_URL}/bot/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
    },
    body: JSON.stringify({ user_id: userId }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)

  // ── Find all sessions that are still running ──────────────────────────────
  let runningSessions: Awaited<ReturnType<typeof db.query.botSessions.findMany>>
  try {
    runningSessions = await db.query.botSessions.findMany({
      where: and(
        eq(botSessions.userId, userId),
        sql`${botSessions.status} IN ('running', 'stopping')`,
      ),
    })
  } catch (e) {
    // If we can't even query sessions, log and return — bot_statuses is
    // already marked stopped which is the critical state.
    console.error(`[bot-stop] Failed to query running sessions for user=${userId}:`, e)
    return
  }

  // ── Update each session with final trade stats ────────────────────────────
  // FIX: Each session is updated independently. A failure on one session
  // is logged but does NOT prevent the others from being updated, and does
  // NOT throw out of _doImmediateStop (which was the root cause of the 500).
  for (const s of runningSessions) {
    try {
      const stats = await db
        .select({
          total:  sql<number>`count(*)::int`,
          open:   sql<number>`count(*) filter (where status='open')::int`,
          closed: sql<number>`count(*) filter (where status='closed')::int`,
          pnl:    sql<number>`coalesce(sum(pnl) filter (where status='closed'),0)::float`,
        })
        .from(trades)
        .where(and(
          eq(trades.userId, userId),
          eq(trades.marketType, s.market as any),
          // Guard against null startedAt to avoid null comparison in SQL
          s.startedAt
            ? sql`${trades.openedAt} >= ${s.startedAt}`
            : sql`true`,
        ))

      const row = stats[0]
      await db.update(botSessions)
        .set({
          status:       'stopped',
          endedAt:      now,
          totalTrades:  row?.total  ?? 0,
          openTrades:   row?.open   ?? 0,
          closedTrades: row?.closed ?? 0,
          totalPnl:     String(row?.pnl ?? 0),
        })
        .where(eq(botSessions.id, s.id))
    } catch (sessionErr) {
      // Log but continue — don't let one session's failure abort the rest
      console.error(
        `[bot-stop] Failed to update session ${s.id} for user=${userId}:`,
        sessionErr
      )
    }
  }
}