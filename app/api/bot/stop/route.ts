// app/api/bot/stop/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fire-and-forget to bot engine (don't block the UI on this)
  fetch(`${process.env.BOT_ENGINE_URL}/bot/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
    },
    body: JSON.stringify({ user_id: session.id }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)

  const now = new Date()

  // ── Close ALL running sessions for this user ──────────────────────────────
  // (handles the case where multiple stale sessions exist)
  const runningSessions = await db.query.botSessions.findMany({
    where: and(
      eq(botSessions.userId, session.id),
      eq(botSessions.status, 'running'),
    ),
  })

  for (const botSession of runningSessions) {
    // Count trades that were opened during this session's window for this market
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
        eq(trades.marketType, botSession.market as any),
        sql`${trades.openedAt} >= ${botSession.startedAt}`,
      ))

    const s = stats[0]
    await db.update(botSessions)
      .set({
        status:       'stopped',
        endedAt:      now,
        totalTrades:  s?.total  ?? 0,
        openTrades:   s?.open   ?? 0,
        closedTrades: s?.closed ?? 0,
        totalPnl:     String(s?.pnl ?? 0),
      })
      .where(eq(botSessions.id, botSession.id))
  }

  // ── If somehow there are no running sessions but status says running, ──────
  // still mark status as stopped
  await db.update(botStatuses)
    .set({ status: 'stopped', stoppedAt: now, updatedAt: now })
    .where(eq(botStatuses.userId, session.id))

  return NextResponse.json({ success: true, status: 'stopped' })
}