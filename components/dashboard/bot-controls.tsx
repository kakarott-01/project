'use client'

// components/dashboard/bot-controls.tsx — v2
//
// Stop flow:
//   1. User clicks "Stop Bot"
//   2. If no open positions → stop immediately (no modal)
//   3. If open positions → modal with two choices:
//        a) "Close All Positions & Stop" (close_all)
//        b) "Stop After Positions Close" (graceful)
//
// Stopping state:
//   - close_all: shows spinning indicator + "Closing positions…"
//   - graceful:  shows open count + drain progress
//   - Both: "Force stop now" escape hatch
//   - Timeout warning: shown when stoppingAt exceeds stopTimeoutSec

import { useState, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Play, Square, AlertTriangle, Loader2, X,
  ShieldAlert, Clock, Zap, CheckCircle2,
} from 'lucide-react'

const MARKETS = [
  { id: 'indian',      label: '🇮🇳 Indian' },
  { id: 'crypto',      label: '₿ Crypto' },
  { id: 'commodities', label: '🛢 Commodities' },
  { id: 'global',      label: '🌐 Global' },
]

// ── Stop Mode Modal ───────────────────────────────────────────────────────────

interface StopModalProps {
  openTradeCount: number
  hasLiveMarkets: boolean
  onCloseAll:     () => void
  onGraceful:     () => void
  onClose:        () => void
}

function StopModeModal({
  openTradeCount,
  hasLiveMarkets,
  onCloseAll,
  onGraceful,
  onClose,
}: StopModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(3,7,18,0.88)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-100">How do you want to stop?</p>
            <p className="text-xs text-gray-500">
              {openTradeCount} open position{openTradeCount !== 1 ? 's' : ''} need attention
            </p>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Live trading warning */}
        {hasLiveMarkets && (
          <div className="mx-5 mt-4 flex items-start gap-2.5 bg-red-500/5 border border-red-500/20 rounded-xl px-3.5 py-3">
            <ShieldAlert className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-300/90 leading-relaxed">
              You have <strong className="text-red-300">live positions</strong> with bot-managed
              SL/TP. Stopping the bot means those positions will have no protection until
              you restart or close them manually.
            </p>
          </div>
        )}

        {/* Options */}
        <div className="px-5 pb-5 pt-4 space-y-3">

          {/* Option A: Close All & Stop */}
          <button
            onClick={onCloseAll}
            className="w-full text-left px-4 py-4 rounded-xl border border-red-500/25
                       bg-red-500/5 hover:bg-red-500/10 transition-colors group"
          >
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Zap className="w-4 h-4 text-red-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-semibold text-red-300">
                    Close All Positions & Stop
                  </p>
                  <span className="text-xs bg-red-500/15 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded-full">
                    Immediate
                  </span>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Market-close all {openTradeCount} open position{openTradeCount !== 1 ? 's' : ''} immediately.
                  The bot retries until all closes are confirmed, then stops.
                  {hasLiveMarkets && ' Uses real exchange orders.'}
                </p>
              </div>
            </div>
          </button>

          {/* Option B: Stop After Positions Close */}
          <button
            onClick={onGraceful}
            className="w-full text-left px-4 py-4 rounded-xl border border-brand-500/25
                       bg-brand-500/5 hover:bg-brand-500/10 transition-colors group"
          >
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Clock className="w-4 h-4 text-brand-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-semibold text-brand-500">
                    Stop After Positions Close
                  </p>
                  <span className="text-xs bg-brand-500/15 text-brand-500 border border-brand-500/20 px-1.5 py-0.5 rounded-full">
                    Graceful
                  </span>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  No new trades. The bot keeps monitoring SL/TP and strategy exits
                  for your {openTradeCount} position{openTradeCount !== 1 ? 's' : ''},
                  then stops automatically when they all close.
                </p>
              </div>
            </div>
          </button>

        </div>
      </div>
    </div>
  )
}

// ── Stopping state indicator ──────────────────────────────────────────────────

