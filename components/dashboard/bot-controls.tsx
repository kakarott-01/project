'use client'

import { useState, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Square, AlertTriangle, Loader2 } from 'lucide-react'

const MARKETS = [
  { id: 'indian',      label: '🇮🇳 Indian' },
  { id: 'crypto',      label: '₿ Crypto' },
  { id: 'commodities', label: '🛢 Commodities' },
  { id: 'global',      label: '🌐 Global' },
]

export function BotControls({ botData }: { botData: any }) {
  const qc = useQueryClient()
  const [selectedMarkets, setSelected] = useState<string[]>(['crypto'])
  const [actionError, setActionError]  = useState<string | null>(null)

  // Single-flight ref: blocks any second click until the mutation settles
  const isFiringRef = useRef(false)

  const isRunning = botData?.status === 'running'

  // ── Run cleanup once on mount to fix stale sessions from crashes ───────────
  useEffect(() => {
    fetch('/api/bot/cleanup', { method: 'POST' })
      .then(() => qc.invalidateQueries({ queryKey: ['bot-history'] }))
      .catch(() => null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Start ──────────────────────────────────────────────────────────────────
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
      // Optimistic update — UI feels instant
      qc.setQueryData(['bot-status'], (old: any) => ({
        ...old,
        status:        'running',
        activeMarkets: selectedMarkets,
        startedAt:     new Date().toISOString(),
      }))
      return { prev }
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['bot-status'], ctx.prev)
      setActionError(err.message)
    },
    onSettled: () => {
      isFiringRef.current = false
      // Refresh both status and history
      qc.invalidateQueries({ queryKey: ['bot-status'] })
      qc.invalidateQueries({ queryKey: ['bot-history'] })
    },
  })

  // ── Stop ───────────────────────────────────────────────────────────────────
  const stopMut = useMutation({
    mutationFn: async () => {
      const res  = await fetch('/api/bot/stop', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to stop bot')
      return data
    },
    onMutate: async () => {
      setActionError(null)
      await qc.cancelQueries({ queryKey: ['bot-status'] })
      const prev = qc.getQueryData(['bot-status'])
      // Optimistic update
      qc.setQueryData(['bot-status'], (old: any) => ({
        ...old,
        status:        'stopped',
        activeMarkets: [],
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

  function toggleMarket(id: string) {
    setSelected(prev =>
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    )
  }

  function handleStart() {
    if (isFiringRef.current || startMut.isPending || stopMut.isPending) return
    if (selectedMarkets.length === 0) return
    isFiringRef.current = true
    startMut.mutate()
  }

  function handleStop() {
    if (isFiringRef.current || startMut.isPending || stopMut.isPending) return
    isFiringRef.current = true
    stopMut.mutate()
  }

  const isBusy = startMut.isPending || stopMut.isPending

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Paper mode badge */}
      <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-900/20 border border-amber-900/30 rounded-lg px-2.5 py-1">
        <AlertTriangle className="w-3 h-3" />
        Paper Mode Active — no real trades
      </div>

      {/* Market selector (only shown when stopped and not mid-action) */}
      {!isRunning && !isBusy && (
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

      {/* Error message */}
      {actionError && (
        <p className="text-xs text-red-400 max-w-xs text-right">{actionError}</p>
      )}

      {/* Action button */}
      <div className="flex gap-2">
        {isRunning ? (
          <button
            onClick={handleStop}
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
  )
}