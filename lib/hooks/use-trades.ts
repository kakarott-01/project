'use client'

import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { QUERY_KEYS } from '@/lib/query-keys'
import { apiFetch } from '@/lib/api-client'
import { useCallback } from 'react'
import { POLL_INTERVALS } from '@/lib/polling-config'

export type Trade = {
  id:           string
  symbol:       string
  side:         'buy' | 'sell'
  marketType:   string
  quantity:     string
  entryPrice:   string
  exitPrice:    string | null
  pnl:          string | null
  netPnl:       string | null
  feeAmount:    string | null
  status:       string
  isPaper:      boolean
  openedAt:     string
  closedAt:     string | null
  exchangeName: string
}

export type Pagination = {
  page:    number
  limit:   number
  total:   number
  pages:   number
  hasMore: boolean
}

export type TradesResponse = {
  trades: Trade[]
  pagination: Pagination
  summary: {
    total: number
    closed: number
    totalPnl: number
    totalFees?: number
    winRate: number
  }
}

export default function useTrades({ market = 'all', status = 'all', mode = 'all', page = 1 } = {}): {
  data?: TradesResponse
  isLoading: boolean
  refetch: UseQueryResult<TradesResponse>['refetch']
  prefetchPage: (p: number) => void
} {
  const qc = useQueryClient()

  const buildParams = useCallback((p: number) => {
    const params = new URLSearchParams({ page: String(p), limit: '50' })
    if (market !== 'all') params.set('market', market)
    if (status !== 'all') params.set('status', status)
    if (mode   !== 'all') params.set('mode',   mode)
    return params
  }, [market, status, mode])

  const { data, isLoading, refetch } = useQuery<TradesResponse>({
    queryKey: QUERY_KEYS.TRADES({ market, status, mode, page }),
    queryFn:  () => apiFetch<TradesResponse>(`/api/trades?${buildParams(page)}`),
    staleTime: POLL_INTERVALS.BOT_IDLE,
    placeholderData: (prev: any) => prev,
  })

  const prefetchPage = useCallback((p: number) => {
    qc.prefetchQuery({
      queryKey: QUERY_KEYS.TRADES({ market, status, mode, page: p }),
      queryFn:  () => apiFetch<TradesResponse>(`/api/trades?${buildParams(p)}`),
      staleTime: POLL_INTERVALS.STRATEGY,
    })
  }, [qc, market, status, mode, buildParams])

  return { data, isLoading, refetch, prefetchPage }
}
