'use client'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { ToastViewport } from '@/components/ui/toast-viewport'
import { useToastStore } from '@/lib/toast-store'
import { QUERY_KEYS } from '@/lib/query-keys'

// Financial queries that must NOT use stale placeholder data
const FINANCIAL_QUERY_KEYS = new Set([
  // Use the canonical keys from QUERY_KEYS so changes remain centralized
  QUERY_KEYS.TRADES_SUMMARY[0],
  QUERY_KEYS.PERFORMANCE().at(0)!,
  QUERY_KEYS.DAILY_PNL().at(0)!,
  QUERY_KEYS.TRADES().at(0)!,
])

// Track if we've already shown the session expired toast to prevent spam
let sessionExpiredToastShown = false

export function Providers({ children }: { children: React.ReactNode }) {
  const pushToast = useToastStore((s) => s.push)

  const [queryClient] = useState(() => new QueryClient({
    queryCache: new QueryCache({
      onError: (error: Error & { status?: number }, query) => {
        if (typeof window === 'undefined') return

        if (error.status === 401 && window.location.pathname !== '/login') {
          // FIX: Only show session expired for user-initiated queries, not background polling
          // Check if query was recently active (within last 5s = user-triggered)
          const isBackgroundPoll = query.state.fetchStatus === 'fetching' &&
            query.state.dataUpdatedAt > 0 &&
            Date.now() - query.state.dataUpdatedAt < 30_000

          if (!isBackgroundPoll && !sessionExpiredToastShown) {
            sessionExpiredToastShown = true
            try { window.localStorage.setItem('sessionExpired', '1') } catch (_) {}
            try {
              pushToast({ tone: 'error', title: 'Session expired', description: 'Please re-login.' })
            } catch (_) {}
            // Reset flag after 10s so it can show again if needed
            setTimeout(() => { sessionExpiredToastShown = false }, 10_000)
          }
          return
        }

        if (error.status === 403 && window.location.pathname !== '/access') {
          try { window.localStorage.setItem('accessDenied', '1') } catch (_) {}
          try {
            pushToast({ tone: 'error', title: 'Access denied', description: 'You no longer have access.' })
          } catch (_) {}
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchInterval: 15_000,
        refetchOnWindowFocus: false,
        // FIX: Only use placeholder data for non-financial queries
        // Financial data (P&L, trades) should show loading state, not stale numbers
        placeholderData: (prev: any, query: any) => {
          const firstKey = query?.queryKey?.[0]
          if (typeof firstKey === 'string' && FINANCIAL_QUERY_KEYS.has(firstKey)) {
            return undefined  // Show loading skeleton for financial data
          }
          return prev  // Keep stale data for UI state (bot status, configs)
        },
        retry: 1,
      },
    },
  }))

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ToastViewport />
    </QueryClientProvider>
  )
}