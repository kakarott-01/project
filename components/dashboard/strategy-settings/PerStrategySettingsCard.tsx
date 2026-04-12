"use client"
import React from 'react'
import NumberField from '@/components/dashboard/strategy-settings/NumberField'
import { StatusBadge } from '@/components/ui/status-badge'
import { InfoTip } from '@/components/ui/tooltip'
import { defaultStrategySettings } from '@/components/dashboard/strategy-settings/helpers'

type Props = {
  marketId: string
  strategyKey: string
  settings: any
  isBotActiveHere: boolean
  isAggressive: boolean
  updateMarket: (marketType: any, updater: (c: any)=>any) => void
}

function PerStrategySettingsCard({ marketId, strategyKey, settings, isBotActiveHere, isAggressive, updateMarket }: Props) {
  const s = settings ?? defaultStrategySettings()

  return (
    <div className="rounded-3xl border border-gray-800 bg-gray-950/40 p-4">
      <div className="flex items-center gap-2">
        <StatusBadge tone="neutral">STRATEGY</StatusBadge>
        <p className="text-sm font-medium text-gray-200">{strategyKey}</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1.5">
          <span className="flex items-center gap-2 text-xs text-gray-500">Priority <InfoTip text="Higher-priority strategies can reserve room when capital is tight in AGGRESSIVE mode." /></span>
          <select disabled={isBotActiveHere} value={s.priority} onChange={(event) => updateMarket(marketId, (current: any) => ({ ...current, strategySettings: { ...current.strategySettings, [strategyKey]: { ...s, priority: event.target.value } } }))} className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-100">
            <option value="HIGH">HIGH</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LOW">LOW</option>
          </select>
        </label>
        <NumberField label="Cooldown after trade" tip="Minimum wait time before this strategy can re-enter." value={s.cooldownAfterTradeSec} min={0} max={86400} suffix="s" disabled={isBotActiveHere} onChange={(value) => updateMarket(marketId, (current: any) => ({ ...current, strategySettings: { ...current.strategySettings, [strategyKey]: { ...s, cooldownAfterTradeSec: value } } }))} />
        <NumberField label="Per trade %" tip="Soft capital per entry. Effective order size is min(per-trade %, global max position size, available capital)." value={s.capitalAllocation.perTradePercent} min={0.1} max={100} step={0.1} suffix="%" disabled={isBotActiveHere || !isAggressive} onChange={(value) => updateMarket(marketId, (current: any) => ({ ...current, strategySettings: { ...current.strategySettings, [strategyKey]: { ...s, capitalAllocation: { ...s.capitalAllocation, perTradePercent: value } } } }))} />
        <NumberField label="Max active %" tip="Upper exposure cap for this strategy while AGGRESSIVE mode is active." value={s.capitalAllocation.maxActivePercent} min={0.1} max={100} step={0.1} suffix="%" disabled={isBotActiveHere || !isAggressive} onChange={(value) => updateMarket(marketId, (current: any) => ({ ...current, strategySettings: { ...current.strategySettings, [strategyKey]: { ...s, capitalAllocation: { ...s.capitalAllocation, maxActivePercent: value } } } }))} />
      </div>
    </div>
  )
}

export default React.memo(PerStrategySettingsCard)
