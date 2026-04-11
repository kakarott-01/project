 'use client'
import { useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BOT_STATUS_QUERY_KEY, isValidBotSnapshot } from '@/lib/bot-status-client'
import {
  Clock, Trash2, ChevronLeft, ChevronRight,
  AlertTriangle, X, Activity, Filter, Download,
  TrendingUp, TrendingDown, RefreshCw, Bot,
} from 'lucide-react'
import { format} from 'date-fns'
import dynamic from 'next/dynamic'
import { formatElapsedDuration, getSessionDurationMs } from '@/lib/time'

// ─── Types ────────────────────────────────────────────────────────────────────
interface BotSession {
  id:           string
  exchange:     string
  market:       string
  mode:         'paper' | 'live'
  status:       'running' | 'stopped' | 'error'
  started_at:   string
  stopped_at:   string | null
  totalTrades:  number
  openTrades:   number
  closedTrades: number
  totalPnl:     string
}

interface Pagination {
  page:  number
  limit: number
  total: number
  pages: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getDuration(startedAt: string, stoppedAt: string | null, now: number): string {
  return formatElapsedDuration(getSessionDurationMs(startedAt, stoppedAt, now))
}

const MARKET_LABEL: Record<string, string> = {
  indian: '🇮🇳 Indian', crypto: '₿ Crypto',
  commodities: '🛢 Commodities', global: '🌐 Global',
}

const DeleteSessionModal = dynamic(() => import('@/components/modals/delete-session-modal'), { ssr: false })

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: 'running' | 'stopped' | 'error' }) {
  const cfg = {
    running: 'bg-brand-500/15 border-brand-500/30 text-brand-500',
    stopped: 'bg-gray-700/50 border-gray-600/30 text-gray-400',
    error:   'bg-red-900/20 border-red-800/30 text-red-400',
  }[status]
  const dot = {
    running: 'bg-brand-500 animate-pulse',
    stopped: 'bg-gray-500',
    error:   'bg-red-500',
  }[status]
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${cfg}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

// ─── Mode badge ───────────────────────────────────────────────────────────────
function ModeBadge({ mode }: { mode: 'paper' | 'live' }) {
  return mode === 'live'
    ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-red-900/30 border border-red-800/40 text-red-400">🔴 LIVE</span>
    : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-900/20 border border-amber-800/30 text-amber-400">🟡 PAPER</span>
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <tr className="border-b border-gray-800/50">
      {Array.from({ length: 8 }).map((_, i) => (
        <td key={i} className="px-3 py-3.5">
          <div className="h-4 bg-gray-800 rounded animate-pulse" style={{ width: `${60 + i * 10}%` }} />
        </td>
      ))}
    </tr>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <tr>
      <td colSpan={9} className="px-4 py-16 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-gray-800/80 flex items-center justify-center">
            <Bot className="w-6 h-6 text-gray-600" />
          </div>
          <p className="text-sm font-medium text-gray-400">No bot sessions yet</p>
          <p className="text-xs text-gray-600">Start the bot to begin recording session history</p>
        </div>
      </td>
    </tr>
  )
}

// ─── Export to CSV ────────────────────────────────────────────────────────────
function exportCSV(sessions: BotSession[], now: number) {
  const headers = ['Date', 'Start Time', 'End Time', 'Duration', 'Exchange', 'Market', 'Mode', 'Status', 'Total Trades', 'Open', 'Closed', 'P&L']
  const rows = sessions.map(s => [
    format(new Date(s.started_at), 'dd/MM/yyyy'),
    format(new Date(s.started_at), 'HH:mm:ss'),
    s.stopped_at ? format(new Date(s.stopped_at), 'HH:mm:ss') : '—',
    getDuration(s.started_at, s.stopped_at, now),
    s.exchange,
    s.market,
    s.mode,
    s.status,
    s.totalTrades,
    s.openTrades,
    s.closedTrades,
    Number(s.totalPnl).toFixed(2),
  ])
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `bot-sessions-${format(new Date(), 'yyyy-MM-dd')}.csv`
  a.click(); URL.revokeObjectURL(url)
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const show = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])
  return { toast, show }
}

// ─── Stat Card (fixed layout) ─────────────────────────────────────────────────
function StatCard({
  label, value, sub, color,
}: {
  label: string
  value: string | number
  sub: string
  color: string
}) {
  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4 flex flex-col gap-1 min-w-0">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-none">{label}</span>
      <span className={`text-2xl font-bold leading-tight truncate ${color}`}>{value}</span>
      <span className="text-xs text-gray-600 leading-none">{sub}</span>
    </div>
  )
}

