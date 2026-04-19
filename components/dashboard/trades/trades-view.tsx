"use client";

import {
  Activity,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  RefreshCw,
  Square,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { formatPnl } from "@/lib/utils";
import { getMarketCurrency, formatPnlAmount, formatAmount } from '@/lib/currency'
import TradeRow from "@/components/dashboard/trade-row";

export interface Trade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  marketType: string;
  quantity: string;
  entryPrice: string;
  exitPrice: string | null;
  pnl: string | null;
  netPnl: string | null;
  feeAmount: string | null;
  status: string;
  isPaper: boolean;
  openedAt: string;
  closedAt: string | null;
  exchangeName: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasMore: boolean;
}

type Summary = {
  total: number;
  closed: number;
  totalPnl: number;
  winRate: number;
  totalFees?: number;
};

type ConfirmState = { type: string; label: string; message: string };

type TradesViewProps = {
  market: string;
  status: string;
  mode: string;
  markets: string[];
  statuses: string[];
  modes: readonly string[];
  summary: Summary;
  trades: Trade[];
  selected: Set<string>;
  allSelected: boolean;
  isBusy: boolean;
  isLoading: boolean;
  pagination: Pagination;
  onApplyFilter: (fn: () => void) => void;
  setMarket: (value: string) => void;
  setStatus: (value: string) => void;
  setMode: (value: any) => void;
  setConfirm: (value: ConfirmState) => void;
  setPage: (value: number) => void;
  setSelected: (value: Set<string>) => void;
  onExport: () => void;
  onRefresh: () => void;
  onToggleAll: () => void;
  onToggleOne: (id: string) => void;
  onDeleteTrade: (id: string) => void;
  onPrefetchPage: (page: number) => void;
};

function Paginator({
  pagination,
  onPage,
  onPrefetch,
}: {
  pagination: Pagination;
  onPage: (page: number) => void;
  onPrefetch: (page: number) => void;
}) {
  const { page, pages, total, limit } = pagination;
  if (pages <= 1) return null;

  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  const pageNums: number[] = [];
  const half = 2;
  let lo = Math.max(1, page - half);
  let hi = Math.min(pages, page + half);
  if (hi - lo < 4) lo === 1 ? (hi = Math.min(pages, lo + 4)) : (lo = Math.max(1, hi - 4));
  for (let pageNum = lo; pageNum <= hi; pageNum++) pageNums.push(pageNum);

  return (
    <div className="flex items-center justify-between border-t border-gray-800 px-4 py-3">
      <span className="text-xs text-gray-500">{start}-{end} of {total.toLocaleString()} trades</span>
      <div className="flex items-center gap-1">
        <button onMouseEnter={() => page > 1 && onPrefetch(page - 1)} onClick={() => onPage(page - 1)} disabled={page === 1} className="rounded-lg border border-gray-700 bg-gray-800 p-1.5 text-gray-400 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40">
          <ChevronLeft className="h-4 w-4" />
        </button>
        {lo > 1 && (
          <>
            <button onMouseEnter={() => onPrefetch(1)} onClick={() => onPage(1)} className="h-8 w-8 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-500 hover:text-gray-200">1</button>
            {lo > 2 && <span className="px-1 text-xs text-gray-600">...</span>}
          </>
        )}
        {pageNums.map((pageNum) => (
          <button key={pageNum} onMouseEnter={() => pageNum !== page && onPrefetch(pageNum)} onClick={() => onPage(pageNum)} className={`h-8 w-8 rounded-lg border text-xs transition-colors ${pageNum === page ? "border-brand-500/30 bg-brand-500/15 text-brand-500" : "border-gray-700 bg-gray-800 text-gray-500 hover:text-gray-200"}`}>
            {pageNum}
          </button>
        ))}
        {hi < pages && (
          <>
            {hi < pages - 1 && <span className="px-1 text-xs text-gray-600">...</span>}
            <button onMouseEnter={() => onPrefetch(pages)} onClick={() => onPage(pages)} className="h-8 w-8 rounded-lg border border-gray-700 bg-gray-800 text-xs text-gray-500 hover:text-gray-200">{pages}</button>
          </>
        )}
        <button onMouseEnter={() => page < pages && onPrefetch(page + 1)} onClick={() => onPage(page + 1)} disabled={page === pages} className="rounded-lg border border-gray-700 bg-gray-800 p-1.5 text-gray-400 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color, icon: Icon }: { label: string; value: string | number; sub: string; color: string; icon: React.ElementType }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-gray-800 bg-gray-900/80 p-4">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-xs font-medium uppercase leading-none tracking-wide text-gray-500">{label}</span>
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-gray-700" />
      </div>
      <span className={`truncate text-2xl font-bold leading-tight ${color}`}>{value}</span>
      <span className="text-xs leading-none text-gray-600">{sub}</span>
    </div>
  );
}

function Pill({ value, active, onClick, label }: { value: string; active: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className={`rounded-lg border px-3 py-1 text-xs capitalize transition-colors ${active ? "border-brand-500/30 bg-brand-500/15 text-brand-500" : "border-gray-700 bg-gray-800 text-gray-500 hover:text-gray-300"}`}>
      {label ?? value}
    </button>
  );
}

