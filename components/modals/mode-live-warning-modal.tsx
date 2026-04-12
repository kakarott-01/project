'use client'

import React from 'react'
import { AlertTriangle, X } from 'lucide-react'

const MARKET_LABELS: Record<string, string> = {
  indian: '🇮🇳 Indian Markets', crypto: '₿ Crypto', commodities: '🛢 Commodities', global: '🌐 Global',
}

export default function ModeLiveWarningModal({ marketType, onConfirm, onClose }: {
  marketType: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(3,7,18,0.85)] backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm bg-gray-900 border border-red-900/40 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-red-900/30 bg-red-950/20">
          <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-red-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-red-300">Enable Live Mode</p>
            <p className="text-xs text-gray-500">Action requires confirmation</p>
          </div>
          <button onClick={onClose} className="ml-auto text-gray-600 hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-gray-300 leading-relaxed">
            You are about to switch to <span className="text-red-400 font-semibold">LIVE mode</span> for{' '}
            <span className="text-white font-medium">{MARKET_LABELS[marketType]}</span>.
            Real funds will be used for all trades on this market.
          </p>

          <div className="bg-red-950/30 border border-red-900/30 rounded-xl px-4 py-3 space-y-2">
            {[
              'Real money will be spent on trades',
              'Losses are real and not recoverable',
              'Ensure your API keys have correct permissions',
              'Start with conservative risk settings',
            ].map((warning, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 flex-shrink-0" />
                <span className="text-xs text-red-300/80">{warning}</span>
              </div>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              I Understand — Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
