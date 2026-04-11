'use client'
import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '@/lib/api-client'
import { useRouter } from 'next/navigation'

export default function AccessPage() {
  const router = useRouter()
  const [code, setCode]           = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [remaining, setRemaining] = useState(3)
  const [locked, setLocked]       = useState(false)
  const [timeLeft, setTimeLeft]   = useState(900)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const t = setInterval(() => setTimeLeft(p => Math.max(0, p - 1)), 1000)
    return () => clearInterval(t)
  }, [])

  const timerPct = (timeLeft / 900) * 100
  const mins     = Math.floor(timeLeft / 60)
  const secs     = String(timeLeft % 60).padStart(2, '0')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!code.trim() || locked) return
    setLoading(true); setError('')
    try {
      await apiFetch('/api/access/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      setLoading(false)
      window.location.href = '/dashboard'
    } catch (err: any) {
      setLoading(false)
      if (err?.status === 429) {
        setLocked(true)
        setError('Too many attempts. IP locked for 30 minutes.')
      } else {
        const attempts = err?.data?.attemptsRemaining ?? Math.max(0, remaining - 1)
        setRemaining(attempts)
        setError(err?.message ?? 'Invalid code')
        setCode(''); inputRef.current?.focus()
        if ((err?.data?.attemptsRemaining ?? 0) <= 0) setLocked(true)
      }
    }
  }

  // Replaced inline style object with Tailwind classes for consistency

  return (
    <div className="min-h-screen bg-[#030712] flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-9 h-9 rounded-lg bg-[#1D9E75] flex items-center justify-center flex-shrink-0">
            <svg width="18" height="18" fill="none" stroke="white" strokeWidth={2.5} viewBox="0 0 24 24">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
              <polyline points="16 7 22 7 22 13"/>
            </svg>
          </div>
          <span className="text-[20px] font-semibold text-gray-100">UpBot</span>
        </div>

        <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6">
          <div className="flex items-center gap-1.5 mb-1">
            <svg width="13" height="13" fill="none" stroke="#f59e0b" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span className="text-[11px] text-[#f59e0b] font-semibold uppercase" style={{ letterSpacing: '0.06em' }}>Private Access</span>
          </div>

          <h1 className="text-[20px] font-semibold text-gray-100 mb-1">Enter access code</h1>
          <p className="text-sm text-gray-400 mb-5">Single-use code required. Expires in {mins}:{secs}</p>

          <div className="h-3 bg-[#1f2937] rounded-full mb-5 overflow-hidden">
            <div style={{ width: `${timerPct}%`, background: timeLeft < 120 ? '#ef4444' : '#1D9E75' }} className="h-full rounded-full transition-all" />
          </div>

          <form onSubmit={handleSubmit}>
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-gray-400 font-medium">Access Code</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-gray-500">Attempts:</span>
                {[0,1,2].map(i => (
                  <div key={i} className="w-2 h-2 rounded-full" style={{ background: i < remaining ? '#ef4444' : '#374151' }} />
                ))}
              </div>
            </div>

            <input
              ref={inputRef}
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX"
              maxLength={14}
              disabled={locked || loading}
              autoComplete="off"
              className="w-full px-4 py-3 mb-3 bg-[#1f2937] border border-[#374151] rounded-lg text-gray-100 text-lg font-mono text-center tracking-widest outline-none"
            />

            {error && (
              <div className="flex items-center gap-2 bg-red-100 border border-red-300 rounded-md p-3 mb-3 text-red-500 text-sm">
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" style={{ flexShrink:0 }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || locked || !code.trim()}
              className={`w-full py-3 rounded-lg text-white font-semibold flex items-center justify-center gap-2 ${loading || locked || !code.trim() ? 'bg-[#374151]' : 'bg-[#1D9E75]'}`}
            >
              {loading ? 'Verifying…' : locked ? '🔒 Access Locked' : 'Verify Code'}
            </button>
          </form>

          <div className="mt-4 text-sm text-gray-400 text-center">
            Already have an account? <a href="/login" className="text-[#1D9E75] underline">Sign in</a>
          </div>

          <div className="mt-5 pt-4 border-t border-[#1f2937]">
            {[
              { dot:'#1D9E75', text:'Single-use — code is burned on entry' },
              { dot:'#1D9E75', text:'Expires 15 minutes after generation' },
              { dot:'#ef4444', text:'3 wrong attempts locks your IP for 30 minutes' },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-2.5 mb-2">
                <div className="w-1.5 h-1.5 rounded-full mt-1" style={{ background: item.dot }} />
                <span className="text-sm text-gray-400">{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}