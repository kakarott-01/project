'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-client'
import { useCallback } from 'react'

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

export default function useTrades({ market = 'all', status = 'all', mode = 'all', page = 1 } = {}) {
  const qc = useQueryClient()

  const buildParams = useCallback((p: number) => {
    const params = new URLSearchParams({ page: String(p), limit: '50' })
    if (market !== 'all') params.set('market', market)
    if (status !== 'all') params.set('status', status)
    if (mode   !== 'all') params.set('mode',   mode)
    return params
  }, [market, status, mode])

  const { data, isLoading, refetch } = useQuery<TradesResponse>({
    queryKey: ['trades', market, status, mode, page],
    queryFn:  () => apiFetch<TradesResponse>(`/api/trades?${buildParams(page)}`),
    staleTime: 15_000,
    placeholderData: (prev: any) => prev,
  })

  const prefetchPage = useCallback((p: number) => {
    qc.prefetchQuery({
      queryKey: ['trades', market, status, mode, p],
      queryFn:  () => apiFetch<TradesResponse>(`/api/trades?${buildParams(p)}`),
      staleTime: 30_000,
    })
  }, [qc, market, status, mode, buildParams])

  return { data, isLoading, refetch, prefetchPage }
}
