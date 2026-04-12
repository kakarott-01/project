'use client'

import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { BOT_STATUS_QUERY_KEY, type BotStatusSnapshot, fetchBotStatus } from '@/lib/bot-status-client'
import { POLL_INTERVALS } from '@/lib/polling-config'

export function useBotStatusQuery(
  options?: Omit<UseQueryOptions<BotStatusSnapshot, unknown, BotStatusSnapshot>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<BotStatusSnapshot, unknown, BotStatusSnapshot>({
    queryKey: BOT_STATUS_QUERY_KEY,
    queryFn: fetchBotStatus,
    // Reduce broad re-renders across subscribers by tracking changed props only
    refetchInterval: (maybeDataOrQuery: any) => {
      const data: BotStatusSnapshot | undefined =
        maybeDataOrQuery && typeof maybeDataOrQuery.status === 'string'
          ? maybeDataOrQuery
          : maybeDataOrQuery?.data ?? maybeDataOrQuery?.state?.data

      if (!data) return POLL_INTERVALS.BOT_RUNNING
      // Use unified polling constants
      return data.status === 'running' || data.status === 'stopping'
        ? POLL_INTERVALS.BOT_RUNNING
        : POLL_INTERVALS.BOT_IDLE
    },
    placeholderData: (prev) => prev,
    ...options,
  })
}