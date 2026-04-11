'use client'

import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBotStatusQuery } from '@/lib/use-bot-status-query'
import { QUERY_KEYS } from '@/lib/query-keys'
import {
  AlertTriangle, Loader2, Power, ShieldAlert, Square,
  X, Zap, Play, Swords, Shield,
} from 'lucide-react'
import { BotControlsModals, type BotControlsModalsRef } from '@/components/dashboard/bot-controls-modals'
import { useActionLocks } from '@/components/dashboard/bot-controls/useActionLocks'
import MarketButton from '@/components/dashboard/bot-controls/MarketButton'
import { POLL_INTERVALS } from '@/lib/polling-config'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/ui/inline-alert'
import { StatusBadge } from '@/components/ui/status-badge'
import { isValidBotSnapshot, type BotStatusSnapshot, BOT_STATUS_QUERY_KEY } from '@/lib/bot-status-client'
import { useToastStore } from '@/lib/toast-store'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'

const MARKETS = [
  { id: 'crypto',      label: 'Crypto',       shortLabel: 'Crypto' },
  { id: 'indian',      label: 'Indian',        shortLabel: 'Indian' },
  { id: 'global',      label: 'Forex',         shortLabel: 'Forex' },
  { id: 'commodities', label: 'Commodities',   shortLabel: 'Commodities' },
] as const

// Modal UI moved to BotControlsModals to avoid re-rendering the entire controls

type MarketId = typeof MARKETS[number]['id']

type SessionItem = {
  market:     string
  status:     'running' | 'stopped' | 'error'
  mode?:      'paper' | 'live' | null
  openTrades?: number
}

type ModeDataResponse = {
  markets?: Array<{ marketType: MarketId; mode: 'paper' | 'live' }>
}

type StrategyConfigDataResponse = {
  markets?: Array<{
    marketType: MarketId
    strategyKeys?: string[]
    conflictWarnings?: Array<{ message: string }>
  }>
}

type StopMarketResponse = {
  success?: boolean
  stoppedMarket: MarketId
  mode: 'graceful' | 'close_all'
  remainingMarkets?: MarketId[]
  openPositionsClosed?: number
  // snapshot fields (partial)
  status?: string
  stopMode?: string | null
  activeMarkets?: MarketId[]
  openTradeCount?: number
  perMarketOpenTrades?: Record<string, number>
  sessions?: any[]
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json() } catch { return {} }
}

// StopAllModal moved to components/modals and lazy-loaded

// StartMarketModal moved to components/modals and lazy-loaded

// MarketStopModal moved to components/modals and lazy-loaded

