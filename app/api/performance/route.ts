// app/api/performance/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { trades } from '@/lib/schema'
import { eq, and, sql, gte } from 'drizzle-orm'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const mode   = searchParams.get('mode')   // paper | live | all
  const market = searchParams.get('market') // indian | crypto | commodities | global | all

  const conditions = [eq(trades.userId, session.id)]
  if (mode === 'paper') conditions.push(eq(trades.isPaper, true))
  if (mode === 'live')  conditions.push(eq(trades.isPaper, false))
  if (market && market !== 'all') conditions.push(eq(trades.marketType, market as any))

  // ── Overall summary ───────────────────────────────────────────────────────
  const [summary] = await db
    .select({
      total:       sql<number>`count(*)::int`,
      open:        sql<number>`count(*) filter (where status = 'open')::int`,
      closed:      sql<number>`count(*) filter (where status = 'closed')::int`,
      winners:     sql<number>`count(*) filter (where status = 'closed' and pnl > 0)::int`,
      losers:      sql<number>`count(*) filter (where status = 'closed' and pnl <= 0)::int`,
      totalPnl:    sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)::float`,
      avgWin:      sql<number>`coalesce(avg(pnl) filter (where status = 'closed' and pnl > 0), 0)::float`,
      avgLoss:     sql<number>`coalesce(avg(pnl) filter (where status = 'closed' and pnl <= 0), 0)::float`,
      bestTrade:   sql<number>`coalesce(max(pnl) filter (where status = 'closed'), 0)::float`,
      worstTrade:  sql<number>`coalesce(min(pnl) filter (where status = 'closed'), 0)::float`,
      paperCount:  sql<number>`count(*) filter (where is_paper = true)::int`,
      liveCount:   sql<number>`count(*) filter (where is_paper = false)::int`,
    })
    .from(trades)
    .where(and(...conditions))

  const winRate    = summary.closed > 0 ? (summary.winners / summary.closed) * 100 : 0
  const riskReward = summary.avgLoss !== 0 ? Math.abs(summary.avgWin / summary.avgLoss) : 0

  // ── Daily P&L (last 30 days) ──────────────────────────────────────────────
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const dailyPnl = await db
    .select({
      date: sql<string>`date(closed_at)::text`,
      pnl:  sql<number>`coalesce(sum(pnl), 0)::float`,
      wins: sql<number>`count(*) filter (where pnl > 0)::int`,
      losses: sql<number>`count(*) filter (where pnl <= 0)::int`,
    })
    .from(trades)
    .where(and(
      ...conditions,
      eq(trades.status, 'closed' as any),
      gte(trades.closedAt, thirtyDaysAgo),
    ))
    .groupBy(sql`date(closed_at)`)
    .orderBy(sql`date(closed_at) asc`)

  // ── Performance by market ─────────────────────────────────────────────────
  const byMarket = await db
    .select({
      market:  trades.marketType,
      total:   sql<number>`count(*)::int`,
      closed:  sql<number>`count(*) filter (where status = 'closed')::int`,
      winners: sql<number>`count(*) filter (where status = 'closed' and pnl > 0)::int`,
      pnl:     sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)::float`,
    })
    .from(trades)
    .where(and(...conditions))
    .groupBy(trades.marketType)

  // ── Cumulative P&L series (for chart) ─────────────────────────────────────
  // Bound the dataset so a long-lived account cannot blow up a serverless
  // response or the client chart. Aggregate by day to preserve cumulative
  // accuracy while keeping the payload compact.
  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

  const closedTradeDays = await db
    .select({
      date: sql<string>`date(closed_at)::text`,
      pnl: sql<number>`coalesce(sum(pnl), 0)::float`,
    })
    .from(trades)
    .where(and(
      ...conditions,
      eq(trades.status, 'closed' as any),
      gte(trades.closedAt, oneYearAgo),
    ))
    .groupBy(sql`date(closed_at)`)
    .orderBy(sql`date(closed_at)`)

  let cumulative = 0
  const cumPnl = closedTradeDays.map(t => {
    cumulative += t.pnl ?? 0
    return {
      date: t.date,
      pnl:  Math.round(cumulative * 100) / 100,
    }
  })

  return NextResponse.json({
    summary: {
      total:       summary.total,
      open:        summary.open,
      closed:      summary.closed,
      winners:     summary.winners,
      losers:      summary.losers,
      totalPnl:    Math.round(summary.totalPnl * 100) / 100,
      avgWin:      Math.round(summary.avgWin * 100) / 100,
      avgLoss:     Math.round(summary.avgLoss * 100) / 100,
      bestTrade:   Math.round(summary.bestTrade * 100) / 100,
      worstTrade:  Math.round(summary.worstTrade * 100) / 100,
      winRate:     Math.round(winRate * 10) / 10,
      riskReward:  Math.round(riskReward * 100) / 100,
      paperCount:  summary.paperCount,
      liveCount:   summary.liveCount,
    },
    dailyPnl,
    byMarket,
    cumPnl,
  })
}
