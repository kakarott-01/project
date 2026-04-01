// app/api/bot/status/route.ts
// ===========================
// REVISED: Auto-detects graceful drain completion so the bot transitions
// to "stopped" the moment all positions close — without relying on the
// Python→Next.js HTTP callback (which can fail on Render cold starts).
//
// Also exposes stopMode, openTradeCount, stoppingAt, and timeoutWarning.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'
import { _doImmediateStop } from '@/lib/bot-stop'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const status = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, session.id),
  })

  if (!status) {
    return NextResponse.json({
      status:          'stopped',
      stopMode:        null,
      activeMarkets:   [],
      startedAt:       null,
      stoppingAt:      null,
      lastHeartbeat:   null,
      errorMessage:    null,
      openTradeCount:  0,
      timeoutWarning:  false,
    })
  }

  // Count open trades for running or stopping states
  let openTradeCount = 0
  if (status.status === 'stopping' || status.status === 'running') {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(trades)
      .where(and(
        eq(trades.userId, session.id),
        eq(trades.status, 'open' as any),
      ))
    openTradeCount = rows[0]?.count ?? 0
  }

  // ── Auto-detect graceful drain completion ─────────────────────────────────
  // Primary stop mechanism: does NOT rely on the Python→Next.js callback.
  // This route is polled every 5 s, so transition is near-instant after the
  // last position closes. Calling _doImmediateStop is idempotent — subsequent
  // polls will see status='stopped' in DB and skip this block.
  if (
    status.status === 'stopping' &&
    status.stopMode === 'graceful' &&
    openTradeCount === 0
  ) {
    const now = new Date()
    try {
      await _doImmediateStop(session.id, now)
    } catch (e) {
      console.error('[bot/status] Auto-stop after drain failed:', e)
    }
    return NextResponse.json({
      status:          'stopped',
      stopMode:        null,
      activeMarkets:   [],
      startedAt:       status.startedAt,
      stoppingAt:      null,
      lastHeartbeat:   status.lastHeartbeat,
      errorMessage:    null,
      openTradeCount:  0,
      timeoutWarning:  false,
    })
  }

  // Timeout warning: stopping has been active longer than stop_timeout_sec
  let timeoutWarning = false
  if (status.status === 'stopping' && status.stoppingAt) {
    const elapsedSec = (Date.now() - new Date(status.stoppingAt).getTime()) / 1000
    const timeout    = status.stopTimeoutSec ?? 300
    timeoutWarning   = elapsedSec > timeout
  }

  return NextResponse.json({
    status:          status.status,
    stopMode:        status.stopMode ?? null,
    activeMarkets:   status.activeMarkets ?? [],
    startedAt:       status.startedAt,
    stoppingAt:      (status as any).stoppingAt ?? null,
    lastHeartbeat:   status.lastHeartbeat,
    errorMessage:    status.errorMessage,
    openTradeCount,
    timeoutWarning,
  })
}