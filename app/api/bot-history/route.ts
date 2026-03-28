// app/api/bot-history/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botSessions, trades } from '@/lib/schema'
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  // For "running" sessions, fetch live trade count on the fly
  // so the table always shows fresh numbers even while bot is active
  const enriched = await Promise.all(rows.map(async (s) => {
    if (s.status !== 'running') return s

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
    return {
      ...s,
      totalTrades:  row?.total  ?? 0,
      openTrades:   row?.open   ?? 0,
      closedTrades: row?.closed ?? 0,
      totalPnl:     String(row?.pnl ?? 0),
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