'use client'
import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Filter, Trash2, CheckSquare, Square, AlertTriangle,
  X, ArrowUpRight, ArrowDownRight, RefreshCw, Download,
  ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Activity,
} from 'lucide-react'
import { format } from 'date-fns'

// ─── Types ────────────────────────────────────────────────────────────────────
interface Trade {
  id:           string
  symbol:       string
  side:         'buy' | 'sell'
  marketType:   string
  entryPrice:   string
  exitPrice:    string | null
  pnl:          string | null
  status:       string
  isPaper:      boolean
  openedAt:     string
  closedAt:     string | null
  exchangeName: string
}

interface Pagination {
  page:    number
  limit:   number
  total:   number
  pages:   number
  hasMore: boolean
}

const MARKETS  = ['all', 'indian', 'crypto', 'commodities', 'global']
const STATUSES = ['all', 'open', 'closed', 'failed', 'cancelled']
const MODES    = ['all', 'paper', 'live'] as const

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const show = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])
  return { toast, show }
}

// ─── Confirm modal ────────────────────────────────────────────────────────────
function ConfirmModal({ title, message, onConfirm, onClose }: {
  title: string; message: string; onConfirm: () => void; onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(3,7,18,0.85)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-sm bg-gray-900 border border-red-900/40 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-red-900/30 bg-red-950/20">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <p className="text-sm font-semibold text-red-300">{title}</p>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-gray-300 leading-relaxed">{message}</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">Cancel</button>
            <button onClick={onConfirm} className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors">Delete</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Export CSV ───────────────────────────────────────────────────────────────
function exportCSV(trades: Trade[]) {
  const headers = ['Symbol','Side','Market','Exchange','Entry','Exit','P&L','Status','Mode','Date']
  const rows = trades.map(t => [
    t.symbol, t.side, t.marketType, t.exchangeName,
    Number(t.entryPrice).toFixed(2),
    t.exitPrice ? Number(t.exitPrice).toFixed(2) : '',
    t.pnl ? Number(t.pnl).toFixed(2) : '',
    t.status, t.isPaper ? 'paper' : 'live',
    format(new Date(t.openedAt), 'dd/MM/yyyy HH:mm'),
  ])
  const csv  = [headers, ...rows].map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `trades-${format(new Date(), 'yyyy-MM-dd')}.csv`
  a.click(); URL.revokeObjectURL(url)
}

// ─── Pagination controls ─────────────────────────────────────────────────────
function Paginator({ pagination, onPage }: { pagination: Pagination; onPage: (p: number) => void }) {
  const { page, pages, total, limit } = pagination
  if (pages <= 1) return null

  const start = (page - 1) * limit + 1
  const end   = Math.min(page * limit, total)

  const pageNums: number[] = []
  const half = 2
  let lo = Math.max(1, page - half)
  let hi = Math.min(pages, page + half)
  if (hi - lo < 4) {
    if (lo === 1) hi = Math.min(pages, lo + 4)
    else          lo = Math.max(1, hi - 4)
  }
  for (let i = lo; i <= hi; i++) pageNums.push(i)

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
      <span className="text-xs text-gray-500">
        {start}–{end} of {total.toLocaleString()} trades
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
          className="p-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {lo > 1 && (
          <>
            <button onClick={() => onPage(1)} className="w-8 h-8 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-500 hover:text-gray-200">1</button>
            {lo > 2 && <span className="text-gray-600 text-xs px-1">…</span>}
          </>
        )}
        {pageNums.map(p => (
          <button key={p} onClick={() => onPage(p)}
            className={`w-8 h-8 rounded-lg text-xs border transition-colors ${
              p === page
                ? 'bg-brand-500/15 border-brand-500/30 text-brand-500'
                : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-200'
            }`}>{p}</button>
        ))}
        {hi < pages && (
          <>
            {hi < pages - 1 && <span className="text-gray-600 text-xs px-1">…</span>}
            <button onClick={() => onPage(pages)} className="w-8 h-8 rounded-lg text-xs bg-gray-800 border border-gray-700 text-gray-500 hover:text-gray-200">{pages}</button>
          </>
        )}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page === pages}
          className="p-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ─── Stat Card — matches Bot History style, mobile-friendly ──────────────────
