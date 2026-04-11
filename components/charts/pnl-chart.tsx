'use client'

// components/charts/pnl-chart.tsx — v2
// ========================================
// FIX: Accepts pre-computed cumPnlData (from /api/performance) instead of
//      raw trades. This fixes the bug where the chart only showed partial
//      cumulative PnL when >50 trades existed (the trades API is limited to 50 rows).
//
// Props:
//   cumPnlData: Array<{ date: string; pnl: number }>  — from /api/performance cumPnl
//
// The old `trades` prop is also accepted for backward compatibility in case
// other parts of the codebase still pass raw trades.

import { useMemo }  from 'react'
import {
  Tooltip, ResponsiveContainer, ReferenceLine, AreaChart, Area, XAxis, YAxis
} from 'recharts'

interface CumPnlPoint { date: string; pnl: number }
interface Trade       { status: string; pnl: any; closedAt: any }

interface Props {
  // New preferred prop: pre-computed from /api/performance
  cumPnlData?: CumPnlPoint[]
  // Legacy fallback: raw trades array (limited to 50 rows — avoid for main chart)
  trades?: Trade[]
}

// Tooltip moved to module scope so it is not recreated on every render
export function PnlCustomTooltip({ active, payload, label }: any) {
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

export function PnlChart({ cumPnlData, trades }: Props) {

  // Use pre-computed data if available, otherwise compute from trades (legacy path)
  const data: CumPnlPoint[] = useMemo(() => {
    if (cumPnlData && cumPnlData.length > 0) {
      return cumPnlData
    }

    // Legacy path (only for backward compat — shows partial data if trades >50)
    if (!trades || trades.length === 0) return []

    const closed = trades
      .filter(t => t.status === 'closed' && t.pnl != null && t.closedAt != null)
      .sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime())

    let cumulative = 0
    return closed.map(t => {
      cumulative += Number(t.pnl)
      return {
        date: new Date(t.closedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        pnl:  Math.round(cumulative * 100) / 100,
      }
    })
  }, [cumPnlData, trades])

  if (data.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-gray-600">
        No closed trades yet — run the bot to see P&L data
      </div>
    )
  }

  const isPositive = (data[data.length - 1]?.pnl ?? 0) >= 0

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
          axisLine={false} tickLine={false} interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false} tickLine={false}
          tickFormatter={v => `₹${v >= 1000 ? (v/1000).toFixed(1)+'k' : v}`}
          width={55}
        />
        <Tooltip content={<PnlCustomTooltip />} />
        <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
        <Area
          type="monotone" dataKey="pnl"
          stroke={isPositive ? '#1D9E75' : '#E24B4A'}
          strokeWidth={2} fill="url(#pnlGradient)"
          dot={false} activeDot={{ r: 4, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
