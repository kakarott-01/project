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

  const S = {
    page:   { minHeight:'100vh', background:'#030712', display:'flex', alignItems:'center', justifyContent:'center', padding:'1rem', fontFamily:'system-ui,-apple-system,sans-serif' } as React.CSSProperties,
    wrap:   { width:'100%', maxWidth:'420px' } as React.CSSProperties,
    logo:   { display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', marginBottom:'2rem' } as React.CSSProperties,
    icon:   { width:'36px', height:'36px', borderRadius:'10px', background:'#1D9E75', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 as 0 } as React.CSSProperties,
    name:   { fontSize:'20px', fontWeight:600, color:'#f9fafb' } as React.CSSProperties,
    card:   { background:'#111827', border:'1px solid #1f2937', borderRadius:'16px', padding:'24px' } as React.CSSProperties,
    badge:  { display:'flex', alignItems:'center', gap:'6px', marginBottom:'6px' } as React.CSSProperties,
    h1:     { fontSize:'20px', fontWeight:600, color:'#f9fafb', margin:'0 0 6px' } as React.CSSProperties,
    sub:    { fontSize:'13px', color:'#6b7280', margin:'0 0 20px' } as React.CSSProperties,
    bar:    { height:'3px', background:'#1f2937', borderRadius:'99px', marginBottom:'20px', overflow:'hidden' } as React.CSSProperties,
    row:    { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'8px' } as React.CSSProperties,
    label:  { fontSize:'12px', color:'#9ca3af', fontWeight:500 } as React.CSSProperties,
    dots:   { display:'flex', alignItems:'center', gap:'6px' } as React.CSSProperties,
    input:  { width:'100%', padding:'12px', marginBottom:'12px', background:'#1f2937', border:'1px solid #374151', borderRadius:'10px', color:'#f9fafb', fontSize:'18px', fontFamily:'monospace', textAlign:'center' as 'center', letterSpacing:'4px', outline:'none', boxSizing:'border-box' as 'border-box' } as React.CSSProperties,
    err:    { display:'flex', alignItems:'center', gap:'8px', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'8px', padding:'10px 12px', marginBottom:'12px', color:'#f87171', fontSize:'13px' } as React.CSSProperties,
    divider:{ marginTop:'20px', paddingTop:'16px', borderTop:'1px solid #1f2937' } as React.CSSProperties,
  }

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={S.logo}>
          <div style={S.icon}>
            <svg width="18" height="18" fill="none" stroke="white" strokeWidth={2.5} viewBox="0 0 24 24">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
              <polyline points="16 7 22 7 22 13"/>
            </svg>
          </div>
          <span style={S.name}>UpBot</span>
        </div>

        <div style={S.card}>
          <div style={S.badge}>
            <svg width="13" height="13" fill="none" stroke="#f59e0b" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span style={{ fontSize:'11px', color:'#f59e0b', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>Private Access</span>
          </div>

          <h1 style={S.h1}>Enter access code</h1>
          <p style={S.sub}>Single-use code required. Expires in {mins}:{secs}</p>

          <div style={S.bar}>
            <div style={{ height:'100%', borderRadius:'99px', transition:'width 1s linear', width:`${timerPct}%`, background: timeLeft < 120 ? '#ef4444' : '#1D9E75' }} />
          </div>

          <form onSubmit={handleSubmit}>
            <div style={S.row}>
              <span style={S.label}>Access Code</span>
              <div style={S.dots}>
                <span style={{ fontSize:'11px', color:'#4b5563' }}>Attempts:</span>
                {[0,1,2].map(i => (
                  <div key={i} style={{ width:'8px', height:'8px', borderRadius:'50%', background: i < remaining ? '#ef4444' : '#374151' }} />
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
              style={S.input}
            />

            {error && (
              <div style={S.err}>
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
              style={{
                width:'100%', padding:'12px',
                background: loading || locked || !code.trim() ? '#374151' : '#1D9E75',
                border:'none', borderRadius:'10px', color:'white',
                fontSize:'14px', fontWeight:600,
                cursor: loading || locked || !code.trim() ? 'not-allowed' : 'pointer',
                display:'flex', alignItems:'center', justifyContent:'center', gap:'8px',
              }}
            >
              {loading ? 'Verifying…' : locked ? '🔒 Access Locked' : 'Verify Code'}
            </button>
          </form>

          <div style={{ marginTop:'16px', fontSize:'13px', color:'#6b7280', textAlign:'center' }}>
            Already have an account? <a href="/login" style={{ color:'#1D9E75', textDecoration:'underline' }}>Sign in</a>
          </div>

          <div style={S.divider}>
            {[
              { dot:'#1D9E75', text:'Single-use — code is burned on entry' },
              { dot:'#1D9E75', text:'Expires 15 minutes after generation' },
              { dot:'#ef4444', text:'3 wrong attempts locks your IP for 30 minutes' },
            ].map((item, i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:'10px', marginBottom:'8px' }}>
                <div style={{ width:'6px', height:'6px', borderRadius:'50%', background:item.dot, marginTop:'5px', flexShrink:0 }} />
                <span style={{ fontSize:'12px', color:'#6b7280' }}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}