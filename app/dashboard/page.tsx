// ═══════════════════════════════════════════════════════════════════════════════
// app/dashboard/page.tsx  — FIXED
// ═══════════════════════════════════════════════════════════════════════════════
// FIX (medium): Dashboard P&L chart was recalculating cumulative PnL from the
//               /api/trades endpoint which is limited to 50 rows. Users with
//               >50 trades saw a partial/incorrect cumulative chart.
//
//               Now fetches cumPnl from /api/performance which has NO row limit
//               and returns pre-computed cumulative data.
// ═══════════════════════════════════════════════════════════════════════════════

'use client'
import { useQuery }       from '@tanstack/react-query'
import { TrendingUp, Activity, DollarSign } from 'lucide-react'
import { PnlChart }       from '@/components/charts/pnl-chart'
import { TradeTable }     from '@/components/dashboard/trade-table'
import { BotControls }    from '@/components/dashboard/bot-controls'
import { formatCurrency } from '@/lib/utils'

export default function DashboardPage() {
  // Accurate summary stats — no row limit
  const { data: summaryData } = useQuery({
    queryKey: ['trades-summary'],
    queryFn:  () => fetch('/api/trades/summary').then(r => r.json()),
    refetchInterval: 15_000,
  })

  // FIX: Fetch cumulative PnL from /api/performance (full history, no row limit)
  // Use staleTime=60s — this chart doesn't need to be as fresh as stat cards
  const { data: perfData } = useQuery({
    queryKey: ['performance-chart'],
    queryFn:  () => fetch('/api/performance').then(r => r.json()),
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  // Recent trades for the table only (50-row limit is fine for a preview table)
  const { data: tradesData } = useQuery({
    queryKey: ['trades'],
    queryFn:  () => fetch('/api/trades?limit=50').then(r => r.json()),
  })

  const { data: botData, isLoading: botLoading } = useQuery({
    queryKey:        ['bot-status'],
    queryFn:         () => fetch('/api/bot/status').then(r => r.json()),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  })

  const { data: strategyConfigData } = useQuery({
    queryKey: ['strategy-configs'],
    queryFn: () => fetch('/api/strategy-config').then(r => r.json()),
    staleTime: 30_000,
  })

  const summary        = summaryData ?? { totalPnl: 0, winRate: 0, total: 0, closed: 0 }
  const recentTrades   = tradesData?.trades?.slice(0, 10) ?? []
  // FIX: Use pre-computed cumPnl from performance endpoint (full history)
  const cumPnlData     = perfData?.cumPnl ?? []

  const botStatus        = botData?.status ?? 'stopped'
  const botIsRunning     = botStatus === 'running'
  const botActiveMarkets = botData?.activeMarkets ?? []
  const aggressiveMarkets = (strategyConfigData?.markets ?? [])
    .filter((market: any) => market.executionMode === 'AGGRESSIVE')
    .map((market: any) => market.marketType)

  return (
    <div className="space-y-5 max-w-7xl mx-auto px-3 sm:px-4">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <BotControls botData={botData} />
      </div>

      {aggressiveMarkets.length > 0 && (
        <div className="bg-red-950/25 border border-red-900/35 rounded-xl px-4 py-3 text-sm text-red-200">
          AGGRESSIVE MODE ENABLED for: {aggressiveMarkets.join(', ')}. Strategies run independently, volatility is higher, and opposite trades may occur when hedge mode is active.
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">

        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <span className="stat-label">Net P&L</span>
            <DollarSign className="w-4 h-4 text-gray-700" />
          </div>
          <div className={`stat-value ${summary.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
            {formatCurrency(summary.totalPnl)}
          </div>
          <span className="stat-sub">
            All time
            {typeof summary.totalFees === 'number' ? ` · Fees ${formatCurrency(summary.totalFees)}` : ''}
          </span>
        </div>

        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <span className="stat-label">Win Rate</span>
            <Activity className="w-4 h-4 text-gray-700" />
          </div>
          <div className={`stat-value ${summary.winRate >= 50 ? 'pnl-positive' : 'pnl-negative'}`}>
            {summary.winRate.toFixed(1)}%
          </div>
          <span className="stat-sub">{summary.closed} closed trades</span>
        </div>

        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <span className="stat-label">Total Trades</span>
            <TrendingUp className="w-4 h-4 text-gray-700" />
          </div>
          <div className="stat-value">{summary.total}</div>
          <span className="stat-sub">Since inception</span>
        </div>

        <div className="stat-card">
          <div className="flex items-center justify-between mb-1">
            <span className="stat-label">Bot Status</span>
            {botLoading && !botData ? (
              <span className="w-2 h-2 rounded-full bg-gray-700 animate-pulse" />
            ) : (
              <span className={`w-2 h-2 rounded-full ${botIsRunning ? 'bg-brand-500 animate-pulse' : 'bg-gray-700'}`} />
            )}
          </div>
          {botLoading && !botData ? (
            <>
              <div className="h-5 w-20 bg-gray-800 rounded animate-pulse mb-1" />
              <div className="h-3 w-28 bg-gray-800 rounded animate-pulse" />
            </>
          ) : (
            <>
              <div className={`stat-value text-base font-medium ${botIsRunning ? 'text-brand-500' : 'text-gray-500'}`}>
                {botIsRunning ? 'Running' : 'Stopped'}
              </div>
              <span className="stat-sub">
                {botActiveMarkets.length ? botActiveMarkets.join(' · ') : 'No active markets'}
              </span>
            </>
          )}
        </div>

      </div>

      {/* P&L Chart — FIX: uses full-history cumPnl from /api/performance */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Cumulative P&L</h2>
          <span className="badge-gray">All time</span>
        </div>
        <PnlChart cumPnlData={cumPnlData} />
      </div>

      {/* Recent Trades */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-gray-300">Recent Trades</h2>
          <a href="/dashboard/trades" className="text-xs text-brand-500 hover:text-brand-600 transition-colors">
            View all →
          </a>
        </div>
        <TradeTable trades={recentTrades} compact />
      </div>

    </div>
  )
}
