'use client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // Data is considered fresh for 5s (was 10s) — feels more responsive
        staleTime:        5_000,
        // Background refetch every 10s (was 15s)
        refetchInterval:  10_000,
        // Don't refetch on window focus — prevents jarring re-renders
        refetchOnWindowFocus: false,
        // Keep previous data while fetching so UI never goes blank
        placeholderData: (prev: any) => prev,
        // Retry once on error, not 3 times
        retry: 1,
      },
    },
  }))

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}