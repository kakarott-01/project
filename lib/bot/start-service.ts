import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { botSessions, botStatuses, exchangeApis, marketConfigs } from '@/lib/schema'
import { getUserMarketStrategyConfig } from '@/lib/strategies/config-service'
import type { MarketType } from '@/lib/strategies/types'

export async function startBotForUser(userId: string, rawMarkets: MarketType[]) {
  const markets: MarketType[] = Array.from(new Set(rawMarkets))

  const existing = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, userId),
    columns: { status: true },
  })

  if (existing?.status === 'running') {
    const error = new Error('Bot is already running')
    ;(error as Error & { status?: number }).status = 409
    throw error
  }

  if (existing?.status === 'stopping') {
    const error = new Error('Bot is currently stopping. Wait for it to finish before restarting.')
    ;(error as Error & { status?: number }).status = 409
    throw error
  }

  await db
    .update(botSessions)
    .set({ status: 'stopped', endedAt: new Date() })
    .where(and(
      eq(botSessions.userId, userId),
      eq(botSessions.status, 'running'),
    ))

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
    if (config.conflictBlocking && config.conflictWarnings.length > 0) {
      const error = new Error(`Strategy conflicts block startup for ${market}.`)
      ;(error as Error & { status?: number }).status = 400
      throw error
    }
  }

  const now = new Date()
  const sessionIds: Record<string, string> = {}
  const createdSessionIds: string[] = []

  for (const market of markets) {
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

  await db.insert(botStatuses)
    .values({
      userId,
      status: 'running',
      activeMarkets: markets,
      startedAt: now,
      stopMode: null,
      stoppingAt: null,
    })
    .onConflictDoUpdate({
      target: botStatuses.userId,
      set: {
        status: 'running',
        activeMarkets: markets,
        startedAt: now,
        errorMessage: null,
        stopMode: null,
        stoppingAt: null,
        updatedAt: now,
      },
    })

  let botRes: Response | null = null
  try {
    botRes = await fetch(`${process.env.BOT_ENGINE_URL}/bot/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
      },
      body: JSON.stringify({ user_id: userId, markets, session_ids: sessionIds }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    await rollbackBotStart(userId, createdSessionIds)
    const error = new Error('Bot engine is unreachable. Is the Render service running?')
    ;(error as Error & { status?: number }).status = 503
    throw error
  }

  if (!botRes.ok) {
    const engineBody = await botRes.json().catch(() => ({}))
    await rollbackBotStart(userId, createdSessionIds)
    const error = new Error(engineBody.detail ?? 'Bot engine returned an error')
    ;(error as Error & { status?: number; detail?: unknown }).status = botRes.status
    ;(error as Error & { detail?: unknown }).detail = engineBody
    throw error
  }

  return {
    success: true,
    status: 'running' as const,
    markets,
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