function BotSessionRow({
  session,
  now,
  onDelete,
}: {
  session: BotSession
  now: number
  onDelete: (session: BotSession) => void
}) {
  const pnl = Number(session.totalPnl ?? 0)
  const duration = getDuration(session.started_at, session.stopped_at, now)

  return (
    <tr className="hover:bg-gray-800/30 transition-colors group">
      <td className="px-3 py-3.5 pl-5 text-xs text-gray-300 whitespace-nowrap">
        {format(new Date(session.started_at), 'dd MMM yyyy')}
      </td>
      <td className="px-3 py-3.5 text-xs font-mono text-gray-400 whitespace-nowrap">
        {format(new Date(session.started_at), 'HH:mm:ss')}
      </td>
      <td className="px-3 py-3.5 text-xs font-mono text-gray-400 whitespace-nowrap">
        {session.stopped_at ? format(new Date(session.stopped_at), 'HH:mm:ss') : (
          <span className="text-brand-500 animate-pulse">Live…</span>
        )}
      </td>
      <td className="px-3 py-3.5 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
          <Clock className="w-3 h-3 text-gray-600 flex-shrink-0" />
          {duration}
        </span>
      </td>
      <td className="px-3 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-gray-200 capitalize">{session.exchange}</span>
          <span className="text-xs text-gray-500">{MARKET_LABEL[session.market] ?? session.market}</span>
        </div>
      </td>
      <td className="px-3 py-3.5 whitespace-nowrap"><ModeBadge mode={session.mode} /></td>
      <td className="px-3 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-300 font-medium">{session.totalTrades} total</span>
          <span className="text-xs text-gray-600 whitespace-nowrap">
            {session.openTrades} open · {session.closedTrades} closed
          </span>
        </div>
      </td>
      <td className="px-3 py-3.5 whitespace-nowrap">
        <span className={`text-xs font-semibold font-mono ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {pnl >= 0 ? '+' : ''}₹{Math.abs(pnl).toFixed(2)}
        </span>
      </td>
      <td className="px-3 py-3.5 whitespace-nowrap"><StatusBadge status={session.status} /></td>
      <td className="px-3 py-3.5 pr-5">
        <button
          onClick={() => onDelete(session)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-900/20"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function BotHistoryPage() {
  const qc = useQueryClient()
  const { toast, show: showToast } = useToast()
  const now = Date.now()

  const [page,        setPage]        = useState(1)
  const [modeFilter,  setModeFilter]  = useState<'all' | 'paper' | 'live'>('all')
  const [exchFilter,  setExchFilter]  = useState('')
  const [fromDate,    setFromDate]    = useState('')
  const [toDate,      setToDate]      = useState('')
  const [toDelete,    setToDelete]    = useState<BotSession | null>(null)

  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (modeFilter !== 'all') params.set('mode', modeFilter)
  if (exchFilter)           params.set('exchange', exchFilter)
  if (fromDate)             params.set('from', fromDate)
  if (toDate)               params.set('to', toDate)

  const { data, isLoading } = useQuery<{ sessions: BotSession[]; pagination: Pagination }>({
    queryKey: ['bot-history', page, modeFilter, exchFilter, fromDate, toDate],
    queryFn:  () => apiFetch(`/api/bot-history?${params}`),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/bot-history/${id}`, { method: 'DELETE' }),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      await qc.cancelQueries({ queryKey: ['bot-history'] })
      const previousBot = qc.getQueryData(BOT_STATUS_QUERY_KEY)
      const previous = qc.getQueryData(['bot-history', page, modeFilter, exchFilter, fromDate, toDate])
      qc.setQueryData(['bot-history', page, modeFilter, exchFilter, fromDate, toDate], (old: any) => {
        if (!old || !old.sessions) return old
        return { ...old, sessions: old.sessions.filter((s: any) => s.id !== id) }
      })
      return { previous, previousBot }
    },
    onError: (_err, _vars, context: any) => {
      if (context?.previous) qc.setQueryData(['bot-history', page, modeFilter, exchFilter, fromDate, toDate], context.previous)
      if (context?.previousBot && isValidBotSnapshot(context.previousBot)) qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previousBot)
      showToast('Failed to delete session', 'error')
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['bot-history'] })
      qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      setToDelete(null)
    },
  })

  const sessions    = data?.sessions ?? []
  const pagination  = data?.pagination

  const totalPnl    = sessions.reduce((s, r) => s + Number(r.totalPnl ?? 0), 0)
  const totalTrades = sessions.reduce((s, r) => s + r.totalTrades, 0)
  const runningCount = sessions.filter(s => s.status === 'running').length

  function resetFilters() {
    setModeFilter('all'); setExchFilter(''); setFromDate(''); setToDate(''); setPage(1)
  }

  return (
    <div className="space-y-5 max-w-7xl mx-auto">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-2xl text-sm font-medium border transition-all ${
          toast.type === 'success'
            ? 'bg-brand-500/15 border-brand-500/30 text-brand-500'
            : 'bg-red-900/20 border-red-800/30 text-red-400'
        }`}>
          {toast.type === 'success' ? '✓' : '✗'} {toast.msg}
        </div>
      )}

      {/* Delete Modal */}
      {toDelete && (
        <DeleteSessionModal
          session={toDelete}
          onConfirm={() => deleteMut.mutate(toDelete.id)}
          onClose={() => setToDelete(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Bot History</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {pagination ? `${pagination.total} session${pagination.total !== 1 ? 's' : ''} recorded` : 'All trading sessions'}
          </p>
        </div>
        <button
          onClick={() => exportCSV(sessions, now)}
          disabled={sessions.length === 0}
          className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-400 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>
      </div>

      {/* Summary stat cards — fixed layout, no overlap */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Sessions"
          value={pagination?.total ?? '—'}
          sub="all time"
          color="text-gray-100"
        />
        <StatCard
          label="Running Now"
          value={runningCount}
          sub="active bots"
          color={runningCount > 0 ? 'text-brand-500' : 'text-gray-500'}
        />
        <StatCard
          label="Total Trades"
          value={totalTrades}
          sub="this page"
          color="text-gray-100"
        />
        <StatCard
          label="Page P&L"
          value={`₹${totalPnl.toFixed(2)}`}
          sub="closed trades"
          color={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Filters</span>
          <button onClick={resetFilters} className="ml-auto text-xs text-gray-600 hover:text-brand-500 flex items-center gap-1 transition-colors">
            <RefreshCw className="w-3 h-3" /> Reset
          </button>
        </div>
        <div className="flex flex-wrap gap-4 items-end">
          {/* Mode */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Mode</p>
            <div className="flex gap-1.5">
              {(['all', 'paper', 'live'] as const).map(m => (
                <button key={m} onClick={() => { setModeFilter(m); setPage(1) }}
                  className={`px-3 py-1 text-xs rounded-lg border capitalize transition-colors ${
                    modeFilter === m
                      ? 'bg-brand-500/15 border-brand-500/30 text-brand-500'
                      : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
                  }`}>{m}</button>
              ))}
            </div>
          </div>
          {/* Exchange */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Exchange</p>
            <input
              type="text"
              placeholder="e.g. coindcx"
              value={exchFilter}
              onChange={e => { setExchFilter(e.target.value); setPage(1) }}
              className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 placeholder-gray-600 outline-none focus:border-brand-500 w-32"
            />
          </div>
          {/* Date range */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">From</p>
            <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1) }}
              className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 outline-none focus:border-brand-500" />
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1.5">To</p>
            <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1) }}
              className="px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 outline-none focus:border-brand-500" />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {['Date', 'Start', 'End', 'Duration', 'Exchange · Market', 'Mode', 'Trades', 'P&L', 'Status', ''].map(h => (
                  <th key={h} className="text-left text-xs text-gray-600 font-medium pb-3 pt-4 px-3 first:pl-5 last:pr-5 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {isLoading
                ? Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                : sessions.length === 0
                ? <EmptyState />
                : sessions.map((session) => (
                    <BotSessionRow
                      key={session.id}
                      session={session}
                      now={now}
                      onDelete={setToDelete}
                    />
                  ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800">
            <span className="text-xs text-gray-600">
              Page {pagination.page} of {pagination.pages} · {pagination.total} sessions
            </span>
            <div className="flex gap-1.5">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {Array.from({ length: Math.min(pagination.pages, 5) }, (_, i) => {
                const p = i + 1
                return (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                      page === p
                        ? 'bg-brand-500/15 border border-brand-500/30 text-brand-500'
                        : 'bg-gray-800 border border-gray-700 text-gray-500 hover:text-gray-200'
                    }`}>{p}</button>
                )
              })}
              <button
                onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                disabled={page === pagination.pages}
                className="p-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
