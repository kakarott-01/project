// app/api/bot-history/route.ts — v2
// =====================================
// FIX: Bot History showing "Running" after bot is stopped.
//
// ROOT CAUSE: The /api/bot/cleanup endpoint (which marks stale running
// bot_sessions as 'stopped') was only called from the main Dashboard page
// on load. The Bot History page never called it, so sessions could remain
// stuck as 'running' indefinitely after a stop/restart.
//
// FIX: This route now performs an INLINE cleanup before returning results:
//   1. Fetch bot_statuses for the user
//   2. If bot is stopped/stopping (or has no status), find any bot_sessions
//      that are still 'running' and mark them 'stopped' with final stats
//   3. Then proceed with the normal query
//
// This makes bot-history self-healing — no dependency on Dashboard being
// loaded first. The cleanup is lightweight (only runs when bot is not
// actually running), and is idempotent.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm'

// ── Inline cleanup: close stale 'running' sessions if bot is stopped ──────────
async function closeStaleSessions(userId: string): Promise<void> {
  try {
    const status = await db.query.botStatuses.findFirst({
      where: eq(botStatuses.userId, userId),
      columns: { status: true },
    })

    // Only clean up when bot is confirmed not running
    const shouldClean =
      !status ||
      status.status === 'stopped' ||
      status.status === 'stopping'

    if (!shouldClean) return

    const stale = await db.query.botSessions.findMany({
      where: and(
        eq(botSessions.userId, userId),
        eq(botSessions.status, 'running'),
      ),
    })

    if (stale.length === 0) return

    const now = new Date()

    for (const s of stale) {
      try {
        const stats = await db
          .select({
            total:  sql<number>`count(*)::int`,
            open:   sql<number>`count(*) filter (where status = 'open')::int`,
            closed: sql<number>`count(*) filter (where status = 'closed')::int`,
            pnl:    sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)::float`,
          })
          .from(trades)
          .where(and(
            eq(trades.userId, userId),
            eq(trades.marketType, s.market as any),
            // Guard against null startedAt
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
      } catch (err) {
        // Log per-session errors but continue with the rest
        console.error(`[bot-history] Stale session cleanup failed for session ${s.id}:`, err)
      }
    }

    if (stale.length > 0) {
      console.info(`[bot-history] Closed ${stale.length} stale session(s) for user=${userId}`)
    }
  } catch (err) {
    // Cleanup failure must never break the actual history response
    console.error('[bot-history] Inline cleanup failed (non-fatal):', err)
  }
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Inline cleanup before querying ────────────────────────────────────────
  await closeStaleSessions(session.id)

  const { searchParams } = new URL(req.url)
  const mode     = searchParams.get('mode')
  const exchange = searchParams.get('exchange')
  const from     = searchParams.get('from')
  const to       = searchParams.get('to')
  const page     = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit    = Math.min(Number(searchParams.get('limit') ?? 20), 100)
  const offset   = (page - 1) * limit

  const conditions = [eq(botSessions.userId, session.id)]
  if (mode === 'paper' || mode === 'live') conditions.push(eq(botSessions.mode, mode))
  if (exchange) conditions.push(eq(botSessions.exchange, exchange))
  if (from)     conditions.push(gte(botSessions.startedAt, new Date(from)))
  if (to)       conditions.push(lte(botSessions.startedAt, new Date(to)))

  const [rows, countRows] = await Promise.all([
    db.query.botSessions.findMany({
      where:   and(...conditions),
      orderBy: [desc(botSessions.startedAt)],
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)::int` })
      .from(botSessions)
      .where(and(...conditions)),
  ])

  // For sessions still marked 'running' after cleanup (shouldn't happen, but
  // as a safety net), enrich with live trade count on the fly.
  const enriched = await Promise.all(rows.map(async (s) => {
    if (s.status !== 'running') return s

    try {
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
          s.startedAt
            ? sql`${trades.openedAt} >= ${s.startedAt}`
            : sql`true`,
        ))

      const row = stats[0]
      return {
        ...s,
        totalTrades:  row?.total  ?? 0,
        openTrades:   row?.open   ?? 0,
        closedTrades: row?.closed ?? 0,
        totalPnl:     String(row?.pnl ?? 0),
      }
    } catch (err) {
      console.error(`[bot-history] Enrichment failed for session ${s.id}:`, err)
      return s
    }
  }))

  return NextResponse.json({
    sessions: enriched,
    pagination: {
      page,
      limit,
      total: countRows[0]?.count ?? 0,
      pages: Math.ceil((countRows[0]?.count ?? 0) / limit),
    },
  })
}