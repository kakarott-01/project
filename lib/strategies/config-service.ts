import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { exchangeApis, marketStrategyConfigs, marketStrategySelections, strategies } from '@/lib/schema'
import { ensureStrategyCatalogSeeded } from './catalog'
import { validateStrategiesForMarket } from './validation'
import { analyzeStrategyConflicts, hasBlockingConflict } from './conflicts'
import { resolveExchangeCapabilities } from './exchange-capabilities'
import type { MarketType, StrategyRuntimeConfig } from './types'

export async function getUserMarketStrategyConfig(
  userId: string,
  marketType: MarketType,
): Promise<StrategyRuntimeConfig> {
  await ensureStrategyCatalogSeeded()

  const [config, exchangeApi] = await Promise.all([
    db.query.marketStrategyConfigs.findFirst({
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
    }),
    db.query.exchangeApis.findFirst({
      where: and(
        eq(exchangeApis.userId, userId),
        eq(exchangeApis.marketType, marketType),
        eq(exchangeApis.isActive, true),
      ),
      columns: {
        exchangeName: true,
      },
    }),
  ])

  const strategyKeys = (config?.selections ?? [])
    .sort((a, b) => (a.slot > b.slot ? 1 : -1))
    .map((selection) => selection.strategy.strategyKey)
  const conflictWarnings = config?.conflictWarnings ?? analyzeStrategyConflicts(strategyKeys)
  const exchangeCapabilities = resolveExchangeCapabilities(
    exchangeApi?.exchangeName,
    config?.positionMode ?? 'NET',
  )

  return {
    executionMode: config?.executionMode ?? 'SAFE',
    positionMode: exchangeCapabilities.effectivePositionMode,
    allowHedgeOpposition: config?.allowHedgeOpposition ?? false,
    conflictBlocking: config?.conflictBlocking ?? false,
    maxPositionsPerSymbol: config?.maxPositionsPerSymbol ?? 2,
    maxCapitalPerStrategyPct: Number(config?.maxCapitalPerStrategyPct ?? '25'),
    maxDrawdownPct: Number(config?.maxDrawdownPct ?? '12'),
    strategyKeys,
    conflictWarnings: [
      ...conflictWarnings,
      ...(exchangeCapabilities.warning
        ? [{ code: 'EXCHANGE_HEDGE_FALLBACK', severity: 'warning' as const, message: exchangeCapabilities.warning }]
        : []),
    ],
    exchangeCapabilities,
  }
}

export async function upsertUserMarketStrategyConfig(params: {
  userId: string
  marketType: MarketType
  executionMode: 'SAFE' | 'AGGRESSIVE'
  positionMode: 'NET' | 'HEDGE'
  allowHedgeOpposition: boolean
  conflictBlocking: boolean
  aggressiveConfirmed: boolean
  maxPositionsPerSymbol: number
  maxCapitalPerStrategyPct: number
  maxDrawdownPct: number
  strategyKeys: string[]
}) {
  await ensureStrategyCatalogSeeded()
  validateStrategiesForMarket(params.marketType, params.strategyKeys)

  const conflicts = analyzeStrategyConflicts(params.strategyKeys)
  if (params.conflictBlocking && conflicts.length > 0) {
    throw new Error('Strategy conflict blocking is enabled. Resolve conflicts or disable blocking before saving.')
  }
  if (hasBlockingConflict(conflicts)) {
    throw new Error('Selected strategy combination is blocked by conflict policy.')
  }
  if (params.executionMode === 'AGGRESSIVE' && !params.aggressiveConfirmed) {
    throw new Error('AGGRESSIVE mode requires explicit confirmation.')
  }
  if (params.positionMode === 'HEDGE' && params.executionMode !== 'AGGRESSIVE') {
    throw new Error('HEDGE mode is only available with AGGRESSIVE execution.')
  }

  const strategyRows = await db.query.strategies.findMany({
    where: inArray(strategies.strategyKey, params.strategyKeys),
    columns: { id: true, strategyKey: true },
  })

  if (strategyRows.length !== params.strategyKeys.length) {
    throw new Error('One or more strategies are unavailable.')
  }

  const exchangeApi = await db.query.exchangeApis.findFirst({
    where: and(
      eq(exchangeApis.userId, params.userId),
      eq(exchangeApis.marketType, params.marketType),
      eq(exchangeApis.isActive, true),
    ),
    columns: { exchangeName: true },
  })

  const exchangeCapabilities = resolveExchangeCapabilities(
    exchangeApi?.exchangeName,
    params.positionMode,
  )

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
      positionMode: exchangeCapabilities.effectivePositionMode,
      allowHedgeOpposition: params.allowHedgeOpposition && exchangeCapabilities.effectivePositionMode === 'HEDGE',
      conflictBlocking: params.conflictBlocking,
      aggressiveConfirmedAt: params.executionMode === 'AGGRESSIVE' ? now : null,
      maxPositionsPerSymbol: params.maxPositionsPerSymbol,
      maxCapitalPerStrategyPct: params.maxCapitalPerStrategyPct.toFixed(2),
      maxDrawdownPct: params.maxDrawdownPct.toFixed(2),
      conflictWarnings: conflicts,
      exchangeCapabilities,
      updatedAt: now,
    }).returning({ id: marketStrategyConfigs.id })
  )[0].id

  if (existing) {
    await db.update(marketStrategyConfigs)
      .set({
        executionMode: params.executionMode,
        positionMode: exchangeCapabilities.effectivePositionMode,
        allowHedgeOpposition: params.allowHedgeOpposition && exchangeCapabilities.effectivePositionMode === 'HEDGE',
        conflictBlocking: params.conflictBlocking,
        aggressiveConfirmedAt: params.executionMode === 'AGGRESSIVE' ? now : null,
        maxPositionsPerSymbol: params.maxPositionsPerSymbol,
        maxCapitalPerStrategyPct: params.maxCapitalPerStrategyPct.toFixed(2),
        maxDrawdownPct: params.maxDrawdownPct.toFixed(2),
        conflictWarnings: conflicts,
        exchangeCapabilities,
        updatedAt: now,
      })
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
