import type { QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-client'
import { QUERY_KEYS } from '@/lib/query-keys'

export const BOT_STATUS_QUERY_KEY = QUERY_KEYS.BOT_STATUS
// FIX: Increased from 5s to 8s to reduce Neon connection pressure
export const BOT_STATUS_POLL_INTERVAL_MS = 8_000

export type BotStatusSessionSnapshot = {
  market: string
  status: 'running' | 'stopped' | 'error'
  sessionId: string | null
  mode: 'paper' | 'live' | null
  started_at: string | null
  stopped_at: string | null
  exchange: string | null
  openTrades: number
  totalTrades: number
  totalPnl: string | number | null
  metadata: unknown
}

export type BotStatusSnapshot = {
  status: 'running' | 'stopped' | 'stopping' | 'error'
  stopMode: string | null
  activeMarkets: string[]
  started_at: string | null
  stopped_at: string | null
  stopping_at: string | null
  last_heartbeat: string | null
  errorMessage: string | null
  openTradeCount: number
  perMarketOpenTrades: Record<string, number>
  timeoutWarning: boolean
  sessions: BotStatusSessionSnapshot[]
}

export async function fetchBotStatus(): Promise<BotStatusSnapshot> {
  return apiFetch<BotStatusSnapshot>('/api/bot/status', { cache: 'no-store' })
}

export function isValidBotSnapshot(data: unknown): data is BotStatusSnapshot {
  if (!data || typeof data !== 'object') return false
  const d = data as any
  if (typeof d.status !== 'string') return false
  if (!('activeMarkets' in d) || !Array.isArray(d.activeMarkets)) return false
  return true
}

// Dead code removed: getBotStatusSignature was never used
export function getBotSyncEventType(snapshot: BotStatusSnapshot): 'BOT_STARTED' | 'BOT_STOPPED' | 'BOT_UPDATED' {
  if (snapshot.status === 'running' && snapshot.started_at) return 'BOT_STARTED'
  if (snapshot.status === 'stopped') return 'BOT_STOPPED'
  return 'BOT_UPDATED'
}

export function applyBotStatusSnapshot(
  queryClient: QueryClient,
  snapshot: BotStatusSnapshot,
  source: string,
) {
  if (!isValidBotSnapshot(snapshot)) {
    console.warn('[bot-sync] rejected invalid snapshot from', source, snapshot)
    return
  }

  const previous = queryClient.getQueryData<BotStatusSnapshot>(BOT_STATUS_QUERY_KEY)

  if (
    previous?.status === 'running' &&
    snapshot.status === 'running' &&
    previous.started_at &&
    snapshot.started_at &&
    previous.started_at !== snapshot.started_at
  ) {
    console.warn('[bot-sync] started_at changed while bot remained running', {
      source,
      previousStartedAt: previous.started_at,
      nextStartedAt: snapshot.started_at,
    })
  }

  queryClient.setQueryData(BOT_STATUS_QUERY_KEY, snapshot)
}

export async function refreshBotStatus(queryClient: QueryClient, source: string) {
  const snapshot = await queryClient.fetchQuery({
    queryKey: BOT_STATUS_QUERY_KEY,
    queryFn: fetchBotStatus,
    staleTime: 0,
  })

  applyBotStatusSnapshot(queryClient, snapshot, source)
  return snapshot
}