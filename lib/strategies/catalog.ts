import { db } from '@/lib/db'
import { strategies } from '@/lib/schema'

export type PublicStrategyCatalogItem = {
  strategyKey: string
  name: string
  description: string
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  supportedMarkets: Array<'CRYPTO' | 'STOCKS' | 'FOREX'>
  supportedTimeframes: string[]
  historicalPerformance: {
    winRate: number
    averageReturn: number
    maxDrawdown: number
    sharpeRatio: number
  }
}

export const PUBLIC_STRATEGY_CATALOG: PublicStrategyCatalogItem[] = [
  {
    strategyKey: 'TREND_RIDER_V1',
    name: 'TREND_RIDER_V1',
    description: 'Captures sustained directional moves and avoids low-conviction chop.',
    riskLevel: 'MEDIUM',
    supportedMarkets: ['CRYPTO', 'STOCKS', 'FOREX'],
    supportedTimeframes: ['5m', '15m', '1h'],
    historicalPerformance: { winRate: 58.4, averageReturn: 12.63, maxDrawdown: 8.91, sharpeRatio: 1.41 },
  },
  {
    strategyKey: 'MEAN_REVERSION_PRO',
    name: 'MEAN_REVERSION_PRO',
    description: 'Looks for stretched moves that statistically tend to normalize over short horizons.',
    riskLevel: 'LOW',
    supportedMarkets: ['CRYPTO', 'STOCKS'],
    supportedTimeframes: ['5m', '15m', '30m'],
    historicalPerformance: { winRate: 63.2, averageReturn: 9.84, maxDrawdown: 6.27, sharpeRatio: 1.58 },
  },
  {
    strategyKey: 'BREAKOUT_PULSE_X',
    name: 'BREAKOUT_PULSE_X',
    description: 'Prioritizes momentum expansion after compression and confirmed participation.',
    riskLevel: 'HIGH',
    supportedMarkets: ['CRYPTO', 'FOREX', 'STOCKS'],
    supportedTimeframes: ['15m', '1h', '4h'],
    historicalPerformance: { winRate: 51.7, averageReturn: 15.94, maxDrawdown: 12.35, sharpeRatio: 1.29 },
  },
]

let seedPromise: Promise<void> | null = null

export function mapPlatformMarketToStrategyMarket(marketType: 'indian' | 'crypto' | 'commodities' | 'global') {
  switch (marketType) {
    case 'crypto':
      return 'CRYPTO' as const
    case 'commodities':
      return 'FOREX' as const
    case 'indian':
    case 'global':
    default:
      return 'STOCKS' as const
  }
}

export async function ensureStrategyCatalogSeeded() {
  if (seedPromise) return seedPromise

  seedPromise = (async () => {
    for (const item of PUBLIC_STRATEGY_CATALOG) {
      const now = new Date()
      await db.insert(strategies).values({
        strategyKey: item.strategyKey,
        name: item.name,
        description: item.description,
        riskLevel: item.riskLevel,
        supportedMarkets: item.supportedMarkets,
        supportedTimeframes: item.supportedTimeframes,
        historicalWinRate: item.historicalPerformance.winRate.toFixed(2),
        historicalAvgReturn: item.historicalPerformance.averageReturn.toFixed(4),
        historicalMaxDrawdown: item.historicalPerformance.maxDrawdown.toFixed(4),
        historicalSharpeRatio: item.historicalPerformance.sharpeRatio.toFixed(4),
        updatedAt: now,
      }).onConflictDoUpdate({
        target: strategies.strategyKey,
        set: {
          name: item.name,
          description: item.description,
          riskLevel: item.riskLevel,
          supportedMarkets: item.supportedMarkets,
          supportedTimeframes: item.supportedTimeframes,
          historicalWinRate: item.historicalPerformance.winRate.toFixed(2),
          historicalAvgReturn: item.historicalPerformance.averageReturn.toFixed(4),
          historicalMaxDrawdown: item.historicalPerformance.maxDrawdown.toFixed(4),
          historicalSharpeRatio: item.historicalPerformance.sharpeRatio.toFixed(4),
          isActive: true,
          updatedAt: now,
        },
      })
    }
  })()

  try {
    await seedPromise
  } finally {
    seedPromise = null
  }
}
