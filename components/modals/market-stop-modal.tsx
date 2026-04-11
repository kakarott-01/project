'use client'

import React from 'react'
import { Square, X, Shield } from 'lucide-react'
import { InlineAlert } from '@/components/ui/inline-alert'

export default function MarketStopModal({ market, isLive, openTradeCount, onDrain, onClose }: {
  market: string
  isLive: boolean
  openTradeCount: number
  onDrain: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(3,7,18,0.88)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-3xl border border-gray-800 bg-gray-950 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <div className="w-9 h-9 rounded-2xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <Square className="h-4 w-4 text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-100">Stop {market}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {openTradeCount === -1 ? (
                'Fetching latest positions...'
              ) : openTradeCount > 0 ? (
                `${openTradeCount} open position${openTradeCount !== 1 ? 's' : ''} · other markets continue running`
              ) : (
                'No open positions · other markets continue running'
              )}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-3">
          {isLive && openTradeCount > 0 && (
            <InlineAlert tone="danger" title="Live positions need manual supervision if unmonitored.">
              After stopping, open positions will not have automated SL/TP until you restart or close them.
            </InlineAlert>
          )}

          <button type="button" onClick={onDrain}
            className="w-full rounded-2xl border border-brand-500/25 bg-brand-500/10 px-4 py-4 text-left transition hover:bg-brand-500/15 cursor-pointer">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-brand-500/15 p-2">
                <Shield className="h-4 w-4 text-brand-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-brand-300">Drain &amp; stop</p>
                <p className="mt-1 text-xs text-gray-300/80">Stop new entries for {market}. Existing positions close on their own exit signals.</p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
