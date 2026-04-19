'use client'

import React from 'react'
import type { Trade } from '@/components/dashboard/trade-table'
import { getMarketCurrency, formatAmount, formatPnlAmount } from '@/lib/currency'
import { StatusBadge } from '@/components/ui/status-badge'
import { format } from 'date-fns'
import { ArrowUpRight, ArrowDownRight, Trash2, CheckSquare, Square } from 'lucide-react'

interface Props {
  trade: Trade
  showCheckbox?: boolean
  isChecked?: boolean
  onToggle?: (id: string) => void
  onDelete?: (id: string) => void
  isBusy?: boolean
  showMode?: boolean
  showDetails?: boolean
}

function TradeRow({
  trade,
  showCheckbox = false,
  isChecked = false,
  onToggle,
  onDelete,
  isBusy = false,
  showMode = false,
  showDetails = false,
}: Props) {
  const currency    = getMarketCurrency(trade.marketType, trade.symbol)
  // net P&L column removed for dashboard view; keep fee and amount calculations
  const amountUsed  = Number(trade.quantity ?? 0) * Number(trade.entryPrice ?? 0)
  const feeAmount   = Number(trade.feeAmount ?? 0)

  return (
    <tr className={`hover:bg-gray-800/30 transition-colors group ${showCheckbox && isChecked ? 'bg-brand-500/5' : ''}`}>
      {showCheckbox ? (
        <td className="py-2.5 pl-4 w-10">
          <button onClick={() => onToggle?.(trade.id)} className="text-gray-600 hover:text-brand-500 transition-colors">
            {isChecked ? <CheckSquare className="w-4 h-4 text-brand-500" /> : <Square className="w-4 h-4" />}
          </button>
        </td>
      ) : null}

      {/* Symbol */}
      <td className={`py-2.5 px-2 ${showCheckbox ? '' : 'pl-4'} font-mono text-xs text-gray-300 font-medium`}>
        {trade.symbol}
        {trade.isPaper && <span className="ml-1.5 text-xs text-amber-600">[P]</span>}
      </td>

      {/* Side */}
      <td className="py-2.5 px-2">
        <div className={`flex items-center gap-1 text-xs font-medium ${trade.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>
          {trade.side === 'buy' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
          {trade.side.toUpperCase()}
        </div>
      </td>

      {/* Market */}
      <td className="py-2.5 px-2">
        <span className="badge-gray capitalize">{trade.marketType}</span>
      </td>

      {/* Entry price */}
      <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
        {formatAmount(Number(trade.entryPrice), currency)}
      </td>

      {/* Amount / qty */}
      <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
        <div>{formatAmount(amountUsed, currency)}</div>
        <div className="text-[11px] text-gray-600">qty {Number(trade.quantity ?? 0).toFixed(4)}</div>
      </td>

      {/* Exit, Net P&L, Status - shown for trade-history / detailed views */}
      {showDetails ? (
        <>
          <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
            {trade.exitPrice != null ? formatAmount(Number(trade.exitPrice), currency) : '-'}
          </td>

          <td className="py-2.5 px-2 text-xs font-mono">
            {trade.netPnl != null ? (
              <span className={Number(trade.netPnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {formatPnlAmount(Number(trade.netPnl), currency)}
              </span>
            ) : '-'}
          </td>

          <td className="py-2.5 px-2">
            <StatusBadge tone={
              trade.status === 'closed' ? 'success' :
              trade.status === 'open' ? 'info' :
              trade.status === 'pending' ? 'neutral' :
              trade.status === 'cancelled' ? 'warning' : 'danger'
            }>{trade.status}</StatusBadge>
          </td>
        </>
      ) : null}

      {/* Mode (optional column) */}
      {showMode ? (
        <td className="py-2.5 px-2">
          {trade.isPaper
            ? <span className="text-xs text-amber-500">Paper</span>
            : <span className="text-xs text-red-400">Live</span>}
        </td>
      ) : null}

      {/* Date */}
      <td className="py-2.5 px-2 text-xs text-gray-600">
        {format(new Date(trade.openedAt), 'dd MMM HH:mm')}
      </td>

      {/* Delete */}
      {onDelete ? (
        <td className="py-2.5 px-2 pr-4">
          <button
            onClick={() => onDelete?.(trade.id)}
            disabled={isBusy}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </td>
      ) : null}
    </tr>
  )
}

export default React.memo(TradeRow)