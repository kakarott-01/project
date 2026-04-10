'use client'

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import {
  BOT_STATUS_POLL_INTERVAL_MS,
  BOT_STATUS_QUERY_KEY,
  type BotStatusSnapshot,
  fetchBotStatus,
} from '@/lib/bot-status-client'

export function useBotStatusQuery(
  options?: Omit<UseQueryOptions<BotStatusSnapshot>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<BotStatusSnapshot>({
    queryKey: BOT_STATUS_QUERY_KEY,
    queryFn: fetchBotStatus,
    // react-query types differ across versions — accept either the raw data
    // or the Query object and extract the snapshot safely.
    refetchInterval: (maybeDataOrQuery: any) => {
      const data: BotStatusSnapshot | undefined =
        maybeDataOrQuery && typeof maybeDataOrQuery.status === 'string'
          ? maybeDataOrQuery
          : maybeDataOrQuery?.data ?? maybeDataOrQuery?.state?.data

      if (!data) return BOT_STATUS_POLL_INTERVAL_MS
      return data.status === 'running' || data.status === 'stopping' ? 3_000 : 10_000
    },
    placeholderData: (prev) => prev,
    ...options,
  })
}
