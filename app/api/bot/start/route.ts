// app/api/bot/start/route.ts
// ==========================
// REVISED: adds Redis distributed locking to prevent duplicate starts
// across multiple serverless workers.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, exchangeApis, marketConfigs } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { acquireBotLock } from '@/lib/bot-lock'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Redis distributed lock ─────────────────────────────────────────────────
  // Replaces the old in-process Set<string> which was useless across workers.
  const lock = await acquireBotLock(session.id, 'start')
  if (!lock.acquired) {
    return NextResponse.json({ error: lock.reason }, { status: 429 })
  }

  try {
    const { markets } = await req.json()
    if (!markets || markets.length === 0) {
      return NextResponse.json({ error: 'No markets specified' }, { status: 400 })
    }

    // ── Check if already running or stopping ──────────────────────────────────
    const existing = await db.query.botStatuses.findFirst({
      where: eq(botStatuses.userId, session.id),
      columns: { status: true },
    })

    if (existing?.status === 'running') {
      return NextResponse.json({ error: 'Bot is already running' }, { status: 409 })
    }

    // Prevent start while a stop/drain is in progress
    if (existing?.status === 'stopping') {
      return NextResponse.json({
        error: 'Bot is currently stopping. Wait for it to finish before restarting.',
      }, { status: 409 })
    }

    // ── Close stale 'running' sessions from crashes ───────────────────────────
    await db
      .update(botSessions)
      .set({ status: 'stopped', endedAt: new Date() })
      .where(and(
        eq(botSessions.userId, session.id),
        eq(botSessions.status, 'running'),
      ))

    // ── Validate exchange APIs ────────────────────────────────────────────────
    const missingMarkets: string[] = []
    for (const market of markets) {
      const api = await db.query.exchangeApis.findFirst({
        where: and(
          eq(exchangeApis.userId, session.id),
          eq(exchangeApis.marketType, market as any),
          eq(exchangeApis.isActive, true),
        ),
      })
      if (!api) missingMarkets.push(market)
    }

    if (missingMarkets.length > 0) {
      return NextResponse.json(
        { error: `No exchange API configured for: ${missingMarkets.join(', ')}.`, missingMarkets },
        { status: 400 },
      )
    }

    // ── Call bot engine ───────────────────────────────────────────────────────
    let botRes: Response | null = null
    try {
      botRes = await fetch(`${process.env.BOT_ENGINE_URL}/bot/start`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
        },
        body:   JSON.stringify({ user_id: session.id, markets }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('Bot engine unreachable:', err)
      return NextResponse.json(
        { error: 'Bot engine is unreachable. Is the Render service running?' },
        { status: 503 },
      )
    }

    if (!botRes.ok) {
      const body = await botRes.json().catch(() => ({}))
      return NextResponse.json(
        { error: body.detail ?? 'Bot engine returned an error', detail: body },
        { status: botRes.status },
      )
    }

    const now = new Date()

    // ── Create ONE session per market ─────────────────────────────────────────
    const sessionIds: string[] = []
    for (const market of markets) {
      const api = await db.query.exchangeApis.findFirst({
        where: and(
          eq(exchangeApis.userId, session.id),
          eq(exchangeApis.marketType, market as any),
          eq(exchangeApis.isActive, true),
        ),
        columns: { exchangeName: true },
      })

      const cfg = await db.query.marketConfigs.findFirst({
        where: and(
          eq(marketConfigs.userId, session.id),
          eq(marketConfigs.marketType, market as any),
        ),
        columns: { mode: true },
      })

      const [newSession] = await db.insert(botSessions).values({
        userId:    session.id,
        exchange:  api?.exchangeName ?? 'unknown',
        market,
        mode:      cfg?.mode ?? 'paper',
        status:    'running',
        startedAt: now,
      }).returning({ id: botSessions.id })

      sessionIds.push(newSession.id)
    }

    // ── Persist running state ─────────────────────────────────────────────────
    await db.insert(botStatuses)
      .values({
        userId:        session.id,
        status:        'running',
        activeMarkets: markets,
        startedAt:     now,
        stopMode:      null,
        stoppingAt:    null,
      })
      .onConflictDoUpdate({
        target: botStatuses.userId,
        set: {
          status:        'running',
          activeMarkets: markets,
          startedAt:     now,
          errorMessage:  null,
          stopMode:      null,
          stoppingAt:    null,
          updatedAt:     now,
        },
      })

    return NextResponse.json({ success: true, status: 'running', markets, sessionIds })

  } finally {
    await lock.release()
  }
}