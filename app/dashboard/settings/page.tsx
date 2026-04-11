'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BOT_STATUS_QUERY_KEY, isValidBotSnapshot } from '@/lib/bot-status-client'
import { useTradingGuard } from '@/lib/use-trading-guard'
import { AlertTriangle, Shield, Sparkles } from 'lucide-react'
import { ModeControls } from '@/components/dashboard/mode-controls'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { InfoTip } from '@/components/ui/tooltip'
import { useToastStore } from '@/lib/toast-store'
import { apiFetch } from '@/lib/api-client'

const defaults = {
  maxPositionPct: 2,
  stopLossPct: 1.5,
  takeProfitPct: 3,
  maxDailyLossPct: 5,
  maxOpenTrades: 3,
  maxTotalExposure: 0,
  maxDailyLoss: 0,
  maxOpenPositions: 0,
  cooldownSeconds: 300,
  trailingStop: false,
  paperBalance: 10000,
}

const presets = {
  conservative: {
    label: 'Conservative',
    values: { maxPositionPct: 1, stopLossPct: 1, takeProfitPct: 2, maxDailyLossPct: 3, maxOpenTrades: 2, cooldownSeconds: 900 },
  },
  balanced: {
    label: 'Balanced',
    values: { maxPositionPct: 2, stopLossPct: 1.5, takeProfitPct: 3, maxDailyLossPct: 5, maxOpenTrades: 3, cooldownSeconds: 300 },
  },
  aggressive: {
    label: 'Aggressive',
    values: { maxPositionPct: 4, stopLossPct: 2, takeProfitPct: 4.5, maxDailyLossPct: 8, maxOpenTrades: 5, cooldownSeconds: 120 },
  },
} as const

type RiskSettingsResponse = {
  maxPositionPct?: number
  stopLossPct?: number
  takeProfitPct?: number
  maxDailyLossPct?: number
  maxOpenTrades?: number
  maxTotalExposure?: number
  maxDailyLoss?: number
  maxOpenPositions?: number
  cooldownSeconds?: number
  trailingStop?: boolean
  paperBalance?: number
}

function formatCooldown(seconds: number) {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return `${seconds}s`
}

function RangeField({
  label,
  tip,
  description,
  field,
  value,
  min,
  max,
  step,
  suffix = '%',
  onChange,
}: {
  label: string
  tip: string
  description: string
  field: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <label htmlFor={field} className="text-sm font-medium text-gray-200">{label}</label>
            <InfoTip text={tip} />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">{description}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-brand-400">{value}{suffix}</p>
          <p className="text-[11px] text-gray-600">Range {min} to {max}{suffix}</p>
        </div>
      </div>
      <input
        id={field}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500"
      />
    </div>
  )
}

