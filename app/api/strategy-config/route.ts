import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { assertBotStoppedForSensitiveMutation } from '@/lib/strategies/locks'
import { getUserMarketStrategyConfig, upsertUserMarketStrategyConfig } from '@/lib/strategies/config-service'
import { strategyConfigSchema } from '@/lib/strategies/validation'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const marketType = req.nextUrl.searchParams.get('marketType')
  if (!marketType || !['indian', 'crypto', 'commodities', 'global'].includes(marketType)) {
    return NextResponse.json({ error: 'Valid marketType is required.' }, { status: 400 })
  }

  const config = await getUserMarketStrategyConfig(session.id, marketType as any)
  return NextResponse.json(config)
}

export async function PUT(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await assertBotStoppedForSensitiveMutation(session.id, 'Stop the bot before changing strategies.')

    const parsed = strategyConfigSchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
    }

    const config = await upsertUserMarketStrategyConfig({
      userId: session.id,
      marketType: parsed.data.marketType,
      executionMode: parsed.data.executionMode,
      strategyKeys: parsed.data.strategyKeys,
    })

    return NextResponse.json({ success: true, config })
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 400
    return NextResponse.json({ error: (error as Error).message }, { status })
  }
}
