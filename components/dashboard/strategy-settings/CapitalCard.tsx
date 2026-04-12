"use client"
import React from 'react'
import { StatusBadge } from '@/components/ui/status-badge'

type Props = { item: any }

function CapitalCard({ item }: Props) {
  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-100">{item.strategyKey}</p>
        <StatusBadge tone={item.settings.priority === 'HIGH' ? 'danger' : item.settings.priority === 'MEDIUM' ? 'warning' : 'neutral'}>
          {item.settings.priority}
        </StatusBadge>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Per trade ₹{item.perTradeCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 })} · Max active ₹{item.maxActiveCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
      </p>
    </div>
  )
}

export default React.memo(CapitalCard)
