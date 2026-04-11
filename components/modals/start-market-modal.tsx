'use client'

import React from 'react'
import { Play, X } from 'lucide-react'
import { InlineAlert } from '@/components/ui/inline-alert'
import { cn } from '@/lib/utils'

export default function StartMarketModal({ market, isLive, strategyKeys, warnings, onConfirm, onClose }: {
  market: string
  isLive: boolean
  strategyKeys: string[]
  warnings: string[]
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(3,7,18,0.88)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-3xl border border-gray-800 bg-gray-950 shadow-2xl overflow-hidden">
        <div className={cn(
          'flex items-center gap-3 px-5 py-4 border-b',
          isLive
            ? 'border-red-900/40 bg-red-950/20'
            : 'border-brand-500/20 bg-brand-500/5'
        )}>
          <div className={cn(
            'w-9 h-9 rounded-2xl flex items-center justify-center flex-shrink-0',
            isLive ? 'bg-red-500/15' : 'bg-brand-500/15'
          )}>
            <Play className={cn('h-4 w-4', isLive ? 'text-red-400' : 'text-brand-400')} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-100">Start {market}</p>
            <p className={cn('text-xs mt-0.5', isLive ? 'text-red-400' : 'text-gray-500')}>
              {isLive ? '🔴 LIVE mode — real funds at risk' : '🟡 Paper mode — simulated trading'}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {isLive && (
            <InlineAlert tone="danger" title="Real capital will be used">
              All signals for {market} will place real orders on the exchange. Losses are unrecoverable.
            </InlineAlert>
          )}

          {warnings.length > 0 && (
            <InlineAlert tone="warning" title="Potential strategy conflicts detected">
              <div className="space-y-1">
                {warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            </InlineAlert>
          )}

          {strategyKeys.length > 0 && (
            <div className="rounded-2xl border border-gray-800 bg-gray-900/60 px-4 py-3 space-y-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Strategies to activate</p>
              {strategyKeys.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <span className={cn(
                    'w-1.5 h-1.5 rounded-full flex-shrink-0',
                    isLive ? 'bg-red-400' : 'bg-brand-500'
                  )} />
                  <span className="text-xs font-mono text-gray-300">{key}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className={cn(
                'flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors',
                isLive
                  ? 'bg-red-600 hover:bg-red-500'
                  : 'bg-brand-500 hover:bg-brand-600'
              )}
            >
              {isLive ? 'Start Live Trading' : 'Start Market'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
