// app/api/bot/stop/route.ts — v3
// =================================
// FIX 1 (500 on stop): _handleStop was called inside a try/finally block
// but errors it threw were NOT caught — only the finally (lock release) ran,
// and the uncaught error propagated as a Vercel 500 with no JSON body.
//
// Now _handleStop is wrapped in try/catch. Any internal error (DB hiccup,
// Neon connection timeout, etc.) returns a clean 500 JSON response instead
// of a raw crash.
//
// FIX 2 (Redis-down stop): unchanged from v2 — stop proceeds without lock
// when Redis is unreachable (safe because _doImmediateStop has DB-level guard).
//
// All stop mode logic unchanged from v2.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'
import { acquireBotLock } from '@/lib/bot-lock'
import { _doImmediateStop } from '@/lib/bot-stop'

type StopMode = 'close_all' | 'graceful'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── Parse mode ─────────────────────────────────────────────────────────────
  let mode: StopMode = 'graceful'
  try {
    const body = await req.json()
    if (body?.mode === 'close_all') mode = 'close_all'
    else if (body?.mode === 'graceful') mode = 'graceful'
  } catch { /* empty body → default graceful */ }

  // ── F7: Redis lock with down-state handling ─────────────────────────────────
  const lock = await acquireBotLock(session.id, 'stop')

  if (!lock.acquired) {
    if (lock.isRedisDown) {
      // Redis is down — allow stop to proceed without lock.
      // _doImmediateStop has its own DB-level idempotency guard.
      console.warn(`[bot/stop] Redis down for user=${session.id} — proceeding without lock (safe for stop)`)
      try {
        return await _handleStop(session.id, mode)
      } catch (e) {
        console.error('[bot/stop] Stop failed while Redis down:', e)
        return NextResponse.json(
          { error: 'Failed to stop bot. Please try again.' },
          { status: 500 }
        )
      }
    }
    // Lock contention — another start/stop in progress
    return NextResponse.json({ error: lock.reason }, { status: 429 })
  }

  try {
    // FIX: _handleStop errors are now caught here instead of propagating
    // as an unhandled exception (which caused Vercel 500 with no JSON body).
    return await _handleStop(session.id, mode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[bot/stop] _handleStop failed for user=${session.id}:`, e)
    return NextResponse.json(
      { error: `Stop operation failed: ${msg}` },
      { status: 500 }
    )
  } finally {
    await lock.release()
  }
}

async function _handleStop(userId: string, mode: StopMode): Promise<NextResponse> {
  const now = new Date()

  const current = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, userId),
  })

  // Already fully stopped — idempotent success
  if (!current || current.status === 'stopped') {
    return NextResponse.json({ success: true, status: 'stopped', mode: null })
  }

  // Already stopping in graceful mode and user wants to escalate to close_all
  const escalating = current.status === 'stopping' && mode === 'close_all'
  // Already stopping in same mode — idempotent
  if (current.status === 'stopping' && !escalating) {
    const openCount = await _countOpenTrades(userId)
    return NextResponse.json({
      success:    true,
      status:     'stopping',
      mode:       current.stopMode,
      openTrades: openCount,
    })
  }

  const openCount = await _countOpenTrades(userId)

  // No open positions → immediate stop regardless of mode
  if (openCount === 0) {
    await _doImmediateStop(userId, now)
    return NextResponse.json({ success: true, status: 'stopped', mode, openTrades: 0 })
  }

  // close_all mode
  if (mode === 'close_all') {
    _notifyBotEngine(userId, 'close_all').catch(() => null)

    await db.insert(botStatuses)
      .values({
        userId,
        status:         'stopping' as any,
        activeMarkets:  current.activeMarkets ?? [],
        stopMode:       'close_all',
        stoppingAt:     now,
        updatedAt:      now,
        stopTimeoutSec: 300,
      })
      .onConflictDoUpdate({
        target: botStatuses.userId,
        set: {
          status:         'stopping' as any,
          stopMode:       'close_all',
          stoppingAt:     now,
          updatedAt:      now,
          errorMessage:   null,
          stopTimeoutSec: 300,
        },
      })

    return NextResponse.json({
      success:    true,
      status:     'stopping',
      mode:       'close_all',
      openTrades: openCount,
    })
  }

  // graceful mode
  _notifyBotEngine(userId, 'drain').catch(() => null)

  await db.insert(botStatuses)
    .values({
      userId,
      status:         'stopping' as any,
      activeMarkets:  current.activeMarkets ?? [],
      stopMode:       'graceful',
      stoppingAt:     now,
      updatedAt:      now,
      stopTimeoutSec: 3600,
    })
    .onConflictDoUpdate({
      target: botStatuses.userId,
      set: {
        status:         'stopping' as any,
        stopMode:       'graceful',
        stoppingAt:     now,
        updatedAt:      now,
        errorMessage:   null,
        stopTimeoutSec: 3600,
      },
    })

  return NextResponse.json({
    success:    true,
    status:     'stopping',
    mode:       'graceful',
    openTrades: openCount,
  })
}

async function _countOpenTrades(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trades)
    .where(and(eq(trades.userId, userId), eq(trades.status, 'open' as any)))
  return rows[0]?.count ?? 0
}

async function _notifyBotEngine(userId: string, action: 'stop' | 'drain' | 'close_all') {
  const endpoint = action === 'stop'      ? '/bot/stop'
                 : action === 'drain'     ? '/bot/drain'
                 : '/bot/close-all'

  await fetch(`${process.env.BOT_ENGINE_URL}${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
    },
    body:   JSON.stringify({ user_id: userId }),
    signal: AbortSignal.timeout(8_000),
  })
}