'use client'

import { useQuery } from '@tanstack/react-query'
import { QUERY_KEYS } from '@/lib/query-keys'
import { BarChart3, ArrowUpRight, TrendingUp, TrendingDown, Layers } from 'lucide-react'
import dynamic from 'next/dynamic'
import { POLL_INTERVALS } from '@/lib/polling-config'
import { useBotStatusQuery } from '@/lib/use-bot-status-query'
import { apiFetch } from '@/lib/api-client'
import { SectionErrorBoundary } from '@/components/ui/section-error-boundary'

const TradeTable  = dynamic(() => import('@/components/dashboard/trade-table').then(m => m.TradeTable))
const BotControls = dynamic(() => import('@/components/dashboard/bot-controls').then(m => m.BotControls))
import type { Trade } from '@/components/dashboard/trade-table'

type TradesSummaryResponse = {
  total:    number
  closed:   number
  totalPnl: number
  totalFees: number
  winRate:  number
  avgWin?:  number
  avgLoss?: number
}

type TradesResponse = {
  trades?: unknown[]
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({
  label, value, sub, color, icon: Icon,
}: {
  label: string; value: string; sub: string; color: string; icon: React.ElementType
}) {
  return (
    <div className="card flex flex-col gap-2 min-w-0 hover:border-gray-700 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-widest">{label}</span>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
          color === 'text-emerald-400' ? 'bg-emerald-400/10' :
          color === 'text-red-400'     ? 'bg-red-400/10' :
          color === 'text-brand-500'   ? 'bg-brand-500/10' :
          'bg-gray-800'
        }`}>
          <Icon className={`w-3.5 h-3.5 ${color}`} />
        </div>
      </div>
      <div>
        <p className={`text-2xl font-bold tracking-tight ${color}`}>{value}</p>
        <p className="text-xs text-gray-600 mt-0.5">{sub}</p>
      </div>
    </div>
  )
}

// ── Bot Status Card ───────────────────────────────────────────────────────────
function BotStatusCard({
  status, activeMarkets, openTradeCount,
}: {
  status: string; activeMarkets: string[]; openTradeCount: number
}) {
  const isRunning  = status === 'running'
  const isStopping = status === 'stopping'
  const isError    = status === 'error'

  const dotColor = isRunning  ? 'bg-brand-500 animate-pulse' :
                   isStopping ? 'bg-amber-400 animate-pulse' :
                   isError    ? 'bg-red-500' : 'bg-gray-600'

  const textColor = isRunning ? 'text-brand-500' : isError ? 'text-red-400' : 'text-gray-400'

  return (
    <div className="card flex flex-col gap-2 min-w-0 hover:border-gray-700 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-widest">Bot Status</span>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-gray-800">
          <Layers className="w-3.5 h-3.5 text-gray-500" />
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
          <p className={`text-2xl font-bold tracking-tight capitalize ${textColor}`}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </p>
        </div>
        <p className="text-xs text-gray-600 mt-0.5">
          {activeMarkets.length > 0 ? activeMarkets.join(' · ') : 'No active markets'}
        </p>
        {openTradeCount > 0 && (
          <p className="text-xs text-amber-400 mt-0.5">
            {openTradeCount} open position{openTradeCount !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    </div>
  )
}

/* OpenPositionsCard removed — dashboard now shows open trades list instead */

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { data: summaryData } = useQuery({
    queryKey: QUERY_KEYS.TRADES_SUMMARY,
    queryFn:  () => apiFetch<TradesSummaryResponse>('/api/trades/summary'),
    refetchInterval: 15_000,
  })

  const { data: tradesData } = useQuery({
    queryKey: ['dashboard-open-positions'] as const,
    // Request only trades with an open status so the dashboard shows active positions
    queryFn:  () => apiFetch<TradesResponse>('/api/trades?limit=10&status=open'),
    staleTime: POLL_INTERVALS.BOT_IDLE,
  })

  const { data: botData, isLoading: botLoading } = useBotStatusQuery({
    select: (data) => ({
      status: data.status,
      activeMarkets: data.activeMarkets,
      openTradeCount: data.openTradeCount,
    }),
  })

  const summary        = summaryData ?? { totalPnl: 0, totalFees: 0, winRate: 0, total: 0, closed: 0 }
  // The API now returns only open trades (status=open). Use as-is.
  const openTrades     = tradesData?.trades ?? []
  const botStatus      = botData?.status ?? 'stopped'
  const activeMarkets  = botData?.activeMarkets ?? []
  const openTradeCount = botData?.openTradeCount ?? 0
  const winPositive    = summary.winRate >= 50

  return (
    <div className="flex flex-col gap-5 max-w-[1400px] mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100 tracking-tight">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long', day: 'numeric', month: 'long',
            })}
          </p>
        </div>
        <a
          href="/dashboard/performance"
          className="flex items-center gap-1.5 text-xs text-brand-500 hover:text-brand-400 transition-colors"
        >
          View performance <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      </div>

      {/* Stats row — clean, unambiguous */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Win Rate"
          value={`${summary.winRate.toFixed(1)}%`}
          sub={`${summary.closed} closed trades`}
          color={winPositive ? 'text-emerald-400' : 'text-red-400'}
          icon={winPositive ? TrendingUp : TrendingDown}
        />

        <StatCard
          label="Total Trades"
          value={summary.total.toLocaleString()}
          sub="All time · all markets"
          color="text-gray-200"
          icon={BarChart3}
        />

        {/* Open Positions card removed per request */}

        {botLoading && !botData ? (
          <div className="card flex flex-col gap-2">
            <div className="h-3 w-20 bg-gray-800 rounded animate-pulse" />
            <div className="h-7 w-24 bg-gray-800 rounded animate-pulse mt-1" />
            <div className="h-3 w-28 bg-gray-800 rounded animate-pulse" />
          </div>
        ) : (
          <BotStatusCard
            status={botStatus}
            activeMarkets={activeMarkets}
            openTradeCount={openTradeCount}
          />
        )}
      </div>

      {/* ... previous code (Header and Stats row) ... */}

      {/* Main Content Area: Bot Controls & Open Positions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        
        {/* Bot Controls — takes up 1 column (left side) on large screens */}
        <div className="lg:col-span-1">
          <SectionErrorBoundary>
            <BotControls />
          </SectionErrorBoundary>
        </div>

        {/* Open Trades — takes up 2 columns (right side) on large screens */}
        <div className="card flex flex-col gap-3 lg:col-span-2 min-h-full">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-200">Open Positions</h2>
              <p className="text-xs text-gray-500 mt-0.5">Currently open positions across all markets</p>
            </div>
            <a
              href="/dashboard/trades"
              className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-400 transition-colors font-medium"
            >
              View all
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </div>
          <SectionErrorBoundary>
            <TradeTable trades={openTrades as Trade[]} compact />
          </SectionErrorBoundary>
        </div>

      </div>

    </div>
  )
}