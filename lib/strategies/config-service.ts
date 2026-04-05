import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { marketStrategyConfigs, marketStrategySelections, strategies } from '@/lib/schema'
import { ensureStrategyCatalogSeeded } from './catalog'
import { validateStrategiesForMarket } from './validation'

export async function getUserMarketStrategyConfig(
  userId: string,
  marketType: 'indian' | 'crypto' | 'commodities' | 'global',
) {
  await ensureStrategyCatalogSeeded()

  const config = await db.query.marketStrategyConfigs.findFirst({
    where: and(
      eq(marketStrategyConfigs.userId, userId),
      eq(marketStrategyConfigs.marketType, marketType),
    ),
    with: {
      selections: {
        with: {
          strategy: true,
        },
      },
    },
  })

  return {
    executionMode: config?.executionMode ?? 'SAFE',
    strategyKeys: (config?.selections ?? [])
      .sort((a, b) => (a.slot > b.slot ? 1 : -1))
      .map((selection) => selection.strategy.strategyKey),
  }
}

export async function upsertUserMarketStrategyConfig(params: {
  userId: string
  marketType: 'indian' | 'crypto' | 'commodities' | 'global'
  executionMode: 'SAFE' | 'AGGRESSIVE'
  strategyKeys: string[]
}) {
  await ensureStrategyCatalogSeeded()
  validateStrategiesForMarket(params.marketType, params.strategyKeys)

  const strategyRows = await db.query.strategies.findMany({
    where: inArray(strategies.strategyKey, params.strategyKeys),
    columns: { id: true, strategyKey: true },
  })

  if (strategyRows.length !== params.strategyKeys.length) {
    throw new Error('One or more strategies are unavailable.')
  }

  const existing = await db.query.marketStrategyConfigs.findFirst({
    where: and(
      eq(marketStrategyConfigs.userId, params.userId),
      eq(marketStrategyConfigs.marketType, params.marketType),
    ),
    columns: { id: true },
  })

  const now = new Date()
  const configId = existing?.id ?? (
    await db.insert(marketStrategyConfigs).values({
      userId: params.userId,
      marketType: params.marketType,
      executionMode: params.executionMode,
      updatedAt: now,
    }).returning({ id: marketStrategyConfigs.id })
  )[0].id

  if (existing) {
    await db.update(marketStrategyConfigs)
      .set({ executionMode: params.executionMode, updatedAt: now })
      .where(eq(marketStrategyConfigs.id, existing.id))
  }

  await db.delete(marketStrategySelections).where(eq(marketStrategySelections.configId, configId))

  if (strategyRows.length > 0) {
    const byKey = new Map(strategyRows.map((row) => [row.strategyKey, row.id]))
    await db.insert(marketStrategySelections).values(
      params.strategyKeys.map((key, index) => ({
        configId,
        strategyId: byKey.get(key)!,
        slot: (index === 0 ? 'PRIMARY' : 'SECONDARY') as 'PRIMARY' | 'SECONDARY',
      })),
    )
  }

  return getUserMarketStrategyConfig(params.userId, params.marketType)
}
