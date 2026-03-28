import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { trades } from '@/lib/schema'
import { eq, desc, and, gte, sql } from 'drizzle-orm'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)

  // ── Pagination ────────────────────────────────────────────────────────────
  const page   = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit  = Math.min(Number(searchParams.get('limit') ?? 50), 500)
  const offset = (page - 1) * limit

  // ── Filters ───────────────────────────────────────────────────────────────
  const market = searchParams.get('market')   // indian | crypto | commodities | global
  const status = searchParams.get('status')   // open | closed | failed | cancelled
  const mode   = searchParams.get('mode')     // paper | live
  const since  = searchParams.get('since')

  const conditions = [eq(trades.userId, session.id)]

  if (market && market !== 'all') conditions.push(eq(trades.marketType, market as any))
  if (status && status !== 'all') conditions.push(eq(trades.status, status as any))
  if (since)                      conditions.push(gte(trades.openedAt, new Date(since)))

  // Mode filter: paper = isPaper true, live = isPaper false
  if (mode === 'paper') conditions.push(eq(trades.isPaper, true))
  if (mode === 'live')  conditions.push(eq(trades.isPaper, false))

  // ── Fetch page of trades + total count in parallel ────────────────────────
  const [result, countRows] = await Promise.all([
    db.query.trades.findMany({
      where:   and(...conditions),
      orderBy: [desc(trades.openedAt)],
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)::int` })
      .from(trades)
      .where(and(...conditions)),
  ])

  // ── Summary stats (scoped to current filter — same conditions) ────────────
  const summaryRows = await db
    .select({
      closed:   sql<number>`count(*) filter (where status = 'closed')::int`,
      winners:  sql<number>`count(*) filter (where status = 'closed' and pnl > 0)::int`,
      totalPnl: sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)::float`,
    })
    .from(trades)
    .where(and(...conditions))

  const s       = summaryRows[0]
  const winRate = s.closed > 0 ? (s.winners / s.closed) * 100 : 0
  const total   = countRows[0]?.count ?? 0

  return NextResponse.json({
    trades: result,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasMore: offset + result.length < total,
    },
    summary: {
      total,
      closed:   s.closed,
      totalPnl: Math.round((s.totalPnl ?? 0) * 100) / 100,
      winRate:  Math.round(winRate * 10) / 10,
    },
  })
}