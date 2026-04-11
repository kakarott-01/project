import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { botSessions, botStatuses, exchangeApis, marketConfigs, trades } from '@/lib/schema'
import { getUserMarketStrategyConfig } from '@/lib/strategies/config-service'
import type { MarketType } from '@/lib/strategies/types'
import { toUtcIsoString } from '@/lib/time'
import { postToBotEngine } from '@/lib/bot-engine-client'

export async function startBotForUser(
  userId: string,
  rawMarkets: MarketType[],
) {
  const markets: MarketType[] = Array.from(new Set(rawMarkets))

  const existing = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, userId),
    columns: { status: true, activeMarkets: true, startedAt: true },
  })

  if (existing?.status === 'stopping') {
    const error = new Error('Bot is currently stopping. Wait for it to finish before restarting.')
    ;(error as Error & { status?: number }).status = 409
    throw error
  }
  const isRunning = existing?.status === 'running'
  const currentMarkets = ((existing?.activeMarkets as MarketType[] | null) ?? []).filter(Boolean)
  const marketsToStart = markets.filter((market) => !currentMarkets.includes(market))
  const marketsToStop = currentMarkets.filter((market) => !markets.includes(market))

  if (!isRunning) {
    await db
      .update(botSessions)
      .set({ status: 'stopped', endedAt: new Date() })
      .where(and(
        eq(botSessions.userId, userId),
        eq(botSessions.status, 'running'),
      ))
  }

  const [allApis, allConfigs] = await Promise.all([
    db.query.exchangeApis.findMany({
      where: and(eq(exchangeApis.userId, userId), eq(exchangeApis.isActive, true)),
      columns: { id: true, marketType: true, exchangeName: true },
    }),
    db.query.marketConfigs.findMany({
      where: and(eq(marketConfigs.userId, userId), inArray(marketConfigs.marketType, markets as any[])),
      columns: { marketType: true, mode: true },
    }),
  ])

  const apiByMarket = new Map(allApis.map((item) => [item.marketType, item]))
  const configByMarket = new Map(allConfigs.map((item) => [item.marketType, item]))

  const missingMarkets = markets.filter((market) => !apiByMarket.has(market))
  if (missingMarkets.length > 0) {
    const error = new Error(`No exchange API configured for: ${missingMarkets.join(', ')}.`)
    ;(error as Error & { status?: number; missingMarkets?: string[] }).status = 400
    ;(error as Error & { missingMarkets?: string[] }).missingMarkets = missingMarkets
    throw error
  }

  const marketConfigsForEngine = await Promise.all(
    markets.map(async (market) => ({ market, config: await getUserMarketStrategyConfig(userId, market) })),
  )

  for (const { market, config } of marketConfigsForEngine) {
    if (config.strategyKeys.length === 0) {
      const error = new Error(`No strategy configured for ${market}. Configure at least one strategy before starting.`)
      ;(error as Error & { status?: number }).status = 400
      throw error
    }
  }

  for (const market of marketsToStop) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(trades)
      .where(and(
        eq(trades.userId, userId),
        eq(trades.marketType, market as any),
        eq(trades.status, 'open' as any),
      ))

    if ((rows[0]?.count ?? 0) > 0) {
      const error = new Error(`Cannot stop ${market} while it still has open trades. Close or drain those positions first.`)
      ;(error as Error & { status?: number }).status = 409
      throw error
    }
  }

  const now = new Date()
  const botStartedAt = isRunning ? existing?.startedAt ?? now : now
  const sessionIds: Record<string, string> = {}
  const createdSessionIds: string[] = []
  const stoppedSessionIds: string[] = []

  for (const market of marketsToStart) {
    const api = apiByMarket.get(market)
    const config = configByMarket.get(market)
    const strategyConfig = marketConfigsForEngine.find((item) => item.market === market)?.config

    const [newSession] = await db.insert(botSessions).values({
      userId,
      exchange: api?.exchangeName ?? 'unknown',
      market,
      mode: config?.mode ?? 'paper',
      status: 'running',
      startedAt: now,
      metadata: strategyConfig ? {
        executionMode: strategyConfig.executionMode,
        positionMode: strategyConfig.positionMode,
        exchangeCapabilities: strategyConfig.exchangeCapabilities,
        conflictWarnings: strategyConfig.conflictWarnings,
      } : undefined,
    }).returning({ id: botSessions.id })

    sessionIds[market] = newSession.id
    createdSessionIds.push(newSession.id)
  }

  if (marketsToStop.length > 0) {
    const stoppableSessions = await db.query.botSessions.findMany({
      where: and(
        eq(botSessions.userId, userId),
        inArray(botSessions.market, marketsToStop as any[]),
        eq(botSessions.status, 'running'),
      ),
      columns: { id: true },
    })
    stoppedSessionIds.push(...stoppableSessions.map((session) => session.id))
    await db
      .update(botSessions)
      .set({ status: 'stopped', endedAt: now })
      .where(and(
        eq(botSessions.userId, userId),
        inArray(botSessions.market, marketsToStop as any[]),
        eq(botSessions.status, 'running'),
      ))
  }

  const nextStatus = markets.length > 0 ? 'running' : 'stopped'
  await db.insert(botStatuses)
    .values({
      userId,
      status: nextStatus,
      activeMarkets: markets,
      startedAt: botStartedAt,
      stoppedAt: null,
      stopMode: null,
      stoppingAt: null,
    })
    .onConflictDoUpdate({
      target: botStatuses.userId,
      set: {
        status: nextStatus,
        activeMarkets: markets,
        startedAt: botStartedAt,
        stoppedAt: null,
        errorMessage: null,
        stopMode: null,
        stoppingAt: null,
        updatedAt: now,
      },
    })

  if (markets.length === 0) {
    return {
      success: true,
      status: 'stopped' as const,
      markets: [],
      sessionIds: {},
      marketConfigs: [],
    }
  }

  try {
    await postToBotEngine(isRunning ? '/bot/sync' : '/bot/start', {
      user_id: userId,
      markets,
      session_ids: sessionIds,
      started_at: toUtcIsoString(botStartedAt),
    }, 15_000)
  } catch (err) {
    if (isRunning) {
      await rollbackBotSync({ userId, createdSessionIds, stoppedSessionIds, marketsToRestore: currentMarkets })
    } else {
      await rollbackBotStart(userId, createdSessionIds)
    }
    const e = err instanceof Error ? err : new Error('Bot engine error')
    const error = new Error(e.message ?? 'Bot engine is unreachable. Is the Render service running?') as any
    error.status = (err as any)?.status ?? 503
    if ((err as any)?.data) error.detail = (err as any).data
    throw error
  }

  return {
    success: true,
    status: 'running' as const,
    markets,
    started_at: toUtcIsoString(botStartedAt),
    sessionIds,
    marketConfigs: marketConfigsForEngine,
  }
}

