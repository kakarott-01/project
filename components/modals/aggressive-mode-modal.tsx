'use client'

import React from 'react'
import { X } from 'lucide-react'
import { InlineAlert } from '@/components/ui/inline-alert'
import { Button } from '@/components/ui/button'

export default function AggressiveModeModal({ market, onCancel, onConfirm }: {
  market: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(3,7,18,0.88)', backdropFilter: 'blur(4px)' }}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div className="w-full max-w-lg rounded-3xl border border-red-500/20 bg-gray-950 shadow-2xl">
        <div className="border-b border-red-500/15 px-5 py-4">
          <p className="text-sm font-semibold text-red-200">AGGRESSIVE MODE ENABLED</p>
          <p className="mt-1 text-xs text-gray-400">{market} will trade with independent strategy capital.</p>
        </div>
        <div className="space-y-4 px-5 py-5">
          <InlineAlert tone="danger" title="Review before saving">
            Strategies trade independently, capital is split per strategy, and risk rises significantly when hedge behavior or conflicting signals are allowed.
          </InlineAlert>
          <div className="space-y-2 rounded-2xl border border-gray-800 bg-gray-900/60 p-3">
            <p className="text-xs text-gray-300">Per-strategy limits apply only in AGGRESSIVE mode.</p>
            <p className="text-xs text-gray-300">Global risk controls still enforce the final hard cap.</p>
            <p className="text-xs text-gray-300">Priority-based blocking can prevent lower-priority entries when capital is tight.</p>
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={onCancel}>Cancel</Button>
            <Button className="flex-1" onClick={onConfirm}>I understand the risk</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
