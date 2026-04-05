import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { backtestRuns } from '@/lib/schema'
import { runEngineBacktest } from '@/lib/strategies/engine-client'
import { backtestRequestSchema, validateStrategiesForMarket } from '@/lib/strategies/validation'
import { ensureStrategyCatalogSeeded } from '@/lib/strategies/catalog'
import { eq } from 'drizzle-orm'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = backtestRequestSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    await ensureStrategyCatalogSeeded()
    validateStrategiesForMarket(parsed.data.marketType, parsed.data.strategyKeys, parsed.data.timeframe)

    const created = await db.insert(backtestRuns).values({
      userId: session.id,
      marketType: parsed.data.marketType,
      asset: parsed.data.asset,
      timeframe: parsed.data.timeframe,
      dateFrom: new Date(parsed.data.dateFrom),
      dateTo: new Date(parsed.data.dateTo),
      initialCapital: parsed.data.initialCapital.toFixed(2),
      strategyKeys: parsed.data.strategyKeys,
      executionMode: parsed.data.executionMode,
      comparisonLabel: parsed.data.comparisonLabel,
      status: 'queued',
    }).returning({ id: backtestRuns.id })

    const result = await runEngineBacktest({
      userId: session.id,
      marketType: parsed.data.marketType,
      asset: parsed.data.asset,
      timeframe: parsed.data.timeframe,
      dateFrom: parsed.data.dateFrom,
      dateTo: parsed.data.dateTo,
      initialCapital: parsed.data.initialCapital,
      executionMode: parsed.data.executionMode,
      strategyKeys: parsed.data.strategyKeys,
    })

    await db.update(backtestRuns)
      .set({
        status: 'completed',
        performanceMetrics: result.performance_metrics,
        equityCurve: result.equity_curve,
        tradeSummary: result.trade_summary,
        completedAt: new Date(),
      })
      .where(eq(backtestRuns.id, created[0].id))

    return NextResponse.json({
      id: created[0].id,
      ...result,
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
