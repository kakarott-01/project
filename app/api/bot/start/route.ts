// app/api/bot/start/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, exchangeApis, marketConfigs } from '@/lib/schema'
import { eq, and, inArray } from 'drizzle-orm'

// ── In-process lock so rapid double-clicks can't fire two starts ──────────────
// (One lock per user_id, cleared after the request completes)
const startLocks = new Set<string>()

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Idempotency lock ──────────────────────────────────────────────────────
  if (startLocks.has(session.id)) {
    return NextResponse.json({ error: 'Start already in progress' }, { status: 429 })
  }
  startLocks.add(session.id)

  try {
    const { markets } = await req.json()
    if (!markets || markets.length === 0) {
      return NextResponse.json({ error: 'No markets specified' }, { status: 400 })
    }

    // ── Check if already running ─────────────────────────────────────────────
    const existing = await db.query.botStatuses.findFirst({
      where: eq(botStatuses.userId, session.id),
      columns: { status: true },
    })
    if (existing?.status === 'running') {
      return NextResponse.json({ error: 'Bot is already running' }, { status: 409 })
    }

    // ── Close any stale "running" sessions left over from a crash/restart ────
    // These are sessions that are still marked running but the bot is stopped.
    await db
      .update(botSessions)
      .set({
        status:  'stopped',
        endedAt: new Date(),
      })
      .where(
        and(
          eq(botSessions.userId, session.id),
          eq(botSessions.status, 'running'),
        )
      )

    // ── Validate exchange APIs exist for each market ──────────────────────────
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
        { status: 400 }
      )
    }

    // ── Call bot engine ───────────────────────────────────────────────────────
    let botRes: Response | null = null
    try {
      botRes = await fetch(`${process.env.BOT_ENGINE_URL}/bot/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
        },
        body: JSON.stringify({ user_id: session.id, markets }),
        // Short timeout so UI doesn't hang if Render is cold-starting
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('Bot engine unreachable:', err)
      return NextResponse.json(
        { error: 'Bot engine is unreachable. Is the Render service running?' },
        { status: 503 }
      )
    }

    if (!botRes.ok) {
      const body = await botRes.json().catch(() => ({}))
      return NextResponse.json(
        { error: body.detail ?? 'Bot engine returned an error', detail: body },
        { status: botRes.status }
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
      })
      .onConflictDoUpdate({
        target: botStatuses.userId,
        set: {
          status:        'running',
          activeMarkets: markets,
          startedAt:     now,
          errorMessage:  null,
          updatedAt:     now,
        },
      })

    return NextResponse.json({ success: true, status: 'running', markets, sessionIds })

  } finally {
    startLocks.delete(session.id)
  }
}