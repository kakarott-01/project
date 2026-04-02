// lib/bot-stop.ts
// ================
// F6 FIX: DB-level idempotency guard on _doImmediateStop.
//
// PROBLEM: /api/bot/status polls every 5 seconds. On Vercel, multiple
// serverless instances can poll simultaneously. Both detect
// status='stopping' + openTrades=0 and both call _doImmediateStop,
// causing concurrent writes to bot_statuses and bot_sessions.
//
// FIX: The botStatuses UPDATE now uses a conditional WHERE clause:
//   WHERE status IN ('stopping', 'running')
// This means only ONE concurrent call succeeds (gets rowCount > 0).
// The second call gets rowCount = 0 and returns early — no double-write.
//
// This is a DB-level atomic guard, not requiring Redis. It works even
// when Redis is down.

import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql, inArray } from 'drizzle-orm'

export async function _doImmediateStop(userId: string, now: Date) {
  // ── F6: Atomic claim — only one concurrent call succeeds ──────────────────
  // We UPDATE with WHERE status IN ('stopping','running') and check if any
  // row was actually changed. If 0 rows changed, another Vercel instance
  // already handled this stop — we return immediately.
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
        // Only claim if currently in a stoppable state.
        // If already 'stopped', this WHERE fails → 0 rows → we exit.
        sql`${botStatuses.status} IN ('stopping', 'running')`,
      )
    )
    .returning({ id: botStatuses.id })

  if (claimed.length === 0) {
    // Another instance already completed the stop, or bot was already stopped.
    // Safe to exit — no work needed.
    return
  }

  // ── We claimed the stop — now clean up sessions ───────────────────────────
  // Fire-and-forget to bot engine (best-effort, may already be stopped)
  fetch(`${process.env.BOT_ENGINE_URL}/bot/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
    },
    body: JSON.stringify({ user_id: userId }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)

  // Find all sessions that are still running/stopping
  const runningSessions = await db.query.botSessions.findMany({
    where: and(
      eq(botSessions.userId, userId),
      sql`${botSessions.status} IN ('running', 'stopping')`,
    ),
  })

  // Update each session with final trade stats
  for (const s of runningSessions) {
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
        sql`${trades.openedAt} >= ${s.startedAt}`,
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
  }
}