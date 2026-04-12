"use client"
import React, { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

type Props = {
  label: string
  value: string
  revealed: boolean
}

function MaskedField({ label, value, revealed }: Props) {
  const [show, setShow] = useState(false)
  const masked = value.slice(0, 4) + '••••••••••••' + value.slice(-4)

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-gray-500 tracking-wide">{label}</p>
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900/60 border border-gray-700 rounded-lg">
        <span className="flex-1 font-mono text-sm text-gray-300 truncate select-all">
          {revealed && show ? value : masked}
        </span>
        {revealed && (
          <button onClick={() => setShow(s => !s)} className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0">
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  )
}

export default React.memo(MaskedField)
