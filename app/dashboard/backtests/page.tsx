'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BarChart3, CalendarRange, Loader2, Play } from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const MARKETS = [
  { id: 'indian', label: 'Indian', category: 'STOCKS' },
  { id: 'crypto', label: 'Crypto', category: 'CRYPTO' },
  { id: 'commodities', label: 'Commodities', category: 'FOREX' },
  { id: 'global', label: 'Global', category: 'STOCKS' },
] as const

type StrategyItem = {
  strategyKey: string
  name: string
  description: string
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  supportedMarkets: string[]
  supportedTimeframes: string[]
}

const DEFAULT_ASSETS = {
  indian: 'RELIANCE',
  crypto: 'BTC/USDT',
  commodities: 'XAU/USD',
  global: 'SPY',
} as const

const MAX_RANGE_START = '2017-01-01T00:00'
const MAX_RANGE_HINT = 'Backtests now fetch history in chunks, so the usable range is the full exchange-available history for the chosen asset and timeframe.'

export default function BacktestsPage() {
  const qc = useQueryClient()
  const [marketType, setMarketType] = useState<'indian' | 'crypto' | 'commodities' | 'global'>('crypto')
  const [asset, setAsset] = useState<string>(DEFAULT_ASSETS.crypto)
  const [timeframe, setTimeframe] = useState('15m')
  const [executionMode, setExecutionMode] = useState<'SAFE' | 'AGGRESSIVE'>('SAFE')
  const [positionMode, setPositionMode] = useState<'NET' | 'HEDGE'>('NET')
  const [allowHedgeOpposition, setAllowHedgeOpposition] = useState(false)
  const [initialCapital, setInitialCapital] = useState(10000)
  const [dateFrom, setDateFrom] = useState(() => new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 16))
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 16))
  const [strategyKeys, setStrategyKeys] = useState<string[]>(['TREND_RIDER_V1'])
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: strategyData } = useQuery({
    queryKey: ['strategy-catalog'],
    queryFn: () => fetch('/api/strategies').then((r) => r.json()),
  })

  const { data: runsData } = useQuery({
    queryKey: ['backtest-runs'],
    queryFn: () => fetch('/api/backtests').then((r) => r.json()),
  })

  const strategies: StrategyItem[] = strategyData?.strategies ?? []
  const marketCategory = MARKETS.find((market) => market.id === marketType)?.category ?? 'CRYPTO'
  const filteredStrategies = useMemo(
    () => strategies.filter((strategy) => strategy.supportedMarkets.includes(marketCategory)),
    [marketCategory, strategies],
  )
  const timeframeOptions = useMemo(
    () => Array.from(new Set(filteredStrategies.flatMap((strategy) => strategy.supportedTimeframes))).sort((a, b) => timeframeToMinutes(a) - timeframeToMinutes(b)),
    [filteredStrategies],
  )

  useEffect(() => {
    setAsset(DEFAULT_ASSETS[marketType])
  }, [marketType])

  useEffect(() => {
    if (executionMode === 'SAFE') {
      setPositionMode('NET')
      setAllowHedgeOpposition(false)
    }
  }, [executionMode])

  useEffect(() => {
    setStrategyKeys((current) => current.filter((key) => filteredStrategies.some((strategy: any) => strategy.strategyKey === key)).slice(0, 2))
  }, [filteredStrategies])

  useEffect(() => {
    if (timeframeOptions.length === 0) return
    const supportedBySelection = strategyKeys.length > 0
      ? filteredStrategies
          .filter((strategy) => strategyKeys.includes(strategy.strategyKey))
          .every((strategy) => strategy.supportedTimeframes.includes(timeframe))
      : timeframeOptions.includes(timeframe)

    if (!supportedBySelection || !timeframeOptions.includes(timeframe)) {
      setTimeframe(timeframeOptions[0])
    }
  }, [filteredStrategies, strategyKeys, timeframe, timeframeOptions])

  const runMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketType,
          asset,
          timeframe,
          executionMode,
          positionMode,
          allowHedgeOpposition,
          initialCapital,
          dateFrom: new Date(dateFrom).toISOString(),
          dateTo: new Date(dateTo).toISOString(),
          strategyKeys,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Backtest failed')
      return data
    },
    onSuccess: (data) => {
      setResult(data)
      setError(null)
      qc.invalidateQueries({ queryKey: ['backtest-runs'] })
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const deployMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/backtests/${id}/deploy`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to deploy configuration')
      return data
    },
  })

  function toggleStrategy(strategyKey: string) {
    setStrategyKeys((current) => {
      if (current.includes(strategyKey)) return current.filter((key) => key !== strategyKey)
      return [...current, strategyKey].slice(0, 2)
    })
  }

  const metrics = result?.performance_metrics
  const equityCurve = result?.equity_curve ?? []
  const tradeSummary = result?.trade_summary ?? []
  const selectedStrategyLabels = strategyKeys.length ? strategyKeys.join(' + ') : 'No strategies selected'

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-2xl border border-gray-800 bg-gradient-to-br from-gray-900 via-slate-900 to-gray-950 p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100 sm:text-2xl">Backtests</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">
            Run black-box strategies against historical data without exposing internal logic. The engine now paginates OHLCV requests so you can use the broadest exchange-supported date range.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="badge-gray">Server-side execution only</div>
          <div className="badge-gray">Max history enabled</div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
        <div className="card space-y-4 self-start xl:sticky xl:top-6">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-brand-500" />
            <h2 className="text-sm font-medium text-gray-200">Run Backtest</h2>
          </div>

          <div className="rounded-xl border border-brand-500/20 bg-brand-500/10 px-3 py-3 text-xs text-gray-300">
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-400" />
              <div className="space-y-2">
                <p>{MAX_RANGE_HINT}</p>
                <button
                  type="button"
                  onClick={() => setDateFrom(MAX_RANGE_START)}
                  className="inline-flex rounded-lg border border-brand-500/25 bg-brand-500/10 px-2.5 py-1.5 text-[11px] font-medium text-brand-300 transition-colors hover:bg-brand-500/15"
                >
                  Use max range
                </button>
              </div>
            </div>
          </div>

          {executionMode === 'AGGRESSIVE' && (
            <div className="bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2.5 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-200/85">
                AGGRESSIVE MODE ENABLED: strategies run independently, risk is higher, and opposite trades may occur if hedge mode is enabled.
              </p>
            </div>
          )}

          <div className="grid gap-3">
            <label className="space-y-1">
              <span className="text-xs text-gray-500">Market</span>
              <select value={marketType} onChange={(e) => setMarketType(e.target.value as any)} className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100">
                {MARKETS.map((market) => <option key={market.id} value={market.id}>{market.label}</option>)}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs text-gray-500">Asset</span>
              <input value={asset} onChange={(e) => setAsset(e.target.value)} className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100" />
            </label>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-gray-500">Timeframe</span>
                <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100">
                  {timeframeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-gray-500">Initial Capital</span>
                <input type="number" value={initialCapital} onChange={(e) => setInitialCapital(Number(e.target.value))} className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100" />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-gray-500">From</span>
                <input type="datetime-local" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100" />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-gray-500">To</span>
                <input type="datetime-local" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100" />
              </label>
            </div>

            <div className="space-y-2">
              <span className="text-xs text-gray-500">Execution Mode</span>
              <div className="inline-flex w-full overflow-hidden rounded-xl border border-gray-800 sm:w-auto">
                {(['SAFE', 'AGGRESSIVE'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setExecutionMode(mode)}
                    className={`flex-1 px-3 py-2 text-xs font-medium ${executionMode === mode ? mode === 'AGGRESSIVE' ? 'bg-red-500/15 text-red-300' : 'bg-brand-500/15 text-brand-400' : 'text-gray-500'}`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs text-gray-500">Position Mode</span>
                <select
                  value={positionMode}
                  onChange={(e) => setPositionMode(e.target.value as 'NET' | 'HEDGE')}
                  disabled={executionMode !== 'AGGRESSIVE'}
                  className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100 disabled:opacity-60"
                >
                  <option value="NET">NET</option>
                  <option value="HEDGE">HEDGE</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-gray-500">Hedge overlap</span>
                <select
                  value={allowHedgeOpposition ? 'allow' : 'block'}
                  onChange={(e) => setAllowHedgeOpposition(e.target.value === 'allow')}
                  disabled={positionMode !== 'HEDGE' || executionMode !== 'AGGRESSIVE'}
                  className="w-full rounded-xl bg-gray-900 border border-gray-800 px-3 py-2.5 text-sm text-gray-100 disabled:opacity-60"
                >
                  <option value="block">Block opposite overlap</option>
                  <option value="allow">Allow LONG + SHORT</option>
                </select>
              </label>
            </div>

            <div className="space-y-2">
              <span className="text-xs text-gray-500">Strategies</span>
              <div className="grid gap-2">
                {filteredStrategies.map((strategy) => {
                  const selected = strategyKeys.includes(strategy.strategyKey)
                  const supported = strategy.supportedTimeframes.includes(timeframe)
                  return (
                    <button
                      key={strategy.strategyKey}
                      type="button"
                      disabled={(!selected && strategyKeys.length >= 2) || !supported}
                      onClick={() => toggleStrategy(strategy.strategyKey)}
                      className={`rounded-xl border p-3 text-left transition-colors ${selected ? 'border-brand-500/40 bg-brand-500/10' : 'border-gray-800 bg-gray-950/60'} ${supported ? 'hover:border-gray-700' : 'opacity-50'} disabled:cursor-not-allowed`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-100">{strategy.name}</span>
                        <span className="text-[11px] text-gray-500">{strategy.riskLevel}</span>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">{strategy.description}</p>
                      <p className="mt-2 text-[11px] text-gray-500">
                        {supported ? `Supports ${strategy.supportedTimeframes.join(', ')}` : `Not available on ${timeframe}`}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button onClick={() => runMutation.mutate()} disabled={runMutation.isPending || strategyKeys.length === 0} className="btn-primary w-full">
            {runMutation.isPending ? <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Running…</span> : <><Play className="w-4 h-4" /> Run Backtest</>}
          </button>
        </div>

        <div className="space-y-5">
          <div className="card">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-medium text-gray-300">Performance</h2>
              <span className="badge-gray">{result ? `${selectedStrategyLabels} · ${executionMode} · ${positionMode}` : 'Awaiting run'}</span>
            </div>
            {metrics ? (
              <div className="grid gap-3 grid-cols-2 xl:grid-cols-5">
                <Metric title="Return" value={`${metrics.totalReturnPct}%`} />
                <Metric title="Win Rate" value={`${metrics.winRate}%`} />
                <Metric title="Max DD" value={`${metrics.maxDrawdown}%`} />
                <Metric title="Sharpe" value={String(metrics.sharpeRatio)} />
                <Metric title="Profit Factor" value={String(metrics.profitFactor)} />
              </div>
            ) : (
              <p className="text-sm text-gray-500">Run a backtest to see metrics, equity curve, and trade summary.</p>
            )}
            {result?.strategy_breakdown && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {Object.entries(result.strategy_breakdown).map(([key, item]: any) => (
                  <div key={key} className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-3">
                    <div className="text-xs text-gray-500">{key}</div>
                    <div className="mt-1 text-sm text-gray-100">Return {item.totalReturnPct}%</div>
                    <div className="text-xs text-gray-400">Win rate {item.winRate}% · Max DD {item.maxDrawdown}%</div>
                  </div>
                ))}
              </div>
            )}
            {result?.id && (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => deployMutation.mutate(result.id)}
                  disabled={deployMutation.isPending}
                  className="btn-primary"
                >
                  {deployMutation.isPending ? 'Deploying…' : 'Deploy this configuration'}
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-medium text-gray-300">Equity Curve</h2>
              <span className="badge-gray">{equityCurve.length} points</span>
            </div>
            <div className="h-64 sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={equityCurve}>
                  <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" hide />
                  <YAxis stroke="#6b7280" />
                  <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151' }} />
                  <Line type="monotone" dataKey="equity" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-medium text-gray-300">Trade Summary</h2>
              <span className="badge-gray">{tradeSummary.length} trades</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800">
                    <th className="pb-2">#</th>
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Result</th>
                    <th className="pb-2">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeSummary.map((trade: any) => (
                    <tr key={trade.tradeNumber} className="border-b border-gray-900 text-gray-300">
                      <td className="py-2">{trade.tradeNumber}</td>
                      <td className="py-2">{trade.tradeType}</td>
                      <td className={`py-2 ${trade.result >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{trade.result}%</td>
                      <td className="py-2">{trade.duration} bars</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-medium text-gray-300">Recent Runs</h2>
              <span className="badge-gray">{runsData?.runs?.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {(runsData?.runs ?? []).map((run: any) => (
                <div key={run.id} className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-gray-200">{run.asset} · {run.executionMode} · {run.positionMode ?? 'NET'}</p>
                      <p className="text-xs text-gray-500">{(run.strategyKeys ?? []).join(', ')}</p>
                    </div>
                    <span className="text-xs text-gray-500">{run.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-3">
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-lg font-semibold text-gray-100 mt-1">{value}</div>
    </div>
  )
}

function timeframeToMinutes(timeframe: string) {
  const value = Number(timeframe.slice(0, -1))
  const unit = timeframe.slice(-1)
  if (unit === 'm') return value
  if (unit === 'h') return value * 60
  if (unit === 'd') return value * 60 * 24
  return Number.MAX_SAFE_INTEGER
}
