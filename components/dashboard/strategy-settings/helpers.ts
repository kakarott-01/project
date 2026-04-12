export function defaultStrategySettings() {
  return {
    priority: 'MEDIUM',
    cooldownAfterTradeSec: 0,
    capitalAllocation: {
      perTradePercent: 10,
      maxActivePercent: 25,
    },
    health: {
      minWinRatePct: 30,
      maxDrawdownPct: 15,
      maxLossStreak: 5,
      isAutoDisabled: false,
      autoDisabledReason: null,
      lastTradeAt: null,
    },
  }
}

export function toStrategyPayload(strategySettings: any) {
  return Object.fromEntries(
    Object.entries(strategySettings).map(([key, settings]: any) => [
      key,
      {
        priority: settings.priority,
        cooldownAfterTradeSec: settings.cooldownAfterTradeSec,
        capitalAllocation: settings.capitalAllocation,
      },
    ]),
  )
}
