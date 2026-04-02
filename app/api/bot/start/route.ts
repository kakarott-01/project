// app/api/bot/start/route.ts — v2
// =================================
// PERF Q: Exchange API is now fetched ONCE with findMany() and filtered
//         in memory, instead of one findFirst() per market in two separate
//         loops. Eliminates N duplicate round-trips to Neon on bot start.
//
// All other logic from v1 unchanged (session creation before engine call,
// Redis distributed lock, stale session cleanup, engine error rollback).

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, exchangeApis, marketConfigs } from '@/lib/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { acquireBotLock } from '@/lib/bot-lock'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Redis distributed lock ─────────────────────────────────────────────────
  const lock = await acquireBotLock(session.id, 'start')
  if (!lock.acquired) {
    return NextResponse.json({ error: lock.reason }, { status: 429 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { markets } = body

    if (!markets || !Array.isArray(markets) || markets.length === 0) {
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

    // PERF Q: Fetch ALL exchange APIs for this user in ONE query,
    // then filter in-memory per market. Previously this was N findFirst()
    // calls in a loop — one per market, twice (validation + session creation).
    const [allApis, allConfigs] = await Promise.all([
      db.query.exchangeApis.findMany({
        where: and(
          eq(exchangeApis.userId, session.id),
          eq(exchangeApis.isActive, true),
        ),
        columns: {
          id:           true,
          marketType:   true,
          exchangeName: true,
        },
      }),
      db.query.marketConfigs.findMany({
        where: and(
          eq(marketConfigs.userId, session.id),
          inArray(marketConfigs.marketType, markets as any[]),
        ),
        columns: {
          marketType: true,
          mode:       true,
        },
      }),
    ])

    // Build lookup maps for O(1) access in the loop below
    const apiByMarket    = new Map(allApis.map(a => [a.marketType, a]))
    const configByMarket = new Map(allConfigs.map(c => [c.marketType, c]))

    // ── Validate that each requested market has an exchange API configured ────
    const missingMarkets: string[] = []
    for (const market of markets) {
      if (!apiByMarket.has(market)) {
        missingMarkets.push(market)
      }
    }

    if (missingMarkets.length > 0) {
      return NextResponse.json(
        { error: `No exchange API configured for: ${missingMarkets.join(', ')}.`, missingMarkets },
        { status: 400 },
      )
    }

    const now = new Date()

    // ── Create sessions BEFORE calling the engine ─────────────────────────────
    // Sessions are created first so if the engine call fails, we can roll back.
    const sessionIds: Record<string, string> = {}
    const createdSessionIds: string[] = []

    for (const market of markets) {
      const api    = apiByMarket.get(market)
      const config = configByMarket.get(market)

      const [newSession] = await db.insert(botSessions).values({
        userId:    session.id,
        exchange:  api?.exchangeName ?? 'unknown',
        market,
        mode:      config?.mode ?? 'paper',
        status:    'running',
        startedAt: now,
      }).returning({ id: botSessions.id })

      sessionIds[market]    = newSession.id
      createdSessionIds.push(newSession.id)
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
        body:   JSON.stringify({ user_id: session.id, markets, session_ids: sessionIds }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('Bot engine unreachable:', err)
      // Roll back sessions
      for (const sid of createdSessionIds) {
        await db.update(botSessions)
          .set({ status: 'stopped', endedAt: new Date() })
          .where(eq(botSessions.id, sid))
      }
      return NextResponse.json(
        { error: 'Bot engine is unreachable. Is the Render service running?' },
        { status: 503 },
      )
    }

    if (!botRes.ok) {
      const engineBody = await botRes.json().catch(() => ({}))
      // Roll back sessions on engine error
      for (const sid of createdSessionIds) {
        await db.update(botSessions)
          .set({ status: 'stopped', endedAt: new Date() })
          .where(eq(botSessions.id, sid))
      }
      return NextResponse.json(
        { error: engineBody.detail ?? 'Bot engine returned an error', detail: engineBody },
        { status: botRes.status },
      )
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

    return NextResponse.json({
      success: true,
      status:  'running',
      markets,
      sessionIds,
    })

  } finally {
    await lock.release()
  }
}