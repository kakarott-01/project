import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { z } from 'zod'
import { runEngineBacktest } from '@/lib/strategies/engine-client'
import { validateStrategiesForMarket } from '@/lib/strategies/validation'

const comparisonSchema = z.object({
  marketType: z.enum(['indian', 'crypto', 'commodities', 'global']),
  asset: z.string().min(1),
  timeframe: z.string().min(2),
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  initialCapital: z.number().positive(),
  left: z.object({
    label: z.string().min(1).max(60),
    executionMode: z.enum(['SAFE', 'AGGRESSIVE']),
    positionMode: z.enum(['NET', 'HEDGE']).default('NET'),
    allowHedgeOpposition: z.boolean().default(false),
    strategyKeys: z.array(z.string().min(1)).min(1).max(2),
  }),
  right: z.object({
    label: z.string().min(1).max(60),
    executionMode: z.enum(['SAFE', 'AGGRESSIVE']),
    positionMode: z.enum(['NET', 'HEDGE']).default('NET'),
    allowHedgeOpposition: z.boolean().default(false),
    strategyKeys: z.array(z.string().min(1)).min(1).max(2),
  }),
})

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = comparisonSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { marketType, timeframe, left, right } = parsed.data
  validateStrategiesForMarket(marketType, left.strategyKeys, timeframe)
  validateStrategiesForMarket(marketType, right.strategyKeys, timeframe)

  try {
    const [leftResult, rightResult] = await Promise.all([
      runEngineBacktest({
        userId: session.id,
        marketType,
        asset: parsed.data.asset,
        timeframe,
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        initialCapital: parsed.data.initialCapital,
        executionMode: left.executionMode,
        positionMode: left.positionMode,
        allowHedgeOpposition: left.allowHedgeOpposition,
        strategyKeys: left.strategyKeys,
      }),
      runEngineBacktest({
        userId: session.id,
        marketType,
        asset: parsed.data.asset,
        timeframe,
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        initialCapital: parsed.data.initialCapital,
        executionMode: right.executionMode,
        positionMode: right.positionMode,
        allowHedgeOpposition: right.allowHedgeOpposition,
        strategyKeys: right.strategyKeys,
      }),
    ])

    return NextResponse.json({
      left: { label: left.label, metrics: leftResult.performance_metrics },
      right: { label: right.label, metrics: rightResult.performance_metrics },
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
