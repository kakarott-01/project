'use client'

import React from 'react'
import { X } from 'lucide-react'

const MARKET_LABELS: Record<string, string> = {
  indian: '🇮🇳 Indian Markets', crypto: '₿ Crypto', commodities: '🛢 Commodities', global: '🌐 Global',
}

export default function ModePaperConfirmModal({ marketType, onConfirm, onClose }: {
  marketType: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(3,7,18,0.85)] backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <p className="text-sm font-semibold text-gray-100">Switch to Paper Mode</p>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-gray-400">
            Switch <span className="text-white font-medium">{MARKET_LABELS[marketType]}</span> back to paper mode? No real trades will be placed.
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
              Cancel
            </button>
            <button onClick={onConfirm} className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-brand-500 hover:bg-brand-600 text-white transition-colors">
              Switch to Paper
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
