import type { ExchangeCapabilities, PositionMode } from './types'

const HEDGE_SUPPORT: Record<string, boolean> = {
  binance: true,
  bingx: true,
  delta: true,
  deltaexch: true,
  kraken: false,
  coindcx: false,
  coinswitch: false,
  ibkr: false,
}

export function resolveExchangeCapabilities(
  exchangeName: string | null | undefined,
  requestedPositionMode: PositionMode,
): ExchangeCapabilities {
  const normalized = (exchangeName ?? '').trim().toLowerCase()
  const supportsHedgeMode = HEDGE_SUPPORT[normalized] ?? false

  if (requestedPositionMode === 'HEDGE' && !supportsHedgeMode) {
    return {
      supportsHedgeMode,
      effectivePositionMode: 'NET',
      warning: `Exchange ${exchangeName ?? 'unknown'} does not support hedge mode. Falling back to NET mode.`,
    }
  }

  return {
    supportsHedgeMode,
    effectivePositionMode: requestedPositionMode,
  }
}