export function TradesView({
  market,
  status,
  mode,
  markets,
  statuses,
  modes,
  summary,
  trades,
  selected,
  allSelected,
  isBusy,
  isLoading,
  pagination,
  onApplyFilter,
  setMarket,
  setStatus,
  setMode,
  setConfirm,
  setPage,
  setSelected,
  onExport,
  onRefresh,
  onToggleAll,
  onToggleOne,
  onDeleteTrade,
  onPrefetchPage,
}: TradesViewProps) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Trade History</h1>
          <p className="mt-0.5 text-sm text-gray-500">{summary.total.toLocaleString()} total trades{mode !== "all" && ` (${mode} only)`}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onExport} disabled={trades.length === 0} className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-700 disabled:opacity-40">
            <Download className="h-3.5 w-3.5" /> Export page
          </button>
          <button onClick={onRefresh} className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-700">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-gray-500" />
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Filters</span>
        </div>
        <div className="flex flex-wrap gap-4">
          <div>
            <p className="mb-1.5 text-xs text-gray-600">Market</p>
            <div className="flex flex-wrap gap-1.5">{markets.map((item) => <Pill key={item} value={item} active={market === item} onClick={() => onApplyFilter(() => setMarket(item))} />)}</div>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-gray-600">Status</p>
            <div className="flex flex-wrap gap-1.5">{statuses.map((item) => <Pill key={item} value={item} active={status === item} onClick={() => onApplyFilter(() => setStatus(item))} />)}</div>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-gray-600">Mode</p>
            <div className="flex gap-1.5">{modes.map((item) => <Pill key={item} value={item} active={mode === item} onClick={() => onApplyFilter(() => setMode(item))} />)}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="Net P&L"
          value={market === 'all' ? 'N/A' : formatPnlAmount(summary.totalPnl, getMarketCurrency(market))}
          sub={market === 'all'
            ? 'Select a market type to view Net P&L'
            : `all closed trades${typeof summary.totalFees === 'number' ? ` - Fees ${formatAmount(summary.totalFees, getMarketCurrency(market))}` : ''}`
          }
          color={market === 'all' ? 'text-gray-400' : (summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400')}
          icon={market === 'all' ? TrendingUp : (summary.totalPnl >= 0 ? TrendingUp : TrendingDown)}
        />
        <StatCard label="Win Rate" value={`${summary.winRate}%`} sub={`${summary.closed} closed trades`} color={summary.winRate >= 50 ? "text-emerald-400" : "text-red-400"} icon={Activity} />
        <div className="col-span-2 lg:col-span-1">
          <StatCard label="Total Trades" value={summary.total.toLocaleString()} sub="matching current filters" color="text-gray-200" icon={Filter} />
        </div>
      </div>

      <div className="flex min-h-[36px] flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-400">{selected.size} selected</span>
              <button onClick={() => setConfirm({ type: "selected", label: "Delete Selected", message: `Delete ${selected.size} trade${selected.size !== 1 ? "s" : ""}? This cannot be undone.` })} disabled={isBusy} className="flex items-center gap-1.5 rounded-lg border border-red-900/30 bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-40">
                <Trash2 className="h-3 w-3" /> Delete Selected
              </button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setConfirm({ type: "paper", label: "Delete Paper Trades", message: "Delete ALL paper trades? This cannot be undone." })} disabled={isBusy} className="flex items-center gap-1.5 rounded-lg border border-amber-900/30 bg-amber-900/15 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-900/25 disabled:opacity-40">
            <Trash2 className="h-3 w-3" /> Delete Paper
          </button>
          <button onClick={() => setConfirm({ type: "live", label: "Delete Live Trades", message: "Delete ALL live trades? This cannot be undone." })} disabled={isBusy} className="flex items-center gap-1.5 rounded-lg border border-red-900/30 bg-red-900/15 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/25 disabled:opacity-40">
            <Trash2 className="h-3 w-3" /> Delete Live
          </button>
          <button onClick={() => setConfirm({ type: "all", label: "Delete All Trades", message: "Delete EVERY trade? This cannot be undone." })} disabled={isBusy} className="flex items-center gap-1.5 rounded-lg border border-red-900/40 bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-40">
            <Trash2 className="h-3 w-3" /> Delete All
          </button>
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="w-10 py-3 pl-4">
                  <button onClick={onToggleAll} className="text-gray-500 transition-colors hover:text-brand-500">
                    {allSelected ? <CheckSquare className="h-4 w-4 text-brand-500" /> : <Square className="h-4 w-4" />}
                  </button>
                </th>
                {["Symbol", "Side", "Market", "Entry", "Amount", "Exit", "Net P&L", "Status", "Mode", "Date", ""].map((heading) => (
                  <th key={heading} className="px-2 pb-3 pt-3 text-left text-xs font-medium text-gray-600 last:pr-4">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {isLoading ? (
                Array.from({ length: 8 }).map((_, index) => (
                  <tr key={index} className="border-b border-gray-800/50">
                    <td colSpan={11} className="px-4 py-3"><div className="h-4 w-full animate-pulse rounded bg-gray-800" /></td>
                  </tr>
                ))
              ) : trades.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-sm text-gray-600">No trades match your filters</td>
                </tr>
              ) : trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} showCheckbox isChecked={selected.has(trade.id)} onToggle={onToggleOne} onDelete={onDeleteTrade} isBusy={isBusy} showMode showDetails />
              ))}
            </tbody>
          </table>
        </div>
        <Paginator pagination={pagination} onPage={(nextPage) => { setPage(nextPage); setSelected(new Set()); }} onPrefetch={onPrefetchPage} />
      </div>
    </>
  );
}
