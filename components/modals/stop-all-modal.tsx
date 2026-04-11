'use client'

import React from 'react'
import { Zap, X, ShieldAlert } from 'lucide-react'
import { InlineAlert } from '@/components/ui/inline-alert'

export default function StopAllModal({ openTradeCount, hasLiveMarkets, onCloseAll, onGraceful, onClose }: {
  openTradeCount: number
  hasLiveMarkets: boolean
  onCloseAll: () => void
  onGraceful: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(3,7,18,0.88)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg rounded-3xl border border-gray-800 bg-gray-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-gray-100">Stop all active sessions</p>
            <p className="mt-1 text-xs text-gray-500">
              {openTradeCount} open trade{openTradeCount === 1 ? '' : 's'} still need protection
            </p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-gray-500 transition hover:bg-gray-800 hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {hasLiveMarkets && (
            <InlineAlert tone="danger" title="Live positions are exposed if monitoring stops.">
              Stopping the bot removes automated SL/TP supervision for live positions until you restart or close them manually.
            </InlineAlert>
          )}

          <button type="button" onClick={onCloseAll}
            className="w-full rounded-2xl border border-red-500/25 bg-red-500/10 px-4 py-4 text-left transition hover:bg-red-500/15">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-red-500/15 p-2">
                <Zap className="h-4 w-4 text-red-300" />
              </div>
              <div>
                <p className="text-sm font-semibold text-red-200">Close all positions and stop</p>
                <p className="mt-1 text-xs text-red-100/80">Use this when you need a hard stop right now.</p>
              </div>
            </div>
          </button>

          <button type="button" onClick={onGraceful}
            className="w-full rounded-2xl border border-brand-500/25 bg-brand-500/10 px-4 py-4 text-left transition hover:bg-brand-500/15">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-brand-500/15 p-2">
                <ShieldAlert className="h-4 w-4 text-brand-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-brand-300">Drain gracefully</p>
                <p className="mt-1 text-xs text-gray-300/80">No new entries. Existing trades remain monitored until they exit.</p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