interface StoppingIndicatorProps {
  stopMode:        string
  openTradeCount:  number
  timeoutWarning:  boolean
  onForceStop:     () => void
  isBusy:          boolean
}

function StoppingIndicator({
  stopMode,
  openTradeCount,
  timeoutWarning,
  onForceStop,
  isBusy,
}: StoppingIndicatorProps) {
  const isCloseAll = stopMode === 'close_all'

  return (
    <div className="flex flex-col items-end gap-1.5">

      {/* Timeout warning */}
      {timeoutWarning && (
        <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-2.5 py-1.5 max-w-xs text-right">
          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
          Taking longer than expected. Consider force stopping.
        </div>
      )}

      {/* Main status */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium ${
        isCloseAll
          ? 'bg-red-500/10 border-red-500/20 text-red-400'
          : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
      }`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {isCloseAll
          ? 'Closing all positions…'
          : `Draining — ${openTradeCount} position${openTradeCount !== 1 ? 's' : ''} remaining`
        }
      </div>

      {/* Force stop escape hatch */}
      <button
        onClick={onForceStop}
        disabled={isBusy}
        className="text-xs text-gray-600 hover:text-red-400 transition-colors disabled:opacity-40 flex items-center gap-1"
      >
        <Square className="w-3 h-3" />
        Force stop (abandon positions)
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function BotControls({ botData }: { botData: any }) {
  const qc = useQueryClient()
  const [selectedMarkets,  setSelected]      = useState<string[]>(['crypto'])
  const [actionError,      setActionError]   = useState<string | null>(null)
  const [showStopModal,    setShowStopModal] = useState(false)
  const isFiringRef = useRef(false)

  const status:         string  = botData?.status         ?? 'stopped'
  const stopMode:       string  = botData?.stopMode       ?? ''
  const openTradeCount: number  = botData?.openTradeCount ?? 0
  const timeoutWarning: boolean = botData?.timeoutWarning ?? false
  const activeMarkets:  string[]= botData?.activeMarkets  ?? []

  const isRunning  = status === 'running'
  const isStopping = status === 'stopping'

  // Detect if any active market is in live mode
  // (conservative: assume live if we don't have market-level mode data)
  const hasLiveMarkets = true // TODO: pass from parent when market mode data available

  // ── Cleanup on mount ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/bot/cleanup', { method: 'POST' })
      .then(() => qc.invalidateQueries({ queryKey: ['bot-history'] }))
      .catch(() => null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start mutation ────────────────────────────────────────────────────────
  const startMut = useMutation({
    mutationFn: async () => {
      const res  = await fetch('/api/bot/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ markets: selectedMarkets }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to start bot')
      return data
    },
    onMutate: async () => {
      setActionError(null)
      await qc.cancelQueries({ queryKey: ['bot-status'] })
      const prev = qc.getQueryData(['bot-status'])
      qc.setQueryData(['bot-status'], (old: any) => ({
        ...old,
        status:         'running',
        activeMarkets:  selectedMarkets,
        startedAt:      new Date().toISOString(),
        openTradeCount: 0,
        stopMode:       null,
        timeoutWarning: false,
      }))
      return { prev }
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['bot-status'], ctx.prev)
      setActionError(err.message)
    },
    onSettled: () => {
      isFiringRef.current = false
      qc.invalidateQueries({ queryKey: ['bot-status'] })
      qc.invalidateQueries({ queryKey: ['bot-history'] })
    },
  })

  // ── Stop mutation ─────────────────────────────────────────────────────────
  const stopMut = useMutation({
    mutationFn: async (mode: 'close_all' | 'graceful' | 'force') => {
      const res  = await fetch('/api/bot/stop', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode: mode === 'force' ? 'close_all' : mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to stop bot')
      return data
    },
    onMutate: async (mode) => {
      setActionError(null)
      setShowStopModal(false)
      await qc.cancelQueries({ queryKey: ['bot-status'] })
      const prev = qc.getQueryData(['bot-status'])

      const newStatus = (mode === 'force')
        ? 'stopped'
        : (openTradeCount > 0 ? 'stopping' : 'stopped')

      qc.setQueryData(['bot-status'], (old: any) => ({
        ...old,
        status:   newStatus,
        stopMode: mode === 'force' ? null : mode,
      }))
      return { prev }
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['bot-status'], ctx.prev)
      setActionError(err.message)
    },
    onSettled: () => {
      isFiringRef.current = false
      qc.invalidateQueries({ queryKey: ['bot-status'] })
      qc.invalidateQueries({ queryKey: ['bot-history'] })
    },
  })

  // ── Handlers ──────────────────────────────────────────────────────────────
  function toggleMarket(id: string) {
    setSelected(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  }

  function handleStart() {
    if (isFiringRef.current || startMut.isPending || stopMut.isPending) return
    if (selectedMarkets.length === 0) return
    isFiringRef.current = true
    startMut.mutate()
  }

  function handleStopRequest() {
    if (isFiringRef.current || startMut.isPending || stopMut.isPending) return
    if (isStopping) return

    if (openTradeCount > 0) {
      setShowStopModal(true)
    } else {
      // No open positions — immediate stop, no modal needed
      isFiringRef.current = true
      stopMut.mutate('graceful')
    }
  }

  function handleCloseAll() {
    setShowStopModal(false)
    if (isFiringRef.current) return
    isFiringRef.current = true
    stopMut.mutate('close_all')
  }

  function handleGraceful() {
    setShowStopModal(false)
    if (isFiringRef.current) return
    isFiringRef.current = true
    stopMut.mutate('graceful')
  }

  function handleForceStop() {
    if (isFiringRef.current || stopMut.isPending) return
    isFiringRef.current = true
    stopMut.mutate('force')
  }

  const isBusy = startMut.isPending || stopMut.isPending

  return (
    <>
      {showStopModal && (
        <StopModeModal
          openTradeCount={openTradeCount}
          hasLiveMarkets={hasLiveMarkets}
          onCloseAll={handleCloseAll}
          onGraceful={handleGraceful}
          onClose={() => setShowStopModal(false)}
        />
      )}

      <div className="flex flex-col items-end gap-2">

        {/* Paper mode badge */}
        <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-900/20 border border-amber-900/30 rounded-lg px-2.5 py-1">
          <AlertTriangle className="w-3 h-3" />
          Paper Mode Active — no real trades
        </div>

        {/* Market selector */}
        {!isRunning && !isStopping && !isBusy && (
          <div className="flex flex-wrap gap-1.5 justify-end">
            {MARKETS.map(m => (
              <button
                key={m.id}
                onClick={() => toggleMarket(m.id)}
                className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                  selectedMarkets.includes(m.id)
                    ? 'bg-brand-500/15 border-brand-500/30 text-brand-500'
                    : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {/* Error */}
        {actionError && (
          <p className="text-xs text-red-400 max-w-xs text-right">{actionError}</p>
        )}

        {/* Action */}
        <div className="flex gap-2 items-end">
          {isStopping ? (
            <StoppingIndicator
              stopMode={stopMode}
              openTradeCount={openTradeCount}
              timeoutWarning={timeoutWarning}
              onForceStop={handleForceStop}
              isBusy={isBusy}
            />
          ) : isRunning ? (
            <button
              onClick={handleStopRequest}
              disabled={isBusy}
              className={`btn-danger flex items-center gap-1.5 transition-opacity ${
                isBusy ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              {stopMut.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Square className="w-3.5 h-3.5" />
              }
              {stopMut.isPending ? 'Stopping…' : 'Stop Bot'}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={isBusy || selectedMarkets.length === 0}
              className={`btn-primary flex items-center gap-1.5 transition-opacity ${
                isBusy || selectedMarkets.length === 0 ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            >
              {startMut.isPending
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Play className="w-3.5 h-3.5" />
              }
              {startMut.isPending ? 'Starting…' : 'Start Bot'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}