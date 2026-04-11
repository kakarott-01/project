/**
 * Central registry of React Query keys.
 * Import these instead of using inline string literals.
 */

export const QUERY_KEYS = {
  BOT_STATUS: ['bot-status'] as const,
  MARKET_MODES: ['market-modes'] as const,
  STRATEGY_CONFIGS: ['strategy-configs'] as const,
  STRATEGY_CATALOG: ['strategy-catalog'] as const,
  RISK_SETTINGS: ['risk-settings'] as const,
  EXCHANGE_APIS: ['exchange-apis'] as const,
  ME: ['me'] as const,
  TRADES: (filters?: { market?: string; status?: string; mode?: string; page?: number }) =>
    filters ? ['trades', filters] : ['trades'],
  TRADES_SUMMARY: ['trades-summary'] as const,
  PERFORMANCE: (filters?: { mode?: string; market?: string }) =>
    filters ? ['performance', filters] : ['performance'],
  // Backwards-compat alias used in several places for the dashboard chart
  PERFORMANCE_CHART: ['performance-chart'] as const,
  DAILY_PNL: (filters?: { mode?: string; market?: string }) =>
    filters ? ['daily-pnl', filters] : ['daily-pnl'],
  BOT_HISTORY: (filters?: { page?: number; mode?: string; exchange?: string; from?: string; to?: string }) =>
    filters ? ['bot-history', filters] : ['bot-history'],
  MODE_AUDIT: ['mode-audit'] as const,
} as const