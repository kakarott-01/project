"use client"

import React from 'react'
import { Loader2, ChevronUp, ChevronDown } from 'lucide-react'
import { InlineAlert } from '@/components/ui/inline-alert'
import { StatusBadge } from '@/components/ui/status-badge'
import CapitalCard from '@/components/dashboard/strategy-settings/CapitalCard'
import { InfoTip } from '@/components/ui/tooltip'
import NumberField from '@/components/dashboard/strategy-settings/NumberField'
import { defaultStrategySettings } from '@/components/dashboard/strategy-settings/helpers'
import { Button } from '@/components/ui/button'

type Props = {
  market: any
  isExpanded: boolean
  config: any
  isBotActiveHere: boolean
  totalCapital: number
  strategies: any[]
  updateMarket: (marketType: any, updater: (c: any) => any) => void
  toggleStrategy: (marketType: any, strategyKey: string) => void
  handleSave: (marketType: any, config: any) => void
  savingMarket: string | null
  toggleMarket: (marketId: string) => void
}

function MarketSection({ market, isExpanded, config, isBotActiveHere, totalCapital, strategies, updateMarket, toggleStrategy, handleSave, savingMarket, toggleMarket }: Props) {
  const capitalCards = (config.strategyKeys ?? []).map((strategyKey: string) => {
    const settings = config.strategySettings?.[strategyKey] ?? defaultStrategySettings()
    const maxActiveCapital = totalCapital * (settings.capitalAllocation.maxActivePercent / 100)
    const perTradeCapital = totalCapital * (settings.capitalAllocation.perTradePercent / 100)
    return { strategyKey, maxActiveCapital, perTradeCapital, settings }
  })

  const marketCap = totalCapital * (config.maxCapitalPerStrategyPct / 100)
  const allocatedCapital = capitalCards.reduce((sum: number, item: any) => sum + item.maxActiveCapital, 0)
  const remainingCapital = Math.max(0, totalCapital - allocatedCapital)

  return (
    <div className={`rounded-2xl border transition-colors overflow-hidden ${isExpanded ? 'border-gray-700 bg-gray-900/50' : 'border-gray-800 bg-gray-900/20 hover:border-gray-700'}`}>
      <button type="button" onClick={() => toggleMarket(market.id)} className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-800/30">
        <div className="flex items-center gap-3 min-w-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-gray-100">{market.label}</span>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge tone={config.strategyKeys.length > 0 ? 'success' : 'neutral'}>
                  {config.strategyKeys.length > 0 ? `${config.strategyKeys.length} strategy` : 'No strategies'}
                </StatusBadge>
              </div>
            </div>
            {!isExpanded && config.strategyKeys.length > 0 && (
              <p className="text-xs text-gray-500 mt-0.5">{config.strategyKeys.join(', ')} · {config.executionMode}</p>
            )}
            {!isExpanded && config.strategyKeys.length === 0 && (
              <p className="text-xs text-gray-600 mt-0.5">Click to configure strategies</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
          {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
        </div>
      </button>

      {isExpanded && (
        <div className="px-5 pb-5 border-t border-gray-800 pt-5">
          {isBotActiveHere && (
            <InlineAlert tone="warning" title={`${market.label} is actively trading.`} className="mb-4">
              Stop this market before changing its strategy configuration.
            </InlineAlert>
          )}

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-5">
            <div>
              <p className="text-sm text-gray-500 max-w-2xl">SAFE keeps positions netted. AGGRESSIVE lets selected strategies trade independently while still respecting global limits.</p>
            </div>

            <div className="inline-flex overflow-hidden rounded-xl border border-gray-700 flex-shrink-0">
              {(['SAFE', 'AGGRESSIVE'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={isBotActiveHere}
                  onClick={() => updateMarket(market.id, (current: any) => ({
                    ...current,
                    executionMode: mode,
                    positionMode: mode === 'SAFE' ? 'NET' : current.positionMode,
                    allowHedgeOpposition: mode === 'SAFE' ? false : current.allowHedgeOpposition,
                  }))}
                  className={`px-4 py-2 text-xs font-medium transition ${config.executionMode === mode ? (mode === 'AGGRESSIVE' ? 'bg-red-500/15 text-red-200' : 'bg-brand-500/15 text-brand-300') : 'text-gray-500 hover:text-gray-300'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {config.executionMode === 'AGGRESSIVE' && (
            <InlineAlert tone="danger" title="AGGRESSIVE mode is active" className="mb-4">
              Strategies trade independently. Capital splits, priority-based blocking, and hedge behavior now matter market by market.
            </InlineAlert>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]">
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <NumberField label="Max positions / symbol" tip="Hard market-level ceiling before a symbol is considered saturated." value={config.maxPositionsPerSymbol} min={1} max={10} disabled={isBotActiveHere} onChange={(value) => updateMarket(market.id, (current: any) => ({ ...current, maxPositionsPerSymbol: value }))} />
                <NumberField label="Market max capital %" tip="Soft cap for this market's strategy exposure. Global max position size still caps each order." value={config.maxCapitalPerStrategyPct} min={1} max={100} suffix="%" disabled={isBotActiveHere} onChange={(value) => updateMarket(market.id, (current: any) => ({ ...current, maxCapitalPerStrategyPct: value }))} />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="space-y-1.5">
                  <span className="flex items-center gap-2 text-xs text-gray-500">Position mode <InfoTip text="NET keeps one net position per symbol. HEDGE allows opposing exposure if the exchange supports it." /></span>
                  <select disabled={isBotActiveHere || config.executionMode !== 'AGGRESSIVE'} value={config.positionMode} onChange={(event) => updateMarket(market.id, (current: any) => ({ ...current, positionMode: event.target.value }))} className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 disabled:opacity-60">
                    <option value="NET">NET</option>
                    <option value="HEDGE">HEDGE</option>
                  </select>
                </label>

                <NumberField label="Auto-stop drawdown %" tip="If strategy drawdown breaches this threshold, new entries are halted for that market." value={config.maxDrawdownPct} min={1} max={100} suffix="%" disabled={isBotActiveHere} onChange={(value) => updateMarket(market.id, (current: any) => ({ ...current, maxDrawdownPct: value }))} />

                <div className="rounded-2xl border border-gray-800 bg-gray-950/50 p-4">
                  <p className="text-xs text-gray-500">Exchange capability</p>
                  <p className="mt-2 text-sm font-semibold text-gray-100">{config.exchangeCapabilities?.effectivePositionMode ?? config.positionMode}</p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{config.exchangeCapabilities?.warning ?? 'No exchange restrictions detected for this market.'}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={config.allowHedgeOpposition} disabled={isBotActiveHere || config.positionMode !== 'HEDGE'} onChange={(event) => updateMarket(market.id, (current: any) => ({ ...current, allowHedgeOpposition: event.target.checked }))} />
                  Allow LONG + SHORT simultaneously
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={config.conflictBlocking} disabled={isBotActiveHere} onChange={(event) => updateMarket(market.id, (current: any) => ({ ...current, conflictBlocking: event.target.checked }))} />
                  Block start when conflicts are detected
                </label>
              </div>

              {(config.conflictWarnings?.length ?? 0) > 0 ? (
                <InlineAlert tone="warning" title="Conflict detection">
                  {config.conflictWarnings?.map((warning: any) => (
                    <p key={warning.code}>{warning.message}</p>
                  ))}
                </InlineAlert>
              ) : null}
            </div>

            <div className="rounded-3xl border border-gray-800 bg-gray-950/40 p-4">
              <div className="flex items-center gap-2">
                <StatusBadge tone="neutral">CAPITAL</StatusBadge>
                <p className="text-sm font-medium text-gray-200">Allocation preview</p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">Total capital</p>
                  <p className="mt-2 text-sm font-semibold text-gray-100">₹{totalCapital.toLocaleString('en-IN')}</p>
                </div>

                <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">Per-market allocation</p>
                  <p className="mt-2 text-sm font-semibold text-gray-100">₹{marketCap.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                </div>

                <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">Per-strategy allocation</p>
                  <p className="mt-2 text-sm font-semibold text-gray-100">₹{allocatedCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                </div>

                <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">Remaining capital</p>
                  <p className="mt-2 text-sm font-semibold text-gray-100">₹{remainingCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {capitalCards.length > 0 ? (
                  capitalCards.map((item: any) => <CapitalCard key={item.strategyKey} item={item} />)
                ) : (
                  <div className="rounded-2xl border border-dashed border-gray-800 bg-gray-950/40 px-4 py-8 text-center">
                    <p className="text-sm text-gray-300">No strategies selected</p>
                    <p className="mt-1 text-xs text-gray-500">Pick up to two strategies to see per-market and per-strategy capital allocation.</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-3 flex items-center gap-2">
              <StatusBadge tone="success">STRATEGY</StatusBadge>
              <p className="text-sm font-medium text-gray-200">Select up to 2 strategies</p>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(strategies ?? []).map((strategy: any) => {
                const selected = (config.strategyKeys ?? []).includes(strategy.strategyKey)
                return (
                  <button
                    key={strategy.strategyKey}
                    type="button"
                    disabled={isBotActiveHere || (!selected && (config.strategyKeys ?? []).length >= 2)}
                    onClick={() => toggleStrategy(market.id, strategy.strategyKey)}
                    className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-brand-500/50 bg-brand-500/10' : 'border-gray-800 bg-gray-950/60 hover:border-gray-700'} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-gray-100">{strategy.name}</span>
                      <StatusBadge tone={strategy.riskLevel === 'HIGH' ? 'danger' : strategy.riskLevel === 'MEDIUM' ? 'warning' : 'success'}>{strategy.riskLevel}</StatusBadge>
                    </div>
                    <p className="mt-2 text-xs text-gray-400">{strategy.description}</p>
                    <div className="mt-3 grid gap-1 text-[11px] text-gray-500">
                      <div>Win rate {strategy.historicalPerformance.winRate}%</div>
                      <div>Average return {strategy.historicalPerformance.averageReturn}%</div>
                      <div>Max drawdown {strategy.historicalPerformance.maxDrawdown}%</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="sticky-actions mt-5">
            <div className="text-xs text-gray-500">Selected: {config.strategyKeys.length ? config.strategyKeys.join(', ') : 'None'}</div>
            <Button onClick={() => handleSave(market.id, config)} disabled={isBotActiveHere || savingMarket === market.id || (config.strategyKeys ?? []).length === 0}>
              {savingMarket === market.id ? (<><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>) : 'Save market settings'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default React.memo(MarketSection)
