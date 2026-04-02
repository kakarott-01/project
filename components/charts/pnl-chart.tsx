'use client'
import { useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Area, AreaChart
} from 'recharts'
import { format } from 'date-fns'

interface Props { trades: any[] }

export function PnlChart({ trades }: Props) {
  const data = useMemo(() => {
    const closed = trades
      // FIX M: added `&& t.closedAt != null` — prevents new Date(null) = epoch
      // which silently corrupted the sort and produced a flat line at 0
      .filter(t => t.status === 'closed' && t.pnl != null && t.closedAt != null)
      .sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime())

    let cumulative = 0
    return closed.map(t => {
      cumulative += Number(t.pnl)
      return {
        date: format(new Date(t.closedAt), 'dd MMM'),
        pnl:  Math.round(cumulative * 100) / 100,
      }
    })
  }, [trades])

  if (data.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-gray-600">
        No closed trades yet — run the bot to see P&L data
      </div>
    )
  }

  const isPositive = data[data.length - 1]?.pnl >= 0

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const val = payload[0].value
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs shadow-xl">
        <p className="text-gray-500 mb-0.5">{label}</p>
        <p className={`font-semibold ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {val >= 0 ? '+' : ''}₹{val.toLocaleString('en-IN')}
        </p>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={isPositive ? '#1D9E75' : '#E24B4A'} stopOpacity={0.15} />
            <stop offset="95%" stopColor={isPositive ? '#1D9E75' : '#E24B4A'} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={v => `₹${v >= 1000 ? (v/1000).toFixed(1)+'k' : v}`}
          width={55}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
        <Area
          type="monotone"
          dataKey="pnl"
          stroke={isPositive ? '#1D9E75' : '#E24B4A'}
          strokeWidth={2}
          fill="url(#pnlGradient)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}