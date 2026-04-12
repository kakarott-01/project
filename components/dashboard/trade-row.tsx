'use client'

import React from 'react'
import type { Trade } from '@/components/dashboard/trade-table'
import { formatINR, formatPnl } from '@/lib/utils'
import { format } from 'date-fns'
import { ArrowUpRight, ArrowDownRight, Trash2, CheckSquare, Square } from 'lucide-react'

interface Props {
  trade: Trade
  showCheckbox?: boolean
  isChecked?: boolean
  onToggle?: () => void
  onDelete?: () => void
  isBusy?: boolean
  showMode?: boolean
}

function TradeRow({ trade, showCheckbox = false, isChecked = false, onToggle, onDelete, isBusy = false, showMode = false }: Props) {
  const pnl = Number(trade.netPnl ?? trade.pnl ?? 0)
  const isProfit = pnl > 0
  const amountUsed = Number(trade.quantity ?? 0) * Number(trade.entryPrice ?? 0)
  const feeAmount = Number(trade.feeAmount ?? 0)

  return (
    <tr className={`hover:bg-gray-800/30 transition-colors group ${showCheckbox && isChecked ? 'bg-brand-500/5' : ''}`}>
      {showCheckbox ? (
        <td className="py-2.5 pl-4 w-10">
          <button onClick={onToggle} className="text-gray-600 hover:text-brand-500 transition-colors">
            {isChecked ? <CheckSquare className="w-4 h-4 text-brand-500" /> : <Square className="w-4 h-4" />}
          </button>
        </td>
      ) : null}

      <td className={`py-2.5 px-2 ${showCheckbox ? '' : 'pl-4'} font-mono text-xs text-gray-300 font-medium`}>
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
        {formatINR(Number(trade.entryPrice))}
      </td>

      <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
        <div>{formatINR(amountUsed)}</div>
        <div className="text-[11px] text-gray-600">qty {Number(trade.quantity ?? 0).toFixed(4)}</div>
      </td>

      <td className="py-2.5 px-2 text-xs text-gray-400 font-mono">
        {trade.exitPrice ? formatINR(Number(trade.exitPrice)) : '—'}
      </td>

      <td className="py-2.5 px-2">
        {(trade.netPnl != null || trade.pnl != null) ? (
          <div>
            <span className={`text-xs font-semibold font-mono ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatPnl(pnl)}
            </span>
            {feeAmount > 0 && (
              <div className="text-[11px] text-gray-600">fees {formatINR(feeAmount)}</div>
            )}
          </div>
        ) : <span className="text-gray-600 text-xs">—</span>}
      </td>

      <td className="py-2.5 px-2">
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          trade.status === 'closed'    ? 'badge-gray' :
          trade.status === 'open'      ? 'bg-brand-500/10 border-brand-500/20 text-brand-500' :
          trade.status === 'failed'    ? 'bg-red-900/20 border-red-800/30 text-red-400' : 'badge-gray'
        }`}>{trade.status}</span>
      </td>

      {showMode ? (
        <td className="py-2.5 px-2">
          {trade.isPaper ? <span className="text-xs text-amber-500">Paper</span> : <span className="text-xs text-red-400">Live</span>}
        </td>
      ) : null}

      <td className="py-2.5 px-2 text-xs text-gray-600">
        {format(new Date(trade.openedAt), 'dd MMM HH:mm')}
      </td>

      {onDelete ? (
        <td className="py-2.5 px-2 pr-4">
          <button onClick={onDelete} disabled={isBusy}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-40">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </td>
      ) : null}
    </tr>
  )
}

export default React.memo(TradeRow)
