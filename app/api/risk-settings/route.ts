import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { riskSettings } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const schema = z.object({
  maxPositionPct: z.number().min(0.1).max(100),
  stopLossPct: z.number().min(0.1).max(100),
  takeProfitPct: z.number().min(0.1).max(100),
  maxDailyLossPct: z.number().min(0.1).max(100),
  maxOpenTrades: z.number().int().min(1).max(20),
  cooldownSeconds: z.number().int().min(0).max(86400),
  trailingStop: z.boolean(),
  paperBalance: z.number().min(100).max(10_000_000).optional().default(10000),
})

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const settings = await db.query.riskSettings.findFirst({
    where: eq(riskSettings.userId, session.id),
  })

  const res = NextResponse.json(settings ?? {})
  // Risk settings rarely change — cache 5 minutes, revalidate in background
  res.headers.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=60')
  return res
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = schema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const d = parsed.data

  await db.insert(riskSettings)
    .values({
      userId: session.id,
      maxPositionPct: String(d.maxPositionPct),
      stopLossPct: String(d.stopLossPct),
      takeProfitPct: String(d.takeProfitPct),
      maxDailyLossPct: String(d.maxDailyLossPct),
      maxOpenTrades: d.maxOpenTrades,
      cooldownSeconds: d.cooldownSeconds,
      trailingStop: d.trailingStop,
      paperBalance: String(d.paperBalance ?? 10000),
    })
    .onConflictDoUpdate({
      target: riskSettings.userId,
      set: {
        maxPositionPct: String(d.maxPositionPct),
        stopLossPct: String(d.stopLossPct),
        takeProfitPct: String(d.takeProfitPct),
        maxDailyLossPct: String(d.maxDailyLossPct),
        maxOpenTrades: d.maxOpenTrades,
        cooldownSeconds: d.cooldownSeconds,
        trailingStop: d.trailingStop,
        paperBalance: String(d.paperBalance ?? 10000),
        updatedAt: new Date(),
      },
    })

  return NextResponse.json({ success: true })
}