export async function rollbackBotStart(userId: string, sessionIds: string[]) {
  const now = new Date()
  await Promise.all([
    ...sessionIds.map((sid) => db.update(botSessions).set({ status: 'stopped', endedAt: now }).where(eq(botSessions.id, sid))),
    db.update(botStatuses)
      .set({
        status: 'stopped',
        errorMessage: 'Bot failed to start — engine unreachable or returned error.',
        activeMarkets: [],
        stoppedAt: now,
        updatedAt: now,
      })
      .where(eq(botStatuses.userId, userId)),
  ])
}

export async function rollbackBotSync(params: {
  userId: string
  createdSessionIds: string[]
  stoppedSessionIds: string[]
  marketsToRestore: MarketType[]
}) {
  const now = new Date()
  const work = [
    ...params.createdSessionIds.map((sid) =>
      db.update(botSessions).set({ status: 'stopped', endedAt: now }).where(eq(botSessions.id, sid)),
    ),
    db.update(botStatuses)
      .set({
        status: 'running',
        activeMarkets: params.marketsToRestore,
        updatedAt: now,
      })
      .where(eq(botStatuses.userId, params.userId)),
  ]

  if (params.stoppedSessionIds.length > 0) {
    work.push(
      db.update(botSessions)
        .set({ status: 'running', endedAt: null })
        .where(inArray(botSessions.id, params.stoppedSessionIds as any[])),
    )
  }

  await Promise.all(work)
}
