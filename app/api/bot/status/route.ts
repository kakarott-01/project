// app/api/bot/status/route.ts
// ===========================
// REVISED: exposes stopMode, openTradeCount, stoppingAt, and a
// timeoutWarning flag so the UI can show alerts when drain takes too long.

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { botStatuses, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'

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