function StatCard({
  label, value, sub, color, icon: Icon,
}: {
  label: string
  value: string | number
  sub: string
  color: string
  icon: React.ElementType
}) {
  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-4 flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-none">{label}</span>
        <Icon className="w-3.5 h-3.5 text-gray-700 flex-shrink-0" />
      </div>
      <span className={`text-2xl font-bold leading-tight truncate ${color}`}>{value}</span>
      <span className="text-xs text-gray-600 leading-none">{sub}</span>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TradesPage() {
  const qc = useQueryClient()
  const { toast, show: showToast } = useToast()

  // ── Filter state ───────────────────────────────────────────────────────────
  const [market,   setMarket]   = useState('all')
  const [status,   setStatus]   = useState('all')
  const [mode,     setMode]     = useState<typeof MODES[number]>('all')
  const [page,     setPage]     = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm,  setConfirm]  = useState<null | { type: string; label: string; message: string }>(null)

  function applyFilter(fn: () => void) {
    fn()
    setPage(1)
    setSelected(new Set())
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  const params = new URLSearchParams({ page: String(page), limit: '50' })
  if (market !== 'all') params.set('market', market)
  if (status !== 'all') params.set('status', status)
  if (mode   !== 'all') params.set('mode',   mode)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['trades', market, status, mode, page],
    queryFn:  () => fetch(`/api/trades?${params}`).then(r => r.json()),
    placeholderData: (prev: any) => prev,
  })

  const trades: Trade[]        = data?.trades ?? []
  const pagination: Pagination = data?.pagination ?? { page: 1, limit: 50, total: 0, pages: 1, hasMore: false }
  const summary                = data?.summary ?? { total: 0, closed: 0, totalPnl: 0, winRate: 0 }

  // ── Delete mutations ───────────────────────────────────────────────────────
  const deleteSingle = useMutation({
    mutationFn: (id: string) => fetch(`/api/trades/${id}`, { method: 'DELETE' }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['trades'] }); showToast('Trade deleted') },
    onError:   () => showToast('Failed to delete', 'error'),
  })

  const bulkDelete = useMutation({
    mutationFn: (payload: { type?: string; ids?: string[] }) =>
      fetch('/api/trades/bulk-delete', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['trades'] })
      showToast(`${d.deleted} trade${d.deleted !== 1 ? 's' : ''} deleted`)
      setSelected(new Set()); setConfirm(null)
    },
    onError: () => { showToast('Bulk delete failed', 'error'); setConfirm(null) },
  })

  // ── Selection ──────────────────────────────────────────────────────────────
  const allSelected  = trades.length > 0 && selected.size === trades.length
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(trades.map(t => t.id)))
  }
  function toggleOne(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function handleConfirmedDelete() {
    if (!confirm) return
    if (confirm.type === 'selected') {
      bulkDelete.mutate({ type: 'selected', ids: Array.from(selected) })
    } else {
      bulkDelete.mutate({ type: confirm.type })
    }
  }

  const isBusy = bulkDelete.isPending || deleteSingle.isPending

  // ── Filter pill ────────────────────────────────────────────────────────────
  const Pill = ({ value, active, onClick, label }: { value: string; active: boolean; onClick: () => void; label?: string }) => (
    <button onClick={onClick}
      className={`px-3 py-1 text-xs rounded-lg border capitalize transition-colors ${
        active ? 'bg-brand-500/15 border-brand-500/30 text-brand-500' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
      }`}>{label ?? value}</button>
  )

  return (
    <div className="space-y-4 max-w-6xl mx-auto">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-2xl text-sm font-medium border ${
          toast.type === 'success' ? 'bg-brand-500/15 border-brand-500/30 text-brand-500' : 'bg-red-900/20 border-red-800/30 text-red-400'
        }`}>
          {toast.type === 'success' ? '✓' : '✗'} {toast.msg}
        </div>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.label} message={confirm.message}
          onConfirm={handleConfirmedDelete} onClose={() => setConfirm(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Trade History</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {summary.total.toLocaleString()} total trades
            {mode !== 'all' && ` (${mode} only)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => exportCSV(trades)} disabled={trades.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-400 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors disabled:opacity-40">
            <Download className="w-3.5 h-3.5" /> Export page
          </button>
          <button onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-400 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Filters</span>
        </div>
        <div className="flex flex-wrap gap-4">
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Market</p>
            <div className="flex gap-1.5 flex-wrap">
              {MARKETS.map(m => <Pill key={m} value={m} active={market === m} onClick={() => applyFilter(() => setMarket(m))} />)}
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Status</p>
            <div className="flex gap-1.5 flex-wrap">
              {STATUSES.map(s => <Pill key={s} value={s} active={status === s} onClick={() => applyFilter(() => setStatus(s))} />)}
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Mode</p>
            <div className="flex gap-1.5">
              {MODES.map(m => <Pill key={m} value={m} active={mode === m} onClick={() => applyFilter(() => setMode(m))} />)}
            </div>
          </div>
        </div>
      </div>

      {/* ✅ IMPROVED: Summary stat cards — mobile-first 2-col, desktop 3-col */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard
          label="Total P&L"
          value={`₹${summary.totalPnl.toFixed(2)}`}
          sub="all closed trades"
          color={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
          icon={summary.totalPnl >= 0 ? TrendingUp : TrendingDown}
        />
        <StatCard
          label="Win Rate"
          value={`${summary.winRate}%`}
          sub={`${summary.closed} closed trades`}
          color={summary.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}
          icon={Activity}
        />
        {/* Full-width on mobile, normal on desktop */}
        <div className="col-span-2 lg:col-span-1">
          <StatCard
            label="Total Trades"
            value={summary.total.toLocaleString()}
            sub="matching current filters"
            color="text-gray-200"
            icon={Filter}
          />
        </div>
      </div>

      {/* Bulk action bar */}
      <div className="flex items-center justify-between flex-wrap gap-2 min-h-[36px]">
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-xs text-gray-400 bg-gray-800 border border-gray-700 px-2.5 py-1.5 rounded-lg">
                {selected.size} selected
              </span>
              <button
                onClick={() => setConfirm({ type: 'selected', label: 'Delete Selected', message: `Delete ${selected.size} trade${selected.size !== 1 ? 's' : ''}? This cannot be undone.` })}
                disabled={isBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-900/20 hover:bg-red-900/30 border border-red-900/30 rounded-lg transition-colors disabled:opacity-40">
                <Trash2 className="w-3 h-3" /> Delete Selected
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setConfirm({ type: 'paper', label: 'Delete Paper Trades', message: 'Delete ALL paper trades? This cannot be undone.' })}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-900/15 hover:bg-amber-900/25 border border-amber-900/30 rounded-lg transition-colors disabled:opacity-40">
            <Trash2 className="w-3 h-3" /> Delete Paper
          </button>
          <button onClick={() => setConfirm({ type: 'live', label: 'Delete Live Trades', message: 'Delete ALL live trades? This cannot be undone.' })}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-900/15 hover:bg-red-900/25 border border-red-900/30 rounded-lg transition-colors disabled:opacity-40">
            <Trash2 className="w-3 h-3" /> Delete Live
          </button>
          <button onClick={() => setConfirm({ type: 'all', label: 'Delete All Trades', message: 'Delete EVERY trade? This cannot be undone.' })}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-900/20 hover:bg-red-900/30 border border-red-900/40 rounded-lg transition-colors disabled:opacity-40">
            <Trash2 className="w-3 h-3" /> Delete All
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="w-10 py-3 pl-4">
                  <button onClick={toggleAll} className="text-gray-500 hover:text-brand-500 transition-colors">
                    {allSelected ? <CheckSquare className="w-4 h-4 text-brand-500" /> : <Square className="w-4 h-4" />}
                  </button>
                </th>
                {['Symbol','Side','Market','Entry','Exit','P&L','Status','Mode','Date',''].map(h => (
                  <th key={h} className="text-left text-xs text-gray-600 font-medium pb-3 pt-3 px-2 last:pr-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td colSpan={11} className="px-4 py-3">
                      <div className="h-4 bg-gray-800 rounded animate-pulse w-full" />
                    </td>
                  </tr>
                ))
              ) : trades.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-sm text-gray-600">
                    No trades match your filters
                  </td>
                </tr>
              ) : trades.map(trade => {
                const pnl      = Number(trade.pnl ?? 0)
                const isProfit = pnl > 0
                const isChecked = selected.has(trade.id)
                return (
                  <tr key={trade.id} className={`hover:bg-gray-800/30 transition-colors group ${isChecked ? 'bg-brand-500/5' : ''}`}>
                    <td className="py-2.5 pl-4 w-10">
                      <button onClick={() => toggleOne(trade.id)} className="text-gray-600 hover:text-brand-500 transition-colors">
                        {isChecked ? <CheckSquare className="w-4 h-4 text-brand-500" /> : <Square className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="py-2.5 px-2 font-mono text-xs text-gray-300 font-medium">
                      {trade.symbol}
                      {trade.isPaper && <span className="ml-1.5 text-xs text-amber-600">[P]</span>}
                    </td>
                    <td className="py-2.5 px-2">
                      <div className={`flex items-center gap-1 text-xs font-medium ${trade.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {trade.side === 'buy' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {trade.side.toUpperCase()}
                      </div>
                    </td>
                    <td className="py-2.5 px-2">
                      <span className="badge-gray capitalize">{trade.marketType}</span>
                    </td>
                    <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
                      ₹{Number(trade.entryPrice).toLocaleString('en-IN')}
                    </td>
                    <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
                      {trade.exitPrice ? `₹${Number(trade.exitPrice).toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td className="py-2.5 px-2">
                      {trade.pnl != null ? (
                        <span className={`text-xs font-semibold font-mono ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
                          {isProfit ? '+' : ''}₹{Math.abs(pnl).toFixed(2)}
                        </span>
                      ) : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="py-2.5 px-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        trade.status === 'closed' ? 'badge-gray' :
                        trade.status === 'open'   ? 'bg-brand-500/10 border-brand-500/20 text-brand-500' :
                        trade.status === 'failed' ? 'bg-red-900/20 border-red-800/30 text-red-400' : 'badge-gray'
                      }`}>{trade.status}</span>
                    </td>
                    <td className="py-2.5 px-2">
                      {trade.isPaper
                        ? <span className="text-xs text-amber-500">Paper</span>
                        : <span className="text-xs text-red-400">Live</span>}
                    </td>
                    <td className="py-2.5 px-2 text-xs text-gray-600">
                      {format(new Date(trade.openedAt), 'dd MMM HH:mm')}
                    </td>
                    <td className="py-2.5 px-2 pr-4">
                      <button onClick={() => deleteSingle.mutate(trade.id)} disabled={isBusy}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-40">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <Paginator pagination={pagination} onPage={setPage} />
      </div>
    </div>
  )
}