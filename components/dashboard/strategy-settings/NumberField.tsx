"use client"

import React from 'react'
import { InfoTip } from '@/components/ui/tooltip'

export default function NumberField({
  label,
  tip,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  disabled,
  onChange,
}: {
  label: string
  tip: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className="space-y-1.5">
      <span className="flex items-center gap-2 text-xs text-gray-500">
        {label}
        <InfoTip text={tip} />
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || min)}
        className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 disabled:opacity-60"
      />
      <p className="text-[11px] text-gray-600">
        Range {min} to {max}
        {suffix}
      </p>
    </label>
  )
}
