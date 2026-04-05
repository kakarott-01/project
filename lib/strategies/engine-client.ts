type BacktestEngineRequest = {
  userId: string
  marketType: 'indian' | 'crypto' | 'commodities' | 'global'
  asset: string
  timeframe: string
  dateFrom: string
  dateTo: string
  initialCapital: number
  executionMode: 'SAFE' | 'AGGRESSIVE'
  positionMode: 'NET' | 'HEDGE'
  allowHedgeOpposition: boolean
  strategyKeys: string[]
}

export async function runEngineBacktest(payload: BacktestEngineRequest) {
  const response = await fetch(`${process.env.BOT_ENGINE_URL}/backtests/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
    },
    body: JSON.stringify({
      user_id: payload.userId,
      market_type: payload.marketType,
      asset: payload.asset,
      timeframe: payload.timeframe,
      date_from: payload.dateFrom,
      date_to: payload.dateTo,
      initial_capital: payload.initialCapital,
      execution_mode: payload.executionMode,
      position_mode: payload.positionMode,
      allow_hedge_opposition: payload.allowHedgeOpposition,
      strategy_keys: payload.strategyKeys,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.detail ?? 'Backtest engine request failed.')
  }

  return body
}
