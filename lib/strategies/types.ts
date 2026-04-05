export type MarketType = 'indian' | 'crypto' | 'commodities' | 'global'
export type ExecutionMode = 'SAFE' | 'AGGRESSIVE'
export type PositionMode = 'NET' | 'HEDGE'

export type ConflictSeverity = 'info' | 'warning' | 'blocking'

export type StrategyConflict = {
  code: string
  severity: ConflictSeverity
  message: string
}

export type ExchangeCapabilities = {
  supportsHedgeMode: boolean
  effectivePositionMode: PositionMode
  warning?: string
}

export type StrategyRuntimeConfig = {
  executionMode: ExecutionMode
  positionMode: PositionMode
  allowHedgeOpposition: boolean
  conflictBlocking: boolean
  maxPositionsPerSymbol: number
  maxCapitalPerStrategyPct: number
  maxDrawdownPct: number
  strategyKeys: string[]
  conflictWarnings: StrategyConflict[]
  exchangeCapabilities: ExchangeCapabilities | null
}
