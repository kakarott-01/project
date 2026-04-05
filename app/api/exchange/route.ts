import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { exchangeApis, marketConfigs } from '@/lib/schema'
import { encrypt, encryptJSON } from '@/lib/encryption'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { assertBotStoppedForSensitiveMutation } from '@/lib/strategies/locks'

const saveSchema = z.object({
  marketType: z.enum(['indian', 'crypto', 'commodities', 'global']),
  exchangeName: z.string().min(1),
  exchangeLabel: z.string().optional(),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  extraFields: z.record(z.string()).optional(),
})

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = saveSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { marketType, exchangeName, exchangeLabel, apiKey, apiSecret, extraFields } = parsed.data

  try {
    await assertBotStoppedForSensitiveMutation(session.id, 'Stop the bot before editing API credentials or market wiring.')
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: (error as Error & { status?: number }).status ?? 409 })
  }

  const apiKeyEnc = encrypt(apiKey)
  const apiSecretEnc = encrypt(apiSecret)
  const extraFieldsEnc = extraFields ? encryptJSON(extraFields) : null

  const existing = await db.query.exchangeApis.findFirst({
    where: and(
      eq(exchangeApis.userId, session.id),
      eq(exchangeApis.marketType, marketType),
      eq(exchangeApis.exchangeName, exchangeName),
    ),
  })

  if (existing) {
    await db.update(exchangeApis)
      .set({
        apiKeyEnc,
        apiSecretEnc,
        extraFieldsEnc,
        isVerified: false,
        updatedAt: new Date(),
      })
      .where(eq(exchangeApis.id, existing.id))
  } else {
    await db.insert(exchangeApis).values({
      userId: session.id,
      marketType,
      exchangeName,
      exchangeLabel,
      apiKeyEnc,
      apiSecretEnc,
      extraFieldsEnc,
    })
  }

  const marketCfg = await db.query.marketConfigs.findFirst({
    where: and(
      eq(marketConfigs.userId, session.id),
      eq(marketConfigs.marketType, marketType),
    ),
  })

  if (!marketCfg) {
    await db.insert(marketConfigs).values({
      userId: session.id,
      marketType,
      algoName: getDefaultAlgo(marketType),
      paperMode: true,
    })
  }

  return NextResponse.json({ success: true })
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apis = await db.query.exchangeApis.findMany({
    where: eq(exchangeApis.userId, session.id),
    columns: {
      id: true,
      marketType: true,
      exchangeName: true,
      exchangeLabel: true,
      isVerified: true,
      isActive: true,
      lastVerifiedAt: true,
      createdAt: true,
    },
  })

  const res = NextResponse.json(apis)
  // Exchange API list rarely changes — cache 5 minutes
  res.headers.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=60')
  return res
}

function getDefaultAlgo(market: string): string {
  const map: Record<string, string> = {
    indian: 'ema_crossover_rsi',
    crypto: 'multi_tf_rsi_bb',
    commodities: 'vwap_macd',
    global: 'universal_trend',
  }
  return map[market] ?? 'universal_trend'
}
