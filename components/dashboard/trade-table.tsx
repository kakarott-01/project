'use client'
import { formatINR, formatPnl } from '@/lib/utils'
import { format } from 'date-fns'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'

// FIX: Proper typed interface instead of any[]
export interface Trade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  marketType: string
  quantity: string | number
  entryPrice: string | number
  exitPrice?: string | number | null
  pnl?: string | number | null
  netPnl?: string | number | null
  feeAmount?: string | number | null
  status: string
  isPaper: boolean
  openedAt: string
  closedAt?: string | null
  exchangeName?: string
}

interface Props {
  trades: Trade[]
  compact?: boolean
}

export function TradeTable({ trades, compact }: Props) {
  if (!trades.length) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-800 bg-gray-950/30 px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-200">No trades yet</p>
        <p className="mt-2 text-sm text-gray-500">Enable a market session and the first live or paper trades will appear here.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto -mx-4 md:mx-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            {['Symbol', 'Side', 'Market', 'Entry', 'Amount', 'Exit', 'Net P&L', 'Status', 'Date'].map(h => (
              <th key={h} className="text-left text-xs text-gray-600 font-medium pb-2.5 px-2 first:pl-4 last:pr-4">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {trades.map(trade => {
            const pnl = Number(trade.netPnl ?? trade.pnl ?? 0)
            const isProfit = pnl > 0
            const amountUsed = Number(trade.quantity ?? 0) * Number(trade.entryPrice ?? 0)
            const feeAmount = Number(trade.feeAmount ?? 0)
            return (
              <tr key={trade.id} className="hover:bg-gray-800/30 transition-colors group">
                <td className="py-2.5 px-2 pl-4 font-mono text-xs text-gray-300 font-medium">
                  {trade.symbol}
                  {trade.isPaper && <span className="ml-1.5 text-xs text-amber-600">[P]</span>}
                </td>
                <td className="py-2.5 px-2">
                  <div className={`flex items-center gap-1 text-xs font-medium ${
                    trade.side === 'buy' ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {trade.side === 'buy'
                      ? <ArrowUpRight className="w-3 h-3" />
                      : <ArrowDownRight className="w-3 h-3" />}
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
                    trade.status === 'open'      ? 'badge-blue' :
                    trade.status === 'failed'    ? 'badge-red'  :
                    trade.status === 'cancelled' ? 'badge-amber': 'badge-gray'
                  }`}>
                    {trade.status}
                  </span>
                </td>
                <td className="py-2.5 px-2 pr-4 text-xs text-gray-600">
                  {format(new Date(trade.openedAt), 'dd MMM HH:mm')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}