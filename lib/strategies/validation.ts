import { z } from 'zod'
import { PUBLIC_STRATEGY_CATALOG, mapPlatformMarketToStrategyMarket } from './catalog'

export const strategyConfigSchema = z.object({
  marketType: z.enum(['indian', 'crypto', 'commodities', 'global']),
  executionMode: z.enum(['SAFE', 'AGGRESSIVE']).default('SAFE'),
  positionMode: z.enum(['NET', 'HEDGE']).default('NET'),
  allowHedgeOpposition: z.boolean().default(false),
  conflictBlocking: z.boolean().default(false),
  aggressiveConfirmed: z.boolean().default(false),
  maxPositionsPerSymbol: z.number().int().min(1).max(10).default(2),
  maxCapitalPerStrategyPct: z.number().min(1).max(100).default(25),
  maxDrawdownPct: z.number().min(1).max(100).default(12),
  strategyKeys: z.array(z.string().min(1)).min(1).max(2),
})

export const backtestRequestSchema = z.object({
  marketType: z.enum(['indian', 'crypto', 'commodities', 'global']),
  asset: z.string().min(1).max(100),
  timeframe: z.string().min(2).max(20),
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  initialCapital: z.number().positive(),
  executionMode: z.enum(['SAFE', 'AGGRESSIVE']).default('SAFE'),
  positionMode: z.enum(['NET', 'HEDGE']).default('NET'),
  allowHedgeOpposition: z.boolean().default(false),
  strategyKeys: z.array(z.string().min(1)).min(1).max(2),
  comparisonLabel: z.string().max(150).optional(),
})

export function validateStrategiesForMarket(
  marketType: 'indian' | 'crypto' | 'commodities' | 'global',
  strategyKeys: string[],
  timeframe?: string,
) {
  const uniq = Array.from(new Set(strategyKeys))
  if (uniq.length !== strategyKeys.length) {
    throw new Error('Duplicate strategies are not allowed.')
  }
  if (uniq.length === 0 || uniq.length > 2) {
    throw new Error('Select between 1 and 2 strategies per market.')
  }

  const publicMarket = mapPlatformMarketToStrategyMarket(marketType)
  for (const key of uniq) {
    const item = PUBLIC_STRATEGY_CATALOG.find((strategy) => strategy.strategyKey === key)
    if (!item) {
      throw new Error(`Unknown strategy: ${key}`)
    }
    if (!item.supportedMarkets.includes(publicMarket)) {
      throw new Error(`${key} does not support ${publicMarket}.`)
    }
    if (timeframe && !item.supportedTimeframes.includes(timeframe)) {
      throw new Error(`${key} does not support timeframe ${timeframe}.`)
    }
  }
}
