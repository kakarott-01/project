import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { backtestResults, backtestRuns, strategyConfigs } from '@/lib/schema'
import { runEngineBacktest } from '@/lib/strategies/engine-client'
import { backtestRequestSchema, validateStrategiesForMarket } from '@/lib/strategies/validation'
import { ensureStrategyCatalogSeeded } from '@/lib/strategies/catalog'
import { eq } from 'drizzle-orm'
import { analyzeStrategyConflicts } from '@/lib/strategies/conflicts'

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
    const conflicts = analyzeStrategyConflicts(parsed.data.strategyKeys)

    const [configSnapshot] = await db.insert(strategyConfigs).values({
      userId: session.id,
      marketType: parsed.data.marketType,
      executionMode: parsed.data.executionMode,
      positionMode: parsed.data.positionMode,
      allowHedgeOpposition: parsed.data.allowHedgeOpposition,
      strategyKeys: parsed.data.strategyKeys,
      asset: parsed.data.asset,
      timeframe: parsed.data.timeframe,
      initialCapital: parsed.data.initialCapital.toFixed(2),
      conflictWarnings: conflicts,
      source: 'backtest',
    }).returning({ id: strategyConfigs.id })

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
      positionMode: parsed.data.positionMode,
      allowHedgeOpposition: parsed.data.allowHedgeOpposition,
      strategyConfigId: configSnapshot.id,
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
      positionMode: parsed.data.positionMode,
      allowHedgeOpposition: parsed.data.allowHedgeOpposition,
      strategyKeys: parsed.data.strategyKeys,
    })

    await db.update(backtestRuns)
      .set({
        status: 'completed',
        performanceMetrics: result.performance_metrics,
        equityCurve: result.equity_curve,
        tradeSummary: result.trade_summary,
        strategyBreakdown: result.strategy_breakdown,
        completedAt: new Date(),
      })
      .where(eq(backtestRuns.id, created[0].id))

    await db.insert(backtestResults).values({
      runId: created[0].id,
      userId: session.id,
      marketType: parsed.data.marketType,
      strategyKeys: parsed.data.strategyKeys,
      executionMode: parsed.data.executionMode,
      positionMode: parsed.data.positionMode,
      performanceMetrics: result.performance_metrics,
      equityCurve: result.equity_curve,
      tradeSummary: result.trade_summary,
      strategyBreakdown: result.strategy_breakdown,
    })

    return NextResponse.json({
      id: created[0].id,
      ...result,
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const runs = await db.query.backtestRuns.findMany({
    where: eq(backtestRuns.userId, session.id),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: 20,
  })

  return NextResponse.json({ runs })
}