export default function SettingsPage() {
  const qc = useQueryClient()
  const pushToast = useToastStore((state) => state.push)
  const [form, setForm] = useState(defaults)
  const { isRunning } = useTradingGuard()

  const { data } = useQuery<RiskSettingsResponse | null>({
    queryKey: ['risk-settings'],
    queryFn: () => apiFetch<RiskSettingsResponse>('/api/risk-settings'),
  })

  useEffect(() => {
    if (data && Object.keys(data).length) {
      setForm({
        maxPositionPct: Number(data.maxPositionPct ?? defaults.maxPositionPct),
        stopLossPct: Number(data.stopLossPct ?? defaults.stopLossPct),
        takeProfitPct: Number(data.takeProfitPct ?? defaults.takeProfitPct),
        maxDailyLossPct: Number(data.maxDailyLossPct ?? defaults.maxDailyLossPct),
        maxOpenTrades: Number(data.maxOpenTrades ?? defaults.maxOpenTrades),
        maxTotalExposure: Number(data.maxTotalExposure ?? defaults.maxTotalExposure),
        maxDailyLoss: Number(data.maxDailyLoss ?? defaults.maxDailyLoss),
        maxOpenPositions: Number(data.maxOpenPositions ?? defaults.maxOpenPositions),
        cooldownSeconds: Number(data.cooldownSeconds ?? defaults.cooldownSeconds),
        trailingStop: data.trailingStop ?? defaults.trailingStop,
        paperBalance: Number(data.paperBalance ?? defaults.paperBalance),
      })
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: async () => {
      return apiFetch('/api/risk-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      await qc.cancelQueries({ queryKey: ['risk-settings'] })
      const previousBot = qc.getQueryData(BOT_STATUS_QUERY_KEY)
      const previous = qc.getQueryData(['risk-settings'])
      return { previous, previousBot }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['risk-settings'] })
      pushToast({
        tone: 'success',
        title: 'Global risk controls saved',
        description: 'Hard limits are active for every market and strategy.',
      })
    },
    onError: (error: Error, _vars, context: any) => {
      if (context?.previous) qc.setQueryData(['risk-settings'], context.previous)
      if (context?.previousBot && isValidBotSnapshot(context.previousBot)) qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previousBot)
      pushToast({
        tone: 'error',
        title: 'Unable to save risk controls',
        description: error.message,
      })
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY })
    },
  })

  const hardLimitSummary = useMemo(() => ([
    { label: 'Max single position', value: `${form.maxPositionPct}%` },
    { label: 'Daily pause threshold', value: `${form.maxDailyLossPct}%` },
    { label: 'Max simultaneous trades', value: String(form.maxOpenTrades) },
    { label: 'Paper capital base', value: `₹${form.paperBalance.toLocaleString('en-IN')}` },
  ]), [form])

  function setField<Key extends keyof typeof form>(key: Key, value: (typeof form)[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function applyPreset(preset: keyof typeof presets) {
    setForm((current) => ({ ...current, ...presets[preset].values }))
    pushToast({
      tone: 'success',
      title: `${presets[preset].label} preset applied`,
      description: 'Review the limits and save when you are ready.',
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="rounded-3xl border border-gray-800 bg-gradient-to-br from-gray-900 via-slate-950 to-gray-950 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-100">Risk & Capital Controls</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-gray-400">
              Global controls are hard limits for the whole bot. Strategy allocation is configured separately per market and can never exceed these caps.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {hardLimitSummary.map((item) => (
              <div key={item.label} className="rounded-2xl border border-gray-800 bg-gray-950/60 px-3 py-3">
                <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">{item.label}</p>
                <p className="mt-2 text-sm font-semibold text-gray-100">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ModeControls />

      <div className="card space-y-5">
        <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
          <Shield className="h-4 w-4 text-brand-500" />
          <h2 className="text-sm font-medium text-gray-200">Global Risk Controls (Hard Limits)</h2>
        </div>

        <InlineAlert tone="warning" title="Hard limits always win.">
          Effective position size is capped by the smallest of strategy per-trade capital, this global max position size, and available capital.
        </InlineAlert>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-400" />
            <p className="text-sm font-medium text-gray-200">Presets</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(presets) as Array<keyof typeof presets>).map((preset) => (
              <Button key={preset} variant="secondary" onClick={() => applyPreset(preset)}>
                {presets[preset].label}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <RangeField
            field="maxPositionPct"
            label="Max Position Size"
            tip="Hard cap applied before any order is placed, even if a strategy requests more."
            description="Maximum percent of account capital allowed in one new position."
            min={0.5}
            max={20}
            step={0.5}
            value={form.maxPositionPct}
            onChange={(value) => setField('maxPositionPct', value)}
          />
          <RangeField
            field="maxDailyLossPct"
            label="Max Daily Loss"
            tip="Once reached, the engine stops opening new trades for the day."
            description="Total daily loss guardrail across all active markets."
            min={1}
            max={20}
            step={1}
            value={form.maxDailyLossPct}
            onChange={(value) => setField('maxDailyLossPct', value)}
          />
          <RangeField
            field="stopLossPct"
            label="Stop Loss"
            tip="Used by the engine to place or simulate automated exits."
            description="Auto-exit threshold when price moves against the position."
            min={0.5}
            max={10}
            step={0.5}
            value={form.stopLossPct}
            onChange={(value) => setField('stopLossPct', value)}
          />
          <RangeField
            field="takeProfitPct"
            label="Take Profit"
            tip="Locks gains automatically when profit targets are reached."
            description="Auto-exit threshold when price moves in your favour."
            min={0.5}
            max={20}
            step={0.5}
            value={form.takeProfitPct}
            onChange={(value) => setField('takeProfitPct', value)}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
            <div className="flex items-center gap-2">
              <label htmlFor="maxOpenTrades" className="text-sm font-medium text-gray-200">Max Simultaneous Trades</label>
              <InfoTip text="Hard cap across all markets. New entries are blocked once this count is reached." />
            </div>
            <p className="mt-1 text-xs text-gray-500">Range 1 to 10 trades.</p>
            <input
              id="maxOpenTrades"
              type="range"
              min={1}
              max={10}
              step={1}
              value={form.maxOpenTrades}
              onChange={(event) => setField('maxOpenTrades', Number(event.target.value))}
              className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500"
            />
            <p className="mt-3 text-lg font-semibold text-brand-400">{form.maxOpenTrades}</p>
          </div>

          <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
            <div className="flex items-center gap-2">
              <label htmlFor="cooldownSeconds" className="text-sm font-medium text-gray-200">Cooldown After Loss</label>
              <InfoTip text="Pause duration after a loss before that market can enter again." />
            </div>
            <p className="mt-1 text-xs text-gray-500">Range 0 to 3600 seconds.</p>
            <input
              id="cooldownSeconds"
              type="range"
              min={0}
              max={3600}
              step={60}
              value={form.cooldownSeconds}
              onChange={(event) => setField('cooldownSeconds', Number(event.target.value))}
              className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500"
            />
            <p className="mt-3 text-lg font-semibold text-brand-400">{formatCooldown(form.cooldownSeconds)}</p>
          </div>

          <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
            <div className="flex items-center gap-2">
              <label htmlFor="paperBalance" className="text-sm font-medium text-gray-200">Paper Trading Capital</label>
              <InfoTip text="Base capital used for paper-mode sizing and strategy allocation previews." />
            </div>
            <p className="mt-1 text-xs text-gray-500">Range ₹1,000 to ₹10,00,000.</p>
            <input
              id="paperBalance"
              type="range"
              min={1000}
              max={1000000}
              step={1000}
              value={form.paperBalance}
              onChange={(event) => setField('paperBalance', Number(event.target.value))}
              className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500"
            />
            <p className="mt-3 text-lg font-semibold text-brand-400">₹{form.paperBalance.toLocaleString('en-IN')}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-800 bg-gray-950/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-gray-200">Trailing Stop Loss</p>
              <p className="mt-1 text-xs text-gray-500">Keep protective stops moving as price advances.</p>
            </div>
            <button
              type="button"
              onClick={() => setField('trailingStop', !form.trailingStop)}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${form.trailingStop ? 'bg-brand-500' : 'bg-gray-700'}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${form.trailingStop ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        <InlineAlert tone="info" title="Strategy Allocation (Soft Limits)">
          Strategy-level per-trade capital, max active capital, and priority controls are configured in Strategy Engine per market. Those settings guide allocation, but they can never break the hard limits on this page.
        </InlineAlert>

        <div className="sticky-actions">
          <div className="text-xs text-gray-500">
            Save keeps every market under the same global capital and loss guardrails.
          </div>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || isRunning} title={isRunning ? 'Stop the bot before making changes' : undefined}>
            {saveMutation.isPending ? 'Saving…' : 'Save Global Controls'}
          </Button>
        </div>
      </div>

      <InlineAlert tone="warning" title="Live capital reminder">
        {`You're planning to upgrade the backend before using heavier live capital, which is the right sequencing. Keep paper mode as the default baseline until session stability and stop behavior feel boringly predictable.`}
      </InlineAlert>
    </div>
  )
}
