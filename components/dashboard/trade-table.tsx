'use client'
import TradeRow from '@/components/dashboard/trade-row'

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
          {trades.map(trade => (
            <TradeRow key={trade.id} trade={trade} />
          ))}
        </tbody>
      </table>
    </div>
  )
}