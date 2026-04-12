'use client'
import { useQuery } from '@tanstack/react-query'
import { QUERY_KEYS } from '@/lib/query-keys'
import {
  TrendingUp, TrendingDown, Activity, DollarSign,
  BarChart3, Layers, ArrowUpRight,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { POLL_INTERVALS } from '@/lib/polling-config'
const PnlChart = dynamic(() => import('@/components/charts/pnl-chart').then(m => m.PnlChart), { ssr: false, loading: () => <div className="h-40 flex items-center justify-center text-sm text-gray-600">Loading chart…</div> })
const TradeTable = dynamic(() => import('@/components/dashboard/trade-table').then(m => m.TradeTable))
import type { Trade } from '@/components/dashboard/trade-table'
const BotControls = dynamic(() => import('@/components/dashboard/bot-controls').then(m => m.BotControls))
import { useBotStatusQuery } from '@/lib/use-bot-status-query'
import { formatCurrency } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'

type TradesSummaryResponse = {
  total: number
  closed: number
  totalPnl: number
  totalFees: number
  winRate: number
  avgWin?: number
  avgLoss?: number
}

type PerformanceResponse = {
  cumPnl?: Array<{ date: string; pnl: number }>
}

type TradesResponse = {
  trades?: unknown[]
}

type StrategyConfigListResponse = {
  markets?: Array<{ marketType: string; executionMode?: string }>
}

// ── Compact stat card for the top row ─────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  color,
  icon: Icon,
  trend,
}: {
  label: string
  value: string
  sub: string
  color: string
  icon: React.ElementType
  trend?: 'up' | 'down' | null
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

// ── Compact bot status summary for the top row ────────────────────────────────
function BotStatusCard({
  status,
  activeMarkets,
  openTradeCount,
}: {
  status: string
  activeMarkets: string[]
  openTradeCount: number
}) {
  const isRunning  = status === 'running'
  const isStopping = status === 'stopping'
  const isError    = status === 'error'

  const dotColor = isRunning  ? 'bg-brand-500 animate-pulse' :
                   isStopping ? 'bg-amber-400 animate-pulse' :
                   isError    ? 'bg-red-500' : 'bg-gray-600'

  const badgeStyle = isRunning  ? 'bg-brand-500/10 text-brand-500 border-brand-500/20' :
                     isStopping ? 'bg-amber-400/10 text-amber-400 border-amber-400/20' :
                     isError    ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                                  'bg-gray-800 text-gray-500 border-gray-700'

  return (
    <div className="card flex flex-col gap-2 min-w-0 hover:border-gray-700 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-widest">Bot Status</span>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center bg-gray-800`}>
          <Layers className="w-3.5 h-3.5 text-gray-500" />
        </span>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
          <p className={`text-2xl font-bold tracking-tight capitalize ${
            isRunning ? 'text-brand-500' : isError ? 'text-red-400' : 'text-gray-400'
          }`}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </p>
        </div>
        <p className="text-xs text-gray-600 mt-0.5">
          {activeMarkets.length > 0
            ? activeMarkets.join(' · ')
            : 'No active markets'}
        </p>
      </div>
    </div>
  )
}

// ── Main dashboard page ───────────────────────────────────────────────────────
export default function DashboardPage() {
  const { data: summaryData } = useQuery({
    queryKey: QUERY_KEYS.TRADES_SUMMARY,
    queryFn:  () => apiFetch<TradesSummaryResponse>('/api/trades/summary'),
    refetchInterval: 15_000,
  })

  const { data: perfChart } = useQuery<PerformanceResponse, unknown, Array<{ date: string; pnl: number }>>({
    queryKey: QUERY_KEYS.PERFORMANCE(),
    queryFn:  () => apiFetch<PerformanceResponse>('/api/performance'),
    staleTime: 60_000,
    refetchInterval: 60_000,
    select: (d) => d.cumPnl ?? [],
  })

  const { data: tradesData } = useQuery({
    queryKey: QUERY_KEYS.TRADES(),
    queryFn:  () => apiFetch<TradesResponse>('/api/trades?limit=50'),
  })

  const { data: botData, isLoading: botLoading } = useBotStatusQuery()

  const { data: strategyConfigData } = useQuery({
    queryKey: QUERY_KEYS.STRATEGY_CONFIGS,
    queryFn:  () => apiFetch<StrategyConfigListResponse>('/api/strategy-config'),
    select: (d) => {
      const markets = d?.markets ?? []
      const aggressiveMarkets = (markets ?? []).filter((m: any) => m.executionMode === 'AGGRESSIVE').map((m: any) => m.marketType)
      return { ...d, aggressiveMarkets }
    },
    staleTime: POLL_INTERVALS.STRATEGY,
  })

  const summary        = summaryData ?? { totalPnl: 0, totalFees: 0, winRate: 0, total: 0, closed: 0 }
  const recentTrades   = tradesData?.trades?.slice(0, 10) ?? []
  const cumPnlData     = perfChart ?? []

  const botStatus        = botData?.status ?? 'stopped'
  const botActiveMarkets = botData?.activeMarkets ?? []
  const openTradeCount   = botData?.openTradeCount ?? 0

  const aggressiveMarkets = strategyConfigData?.aggressiveMarkets ?? []

  const pnlPositive = summary.totalPnl >= 0
  const winPositive = summary.winRate >= 50

  return (
    <div className="flex flex-col gap-5 max-w-[1400px] mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100 tracking-tight">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString('en-IN', {
              weekday: 'long', day: 'numeric', month: 'long'
            })}
          </p>
        </div>
        {aggressiveMarkets.length > 0 && (
          <div className="flex items-center gap-2 bg-red-950/30 border border-red-900/35 rounded-xl px-3 py-1.5 text-xs text-red-300">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse flex-shrink-0" />
            AGGRESSIVE: {aggressiveMarkets.join(', ')}
          </div>
        )}
      </div>

      {/* ── Top row: 4 stat cards ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Net P&L"
          value={formatCurrency(summary.totalPnl)}
          sub={typeof summary.totalFees === 'number'
            ? `Fees paid ${formatCurrency(summary.totalFees)}`
            : 'All closed trades'}
          color={pnlPositive ? 'text-emerald-400' : 'text-red-400'}
          icon={pnlPositive ? TrendingUp : TrendingDown}
          trend={pnlPositive ? 'up' : 'down'}
        />
        <StatCard
          label="Win Rate"
          value={`${summary.winRate.toFixed(1)}%`}
          sub={`${summary.closed} closed trades`}
          color={winPositive ? 'text-emerald-400' : 'text-red-400'}
          icon={Activity}
        />
        <StatCard
          label="Total Trades"
          value={summary.total.toLocaleString()}
          sub="Since inception"
          color="text-gray-200"
          icon={BarChart3}
        />
        {botLoading && !botData ? (
          <div className="card flex flex-col gap-2">
            <div className="h-3 w-20 bg-gray-800 rounded animate-pulse" />
            <div className="h-7 w-24 bg-gray-800 rounded animate-pulse mt-1" />
            <div className="h-3 w-28 bg-gray-800 rounded animate-pulse" />
          </div>
        ) : (
          <BotStatusCard
            status={botStatus}
            activeMarkets={botActiveMarkets}
            openTradeCount={openTradeCount}
          />
        )}
      </div>

      {/* ── Main section: chart (2/3) + bot controls (1/3) ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* P&L Chart — 2/3 width */}
        <div className="xl:col-span-2 card flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-200">Cumulative P&L</h2>
              <p className="text-xs text-gray-500 mt-0.5">All time performance</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                pnlPositive
                  ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20'
                  : 'bg-red-400/10 text-red-400 border-red-400/20'
              }`}>
                {pnlPositive ? '▲' : '▼'} {formatCurrency(Math.abs(summary.totalPnl))}
              </span>
            </div>
          </div>

          <div className="h-[220px] sm:h-[260px]">
            <PnlChart cumPnlData={cumPnlData} />
          </div>
        </div>

        {/* Bot Controls — 1/3 width */}
        <div className="xl:col-span-1 flex flex-col">
          <BotControls />
        </div>
      </div>

      {/* ── Recent trades table ─────────────────────────────────────────────── */}
      <div className="card flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">Recent Trades</h2>
            <p className="text-xs text-gray-500 mt-0.5">Last 10 executions</p>
          </div>
          <a
            href="/dashboard/trades"
            className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-400 transition-colors font-medium"
          >
            View all
            <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
        </div>
        <TradeTable trades={recentTrades as Trade[]} compact />
      </div>

    </div>
  )
}