// ── Main component ────────────────────────────────────────────────────────────
export function BotControls() {
  const qc        = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  const modalsRef = useRef<BotControlsModalsRef | null>(null)

  // FIX: Use ref for firing state (no re-render on toggle)
  const isFiringRef = useRef(false)
  // Action lock helpers (extracted)
  const { lockAction, unlockAction, isLocked } = useActionLocks()

  const { data, dataUpdatedAt } = useBotStatusQuery()

  const { data: modeData } = useQuery({
    queryKey: QUERY_KEYS.MARKET_MODES,
    queryFn:  () => apiFetch<ModeDataResponse>('/api/mode'),
    staleTime: POLL_INTERVALS.MARKET_MODES,
  })

  const { data: strategyConfigData } = useQuery({
    queryKey: QUERY_KEYS.STRATEGY_CONFIGS,
    queryFn:  () => apiFetch<StrategyConfigDataResponse>('/api/strategy-config'),
    select: (d) => d,
    staleTime: POLL_INTERVALS.STRATEGY,
  })

  const status:         string    = data?.status        ?? 'stopped'
  const openTradeCount: number    = data?.openTradeCount ?? 0
  // FIX: Stable empty arrays — don't use ?? [] inline
  const sessions:       SessionItem[] = data?.sessions  ?? []
  const activeMarkets:  string[] = data?.activeMarkets ?? []
  const botErrorMessage: string | null = data?.errorMessage ?? null
  const isStopping = status === 'stopping'

  const perMarketOpenTrades: Record<string, number> = data?.perMarketOpenTrades ?? {}

  const hasLiveMarkets = (modeData?.markets ?? []).some(
    (m: any) => m.mode === 'live' && activeMarkets.includes(m.marketType),
  )

  // FIX: Stable memo — sessions reference only changes when actual data changes
  const sessionByMarket = useMemo(
    () => new Map(sessions.map((s) => [s.market, s])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.sessions],  // Depend on sessions from same source, not derived array
  )

  // FIX: Stable memo for configByMarket
  const strategyMarkets = strategyConfigData?.markets
  const configByMarket = useMemo(
    () => new Map((strategyMarkets ?? []).map((m: any) => [m.marketType, m])),
    [strategyMarkets],
  )

  // ── Mutations ───────────────────────────────────────────────────────────────

  const syncMutation = useMutation({
    mutationKey: ['bot-start'],
    mutationFn: async ({ markets }: { markets: string[] }) => {
      return apiFetch('/api/bot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markets }) })
    },
    onMutate: async (vars: { markets: string[] }) => {
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      const previous = qc.getQueryData<BotStatusSnapshot>(BOT_STATUS_QUERY_KEY)
      qc.setQueryData<BotStatusSnapshot | undefined>(BOT_STATUS_QUERY_KEY, (old) => {
        const base = (old && isValidBotSnapshot(old)) ? old : previous ?? {
          status: 'running', stopMode: null, activeMarkets: [], started_at: null, stopped_at: null,
          stopping_at: null, last_heartbeat: null, errorMessage: null, openTradeCount: 0,
          perMarketOpenTrades: {}, timeoutWarning: false, sessions: [],
        }
        const nextActive = Array.from(new Set([...(base.activeMarkets ?? []), ...vars.markets]))
        return { ...base, status: 'running', activeMarkets: nextActive }
      })
      return { previous }
    },
    onError: (err: Error, vars, context: any) => {
      pushToast({ tone: 'error', title: 'Session update failed', description: err.message })
      if (context?.previous && isValidBotSnapshot(context.previous)) qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previous)
    },
    onSuccess: (_data, vars) => {
      pushToast({
        tone: 'success',
        title: 'Market sessions updated',
        description: vars.markets.length ? `Running on ${vars.markets.join(', ')}.` : 'All sessions stopped.',
      })
    },
    onSettled: async (_data, _err, vars: { markets: string[] } | undefined) => {
      isFiringRef.current = false
      if (vars?.markets) {
        vars.markets.forEach((m) => unlockAction(`start-market:${m}`))
      }
      await qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.BOT_HISTORY() })
    },
  })

  const stopAllMutation = useMutation({
    mutationFn: async (mode: 'close_all' | 'graceful') => {
      return apiFetch('/api/bot/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
    },
    onMutate: async (mode: 'close_all' | 'graceful') => {
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      const previous = qc.getQueryData<BotStatusSnapshot>(BOT_STATUS_QUERY_KEY)
      qc.setQueryData<BotStatusSnapshot | undefined>(BOT_STATUS_QUERY_KEY, (old) => {
        const base = (old && isValidBotSnapshot(old)) ? old : previous ?? {
          status: 'stopping', stopMode: mode, activeMarkets: [], started_at: null, stopped_at: null,
          stopping_at: null, last_heartbeat: null, errorMessage: null, openTradeCount: 0,
          perMarketOpenTrades: {}, timeoutWarning: false, sessions: [],
        }
        return { ...base, status: 'stopping', stopMode: mode }
      })
      return { previous }
    },
    onError: (err: Error, vars, context: any) => {
      pushToast({ tone: 'error', title: 'Stop request failed', description: err.message })
      if (context?.previous && isValidBotSnapshot(context.previous)) qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previous)
    },
    onSuccess: (_data, mode) => {
      pushToast({
        tone: mode === 'close_all' ? 'warning' : 'success',
        title: mode === 'close_all' ? 'Emergency stop requested' : 'Graceful drain started',
        description: mode === 'close_all'
          ? 'The engine is closing all open positions and stopping.'
          : 'No new trades will open while active positions are drained.',
      })
    },
    onSettled: async (_data, _err, vars: 'close_all' | 'graceful' | undefined) => {
      isFiringRef.current = false
      modalsRef.current?.closeAll?.()
      if (vars) unlockAction(`stop-all:${vars}`)
      await qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.BOT_HISTORY() })
    },
  })

  const stopMarketMutation = useMutation({
    mutationFn: async ({ marketType, mode }: { marketType: MarketId; mode: 'graceful' | 'close_all' }) => {
      return apiFetch<StopMarketResponse>('/api/bot/stop-market', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketType, mode }) })
    },
    onMutate: async (vars: { marketType: MarketId; mode: 'graceful' | 'close_all' }) => {
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      const previous = qc.getQueryData<BotStatusSnapshot>(BOT_STATUS_QUERY_KEY)
      qc.setQueryData<BotStatusSnapshot | undefined>(BOT_STATUS_QUERY_KEY, (old) => {
        const base = (old && isValidBotSnapshot(old)) ? old : previous ?? {
          status: 'running', stopMode: null, activeMarkets: [], started_at: null, stopped_at: null,
          stopping_at: null, last_heartbeat: null, errorMessage: null, openTradeCount: 0,
          perMarketOpenTrades: {}, timeoutWarning: false, sessions: [],
        }
        const nextActive = (base.activeMarkets ?? []).filter((m) => m !== vars.marketType)
        return { ...base, status: nextActive.length > 0 ? base.status : 'stopping', activeMarkets: nextActive }
      })
      return { previous }
    },
    onError: (err: Error, vars, context: any) => {
      pushToast({ tone: 'error', title: `Failed to stop ${vars.marketType}`, description: err.message })
      if (context?.previous && isValidBotSnapshot(context.previous)) qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previous)
    },
    onSuccess: (data: StopMarketResponse) => {
      const label = MARKETS.find((m) => m.id === data.stoppedMarket)?.label ?? data.stoppedMarket
      pushToast({
        tone: data.mode === 'close_all' ? 'warning' : 'success',
        title: data.mode === 'close_all' ? `${label} — closing positions` : `${label} drained`,
        description: data.mode === 'close_all'
          ? `Closing ${data.openPositionsClosed} position${data.openPositionsClosed !== 1 ? 's' : ''}.`
          : 'Market stopped, existing positions remain open.',
      })
    },
    onSettled: async (_data, _err, vars: { marketType: MarketId } | undefined) => {
      if (vars) unlockAction(`stop-market:${vars.marketType}`)
      modalsRef.current?.closeStopModal?.()
      isFiringRef.current = false
      await qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.BOT_HISTORY() })
    },
  })

  const isStarting = syncMutation.isPending && status !== 'running'

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function marketWarnings(marketId: MarketId) {
    const cfg = configByMarket.get(marketId) as any
    return (cfg?.conflictWarnings ?? []).map((w: any) => w.message)
  }

  function isMarketLive(marketId: MarketId): boolean {
    const market = (modeData?.markets ?? []).find((m: any) => m.marketType === marketId)
    return market?.mode === 'live'
  }

  function marketStrategyKeys(marketId: MarketId): string[] {
    const cfg = configByMarket.get(marketId) as any
    return cfg?.strategyKeys ?? []
  }

  function marketOpenTrades(marketId: MarketId): number {
    return perMarketOpenTrades[marketId] ?? 0
  }

  const marketWarningsMap = useMemo(() => {
    return new Map(MARKETS.map(m => [m.id, marketWarnings(m.id)]))
  }, [configByMarket])

  // ── Click handler ────────────────────────────────────────────────────────────

  function handleMarketClick(marketId: MarketId) {
    if (isFiringRef.current || syncMutation.isPending || stopAllMutation.isPending || stopMarketMutation.isPending || isStopping) return

    const isActive = activeMarkets.includes(marketId)

    if (isActive) {
      modalsRef.current?.openStopModal?.(marketId)
    } else {
      modalsRef.current?.openStartModal?.(marketId)
    }
  }

  function confirmStart(marketId: MarketId) {
    const actionId = `start-market:${marketId}`
    if (isLocked(actionId)) return
    lockAction(actionId)
    isFiringRef.current = true
    const nextMarkets = [...activeMarkets, marketId]
    syncMutation.mutate({ markets: nextMarkets })
  }

  function confirmMarketStop(marketId: MarketId, mode: 'graceful' | 'close_all') {
    const actionId = `stop-market:${marketId}`
    if (isLocked(actionId)) return
    lockAction(actionId)
    isFiringRef.current = true
    stopMarketMutation.mutate({ marketType: marketId, mode })
  }

  function handleStopAll(mode: 'graceful' | 'close_all') {
    const actionId = `stop-all:${mode}`
    if (isLocked(actionId)) return
    lockAction(actionId)
    isFiringRef.current = true
    stopAllMutation.mutate(mode)
  }

  const ALL_MARKETS = MARKETS

  return (
    <>
      <BotControlsModals
        ref={modalsRef}
        confirmStart={confirmStart}
        confirmMarketStop={confirmMarketStop}
        handleStopAll={handleStopAll}
      />

      <div className="surface-panel w-full max-w-md p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">Bot Status</p>
            <div className="mt-2 flex items-center gap-2">
              <StatusBadge tone={
                isStarting            ? 'info'    :
                status === 'running'  ? 'success' :
                status === 'stopping' ? 'warning' :
                status === 'error'    ? 'danger'  : 'neutral'
              }>
                {isStarting ? 'STARTING' : status.toUpperCase()}
              </StatusBadge>
              <span className="text-xs text-gray-500">
                {activeMarkets.length} active market{activeMarkets.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="text-xs text-gray-400 mt-1">
              {dataUpdatedAt ? `Last updated: ${Math.max(0, Math.floor((Date.now() - dataUpdatedAt) / 1000))}s ago` : 'Last updated: —'}
            </div>
          </div>
          <StatusBadge tone={hasLiveMarkets ? 'danger' : 'info'}>
            {hasLiveMarkets ? 'Live capital at risk' : 'Paper mode only'}
          </StatusBadge>
        </div>

        <div className="mt-4 space-y-2">
          {ALL_MARKETS.map((market) => {
            const session    = sessionByMarket.get(market.id)
            const isActive   = activeMarkets.includes(market.id)
            const config     = configByMarket.get(market.id) as any
            const hasStrategies = (config?.strategyKeys ?? []).length > 0
            const warnings   = marketWarningsMap.get(market.id) ?? []
            const isLive     = isMarketLive(market.id)
            const openTrades = marketOpenTrades(market.id)

            const isThisMarketMutating = stopMarketMutation.isPending && stopMarketMutation.variables?.marketType === market.id
            const disabled = isStopping || !hasStrategies || stopAllMutation.isPending || isThisMarketMutating

            return (
              <MarketButton
                key={market.id}
                disabled={disabled}
                onClick={() => handleMarketClick(market.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition group',
                  isActive
                    ? isLive
                      ? 'border-red-500/30 bg-red-950/20 hover:bg-red-950/30'
                      : 'border-brand-500/30 bg-brand-500/10 hover:bg-brand-500/15'
                    : 'border-gray-800 bg-gray-950/60 hover:border-gray-700',
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-100">{market.shortLabel}</span>

                    <StatusBadge tone={
                      isActive              ? (isLive ? 'danger' : 'success') :
                      session?.status === 'error' ? 'danger' : 'neutral'
                    }>
                      {isActive ? 'Running' : 'Stopped'}
                    </StatusBadge>

                    {isActive && isLive && (
                      <StatusBadge tone="danger">Live</StatusBadge>
                    )}

                    {isActive && openTrades > 0 && (
                      <span className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/30 px-1.5 py-0.5 rounded-full">
                        {openTrades} open
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {hasStrategies
                      ? `${config?.strategyKeys?.length ?? 0} strategy slot${(config?.strategyKeys?.length ?? 0) === 1 ? '' : 's'}`
                      : 'No strategies selected'}
                    {warnings.length > 0 ? ` · ${warnings.length} conflict${warnings.length === 1 ? '' : 's'}` : ''}
                  </p>
                </div>

                <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                  {isThisMarketMutating ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                  ) : null}

                  {!disabled && !isThisMarketMutating && (
                    <span className={cn(
                      'text-[10px] font-medium px-2 py-0.5 rounded-lg border opacity-0 group-hover:opacity-100 transition-opacity',
                      isActive
                        ? 'text-amber-400 bg-amber-900/20 border-amber-800/30'
                        : 'text-brand-400 bg-brand-500/10 border-brand-500/20'
                    )}>
                      {isActive ? 'Stop' : 'Start'}
                    </span>
                  )}

                  <div className={cn(
                    'h-3 w-3 rounded-full transition-all',
                    isActive
                      ? isLive
                        ? 'bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.6)]'
                        : 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]'
                      : 'bg-gray-600',
                    isActive && 'animate-pulse'
                  )} />
                </div>
              </MarketButton>
            )
          })}
        </div>

        {botErrorMessage && (
          <InlineAlert tone="danger" title="Bot error" className="mt-4">
            {botErrorMessage}
          </InlineAlert>
        )}

        {!activeMarkets.length && !isStopping && (
          <InlineAlert tone="info" title="No markets running" className="mt-4">
            Click any market to start it. Each market runs independently — you can start and stop them one at a time.
          </InlineAlert>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            {openTradeCount > 0
              ? `${openTradeCount} open trade${openTradeCount === 1 ? '' : 's'} across active sessions`
              : 'No open trades'}
          </div>
          <Button
            variant="danger"
            className="min-w-[8.5rem]"
            disabled={stopAllMutation.isPending || syncMutation.isPending || (!activeMarkets.length && !openTradeCount)}
            onClick={() => modalsRef.current?.openStopAll?.()}
          >
            {stopAllMutation.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Stopping…</>
            ) : (
              <><Square className="h-4 w-4" />Stop All</>
            )}
          </Button>
        </div>

        {isStopping && (
          <div className="mt-3 flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            <Power className="h-3.5 w-3.5" />
            Graceful stop is in progress. Market toggles are temporarily locked.
          </div>
        )}

        {(strategyConfigData?.markets ?? []).some((m: any) => m.executionMode === 'AGGRESSIVE') && (
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-red-500/15 bg-red-500/10 px-3 py-2 text-xs text-red-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            At least one market is configured for AGGRESSIVE mode. Capital is managed per strategy and lower-priority entries can be blocked when exposure tightens.
          </div>
        )}
      </div>
    </>
  )
}