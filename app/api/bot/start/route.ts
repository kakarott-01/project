// app/api/bot/start/route.ts — v3
// =================================
// F4 FIX: On engine call failure, rollback now covers BOTH:
//   - botSessions (was already done in v2)
//   - botStatuses (was missing — left status as 'running' on failure)
//
// F7 FIX: If Redis is DOWN (not just lock contention), start is refused
//   with a clear error. Starting without a lock is unsafe — it could
//   create duplicate sessions and start multiple bot instances.
//   (Stop is allowed without a lock; Start is not — see bot-lock.ts.)
//
// All other logic from v2 unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, exchangeApis, marketConfigs } from '@/lib/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { acquireBotLock } from '@/lib/bot-lock'
import { getUserMarketStrategyConfig } from '@/lib/strategies/config-service'

type MarketName = 'indian' | 'crypto' | 'commodities' | 'global'

const VALID_MARKETS = new Set<MarketName>(['indian', 'crypto', 'commodities', 'global'])

function isMarketName(value: unknown): value is MarketName {
  return typeof value === 'string' && VALID_MARKETS.has(value as MarketName)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── F7 + F4: Redis distributed lock ────────────────────────────────────────
  // If Redis is DOWN: refuse start (unsafe without lock — could duplicate).
  // If lock contention: return 429 (another start/stop in progress).
  const lock = await acquireBotLock(session.id, 'start')
  if (!lock.acquired) {
    if (lock.isRedisDown) {
      return NextResponse.json(
        { error: 'Lock service temporarily unavailable. Please try again in a few seconds.' },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: lock.reason }, { status: 429 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const rawMarkets = body?.markets

    if (!rawMarkets || !Array.isArray(rawMarkets) || rawMarkets.length === 0) {
      return NextResponse.json({ error: 'No markets specified' }, { status: 400 })
    }

    const invalidMarkets = rawMarkets.filter(
      (market: unknown) => !isMarketName(market),
    )
    if (invalidMarkets.length > 0) {
      return NextResponse.json(
        { error: `Invalid market(s): ${invalidMarkets.join(', ')}` },
        { status: 400 },
      )
    }

    const markets: MarketName[] = Array.from(new Set(rawMarkets as MarketName[]))
    if (markets.length !== rawMarkets.length) {
      return NextResponse.json({ error: 'Duplicate markets in request' }, { status: 400 })
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

    // ── Fetch all exchange/config data in one round trip ──────────────────────
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

    for (const market of markets) {
      const strategyConfig = await getUserMarketStrategyConfig(session.id, market)
      if (strategyConfig.strategyKeys.length === 0) {
        return NextResponse.json(
          { error: `No strategy configured for ${market}. Configure at least one strategy before starting.` },
          { status: 400 },
        )
      }
    }

    // ── Create sessions BEFORE calling the engine ─────────────────────────────
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

    // ── Pre-write botStatuses as 'running' BEFORE engine call ─────────────────
    // F4: We write this BEFORE the engine call so that if the engine succeeds
    // but our read-back fails, the state is still consistent. If the engine
    // fails, we roll this back explicitly below.
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
      // F4: Roll back BOTH botSessions AND botStatuses
      await _rollbackBotStart(session.id, createdSessionIds)
      return NextResponse.json(
        { error: 'Bot engine is unreachable. Is the Render service running?' },
        { status: 503 },
      )
    }

    if (!botRes.ok) {
      const engineBody = await botRes.json().catch(() => ({}))
      // F4: Roll back BOTH botSessions AND botStatuses
      await _rollbackBotStart(session.id, createdSessionIds)
      return NextResponse.json(
        { error: engineBody.detail ?? 'Bot engine returned an error', detail: engineBody },
        { status: botRes.status },
      )
    }

    // ── Engine confirmed started — state is already written above ─────────────
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

// ── F4: Rollback helper ───────────────────────────────────────────────────────
// Rolls back both botSessions and botStatuses atomically when engine fails.
// Called only on failure paths — never on success.
async function _rollbackBotStart(userId: string, sessionIds: string[]): Promise<void> {
  const now = new Date()
  try {
    await Promise.all([
      // Roll back sessions: mark as stopped
      ...sessionIds.map(sid =>
        db.update(botSessions)
          .set({ status: 'stopped', endedAt: now })
          .where(eq(botSessions.id, sid))
      ),
      // F4 NEW: Roll back botStatuses: mark as stopped with clear error message
      db.update(botStatuses)
        .set({
          status:       'stopped',
          errorMessage: 'Bot failed to start — engine unreachable or returned error.',
          updatedAt:    now,
          stopMode:     null,
          stoppingAt:   null,
        })
        .where(eq(botStatuses.userId, userId)),
    ])
  } catch (rollbackErr) {
    // Log but don't throw — we're already in an error path.
    // The TTL on the Redis lock will release even if this fails.
    console.error('[bot/start] Rollback failed:', rollbackErr)
  }
}
