// app/api/bot/cleanup/route.ts
//
// Called on dashboard load to reconcile DB state with actual bot state.
// If bot_statuses says "stopped" but sessions say "running", close those sessions.
// This fixes the ghost "Running" sessions after Render restarts OR after a normal stop.
//
// v2 fixes:
// - Previously only cleaned up when status !== 'running'. Now also cleans up
//   when status IS 'running' but the session's bot is in a stopping/stopped state.
//   This fixes Bot History showing "Running" right after stopping.
// - Added error handling around individual session updates so one failure
//   doesn't block the rest.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Get current bot status
  const status = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, session.id),
    columns: { status: true },
  })

  // Close all lingering running sessions if bot is stopped OR stopping
  // (stopping means it's winding down — sessions should be marked stopped)
  const shouldClean =
    !status ||
    status.status === 'stopped' ||
    status.status === 'stopping'

  if (!shouldClean) {
    return NextResponse.json({ cleaned: 0 })
  }

  const stale = await db.query.botSessions.findMany({
    where: and(
      eq(botSessions.userId, session.id),
      eq(botSessions.status, 'running'),
    ),
  })

  if (stale.length === 0) {
    return NextResponse.json({ cleaned: 0 })
  }

  const now = new Date()
  let cleaned = 0

  for (const s of stale) {
    try {
      // Calculate final trade stats for this session
      const stats = await db
        .select({
          total:  sql<number>`count(*)::int`,
          open:   sql<number>`count(*) filter (where status = 'open')::int`,
          closed: sql<number>`count(*) filter (where status = 'closed')::int`,
          pnl:    sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)::float`,
        })
        .from(trades)
        .where(and(
          eq(trades.userId, session.id),
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

      cleaned++
    } catch (err) {
      console.error(`[cleanup] Failed to close session ${s.id}:`, err)
    }
  }

  console.info(`[cleanup] Closed ${cleaned} stale sessions for user=${session.id}`)
  return NextResponse.json({ cleaned })
}