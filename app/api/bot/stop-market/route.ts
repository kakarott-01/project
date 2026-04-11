// app/api/bot/stop-market/route.ts
// ===================================
// Handles stopping a single market while keeping others running.
//
// POST { marketType: string, mode: 'graceful' | 'close_all' }
//
// graceful: removes market from active scheduler, lets open positions
//           remain until they exit naturally (unmonitored).
//
// close_all: temporarily rejected for per-market stops until the engine
//            supports true market-scoped emergency closes.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getBotStatusSnapshot } from '@/lib/bot/status-snapshot'
import { acquireBotLock } from '@/lib/bot-lock'
import { guardErrorResponse, requireAccess } from '@/lib/guards'
import { postToBotEngine } from '@/lib/bot-engine-client'

const schema = z.object({
  marketType: z.enum(['indian', 'crypto', 'commodities', 'global']),
  mode: z.enum(['graceful', 'close_all']),
})

export async function POST(req: NextRequest) {
  let session
  try {
    session = await requireAccess()
  } catch (error) {
    return guardErrorResponse(error)
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { marketType, mode } = parsed.data

  // Acquire bot-level lock to avoid concurrent start/stop/market changes
  const lock = await acquireBotLock(session.id, 'stop')
  if (!lock.acquired) {
    if (lock.isRedisDown) {
      // Redis is down — allow stop-market to proceed without lock.
      // _doImmediateStop and other DB operations are DB-guarded.
      console.warn(`[bot/stop-market] Redis down for user=${session.id} — proceeding without lock`)
      try {
        return await _handleStopMarket(req, session.id, marketType, mode)
      } catch (e) {
        console.error('[bot/stop-market] Stop-market failed while Redis down:', e)
        return NextResponse.json({ error: 'Failed to stop market. Please try again.' }, { status: 500 })
      }
    }
    // Lock contention — another start/stop in progress
    return NextResponse.json({ error: lock.reason }, { status: 429 })
  }

  try {
    return await _handleStopMarket(req, session.id, marketType, mode)
  } finally {
    await lock.release()
  }
}


async function _handleStopMarket(req: NextRequest, userId: string, marketType: string, mode: 'graceful' | 'close_all') {
  // The original POST handler code follows — moved into this helper so we
  // can control lock acquisition/release behavior above.

  const current = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, userId),
    columns: { status: true, activeMarkets: true },
  })

  if (!current || current.status === 'stopped') {
    return NextResponse.json({ error: 'Bot is not running' }, { status: 409 })
  }

  const activeMarkets = (current.activeMarkets as string[] ?? [])
  if (!activeMarkets.includes(marketType)) {
    return NextResponse.json({ error: `${marketType} is not currently active` }, { status: 409 })
  }

  const remainingMarkets = activeMarkets.filter((m) => m !== marketType)
  const now = new Date()

  // Count open trades for this specific market
  const [openRows] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trades)
    .where(and(
      eq(trades.userId, userId),
      eq(trades.marketType, marketType as any),
      eq(trades.status, 'open' as any),
    ))
  const openCount = openRows?.count ?? 0

  if (mode === 'close_all' && openCount > 0) {
    return NextResponse.json(
      { error: 'Per-market close is not yet supported. Use Stop All from the main dashboard.' },
      { status: 400 },
    )
  }

  if (remainingMarkets.length === 0) {
    // Last market — do a full bot stop instead
    await db
      .update(botStatuses)
      .set({
        status: mode === 'close_all' ? 'stopping' as any : 'stopped' as any,
        activeMarkets: [],
        stopMode: mode === 'close_all' ? 'close_all' : null,
        stoppingAt: mode === 'close_all' ? now : null,
        stoppedAt: mode === 'close_all' ? null : now,
        updatedAt: now,
      })
      .where(eq(botStatuses.userId, userId))
  } else {
    // Keep other markets running
    await db
      .update(botStatuses)
      .set({
        activeMarkets: remainingMarkets,
        updatedAt: now,
      })
      .where(eq(botStatuses.userId, userId))
  }

  // Mark the session for this market as stopped
  const runningSessions = await db.query.botSessions.findMany({
    where: and(
      eq(botSessions.userId, userId),
      eq(botSessions.market, marketType),
      eq(botSessions.status, 'running'),
    ),
  })

  for (const s of runningSessions) {
    try {
      const stats = await db
        .select({
          total:  sql<number>`count(*)::int`,
          open:   sql<number>`count(*) filter (where status = 'open')::int`,
          closed: sql<number>`count(*) filter (where status = 'closed')::int`,
          pnl:    sql<number>`coalesce(sum(pnl) filter (where status = 'closed'), 0)::float`,
        })
        .from(trades)
        .where(and(
          eq(trades.userId, userId),
          eq(trades.marketType, marketType as any),
          s.startedAt ? sql`${trades.openedAt} >= ${s.startedAt}` : sql`true`,
        ))

      const row = stats[0]
      await db.update(botSessions)
        .set({
          status: 'stopped',
          endedAt: now,
          totalTrades: row?.total ?? 0,
          openTrades: mode === 'close_all' ? 0 : (row?.open ?? 0),
          closedTrades: row?.closed ?? 0,
          totalPnl: String(row?.pnl ?? 0),
        })
        .where(eq(botSessions.id, s.id))
    } catch (err) {
      console.error(`[stop-market] Session update failed for ${s.id}:`, err)
    }
  }

  // ── Notify bot engine ───────────────────────────────────────────────────
  try {
    if (remainingMarkets.length > 0) {
      await postToBotEngine('/bot/sync', { user_id: userId, markets: remainingMarkets }, 8_000)
    } else {
      await postToBotEngine('/bot/stop', { user_id: userId }, 8_000)
    }
  } catch (err) {
    console.warn(`[stop-market] Engine notify failed (non-fatal):`, err)
  }

  const { snapshot } = await getBotStatusSnapshot(userId)
  return NextResponse.json({
    success: true,
    stoppedMarket: marketType,
    mode,
    remainingMarkets,
    openPositionsClosed: mode === 'close_all' ? openCount : 0,
    ...snapshot,
  })
}
