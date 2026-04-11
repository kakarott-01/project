"use client"

import React from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  AreaChart, Area, ReferenceLine,
} from 'recharts'
import { formatPnl, formatINR } from '@/lib/utils'

type DailyRow = {
  date: string
  pnl: number
  fees: number
  trades: number
  wins: number
  losses: number
}

type PerformanceChartsProps = {
  isLoading: boolean
  cumPnl: Array<{ date: string; pnl: number }>
  daily: DailyRow[]
  byMarket: Array<{ market: string; total: number; closed: number; winners: number; pnl: number; fees: number }>
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const val = payload[0]?.value ?? 0
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-500 mb-0.5">{label}</p>
      <p className={`font-semibold ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {formatPnl(Number(val))}
      </p>
    </div>
  )
}

export default function PerformanceCharts({ isLoading, cumPnl, daily, byMarket }: PerformanceChartsProps) {
  const isPositive = cumPnl.length > 0 ? (cumPnl[cumPnl.length - 1].pnl >= 0) : true

  return (
    <>
      <div className="card">
        <h2 className="text-sm font-medium text-gray-400 mb-4">Cumulative Net P&L</h2>
        {isLoading ? (
          <div className="h-44 bg-gray-800/40 rounded-lg animate-pulse" />
        ) : cumPnl.length === 0 ? (
          <div className="h-44 flex items-center justify-center text-sm text-gray-600">
            No closed trades yet - run the bot to see data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={cumPnl} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isPositive ? '#1D9E75' : '#E24B4A'} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={isPositive ? '#1D9E75' : '#E24B4A'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis
                tick={{ fontSize: 10, fill: '#6b7280' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(value) => `₹${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}`}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke={isPositive ? '#1D9E75' : '#E24B4A'}
                strokeWidth={2}
                fill="url(#cumGrad)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card">
        <h2 className="text-sm font-medium text-gray-400 mb-4">Daily P&L - Last 30 Days</h2>
        {isLoading ? (
          <div className="h-44 bg-gray-800/40 rounded-lg animate-pulse" />
        ) : daily.length === 0 ? (
          <p className="text-sm text-gray-600 text-center py-8">No closed trades yet</p>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={daily} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 10, fill: '#6b7280' }}
                axisLine={false}
                tickLine={false}
                width={55}
                tickFormatter={(value) => `₹${value}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                {daily.map((row: any, index: number) => (
                  <Cell key={index} fill={row.pnl >= 0 ? '#1D9E75' : '#E24B4A'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card">
        <h2 className="text-sm font-medium text-gray-400 mb-4">Performance by Market</h2>
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 bg-gray-800/40 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {['indian', 'crypto', 'commodities', 'global'].map((value) => {
              const marketRow = byMarket.find((row: any) => row.market === value)
              const pnl = marketRow?.pnl ?? 0
              const total = marketRow?.total ?? 0
              const closed = marketRow?.closed ?? 0
              const winners = marketRow?.winners ?? 0
              const wr = closed > 0 ? Math.round((winners / closed) * 100) : 0

              return (
                <div key={value} className="bg-gray-800/50 rounded-xl p-3 border border-gray-700/50">
                  <p className="text-xs text-gray-500 capitalize mb-1.5">{value}</p>
                  <p className={`text-lg font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatPnl(pnl).replace('.00', '')}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {total} trades · {wr}% WR · Fees {formatINR(marketRow?.fees ?? 0).replace('.00', '')}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
