'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'

type Step = 'choose' | 'otp' | 'done'

export default function LoginPage() {
  const router = useRouter()
  const [step, setStep]           = useState<Step>('choose')
  const [tab, setTab]             = useState<'signin' | 'signup'>('signin')
  const [email, setEmail]         = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [accessVerified, setAccessVerified] = useState(false)
  const [accessError, setAccessError]       = useState('')
  const [otp, setOtp]             = useState(['','','','','',''])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  async function handleVerifyAccessCode() {
    if (!accessCode.trim()) {
      setAccessError('Access code is required for new accounts.')
      return
    }

    setLoading(true)
    setAccessError('')
    try {
      await apiFetch('/api/access/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: accessCode.trim() }),
      })
      setAccessVerified(true)
      setAccessError('Access code verified. You may proceed.')
    } catch (err: any) {
      setAccessVerified(false)
      setAccessError(err?.message ?? 'Invalid access code.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogleLogin() {
    setLoading(true)
    window.location.href = '/api/auth/signin/google?callbackUrl=/dashboard'
  }

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return
    if (tab === 'signup' && !accessVerified) {
      setAccessError('Please verify your access code first.')
      return
    }
    setLoading(true); setError('')
    try {
      await apiFetch('/api/access/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setStep('otp')
    } catch (e) {
      setError('Could not send code. Check your email address.')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOtp() {
    const code = otp.join('')
    if (code.length !== 6) return
    setLoading(true); setError('')

    try {
      await apiFetch('/api/access/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp: code }),
      })
      setStep('done')
      setTimeout(() => { window.location.href = '/dashboard' }, 800)
    } catch (err: any) {
      const status = err?.status
      const msg = err?.message ?? 'Invalid or expired code.'

      if (status === 403) {
        setAccessVerified(false)
        setAccessError('Access code expired. Please verify again.')
        setAccessCode('')
        setStep('choose')
      }

      if (status === 409) {
        setError('User already exists. Please login.')
      } else {
        setError(msg)
      }

      setOtp(['','','','','',''])
    } finally {
      setLoading(false)
    }
  }

  async function handleResendOtp() {
    if (!email) return
    setLoading(true); setError('')
    try {
      await apiFetch('/api/access/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    } catch (e) {
      setError('Could not resend code. Try again later.')
    } finally {
      setLoading(false)
    }
  }

  function handleOtpChange(val: string, idx: number) {
    if (!/^\d*$/.test(val)) return
    const next = [...otp]; next[idx] = val.slice(-1); setOtp(next)
    if (val && idx < 5) document.getElementById(`otp-${idx+1}`)?.focus()
    if (next.every(d => d) && val) setTimeout(() => handleVerifyOtp(), 100)
  }

  function handleOtpKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0)
      document.getElementById(`otp-${idx-1}`)?.focus()
  }

  const page:  React.CSSProperties = { minHeight:'100vh', background:'#030712', display:'flex', alignItems:'center', justifyContent:'center', padding:'1rem', fontFamily:'system-ui,-apple-system,sans-serif' }
  const wrap:  React.CSSProperties = { width:'100%', maxWidth:'440px' }
  const card:  React.CSSProperties = { background:'#111827', border:'1px solid #1f2937', borderRadius:'16px', padding:'28px' }
  const btnPrimary: React.CSSProperties = { width:'100%', padding:'12px', background:'#1D9E75', border:'none', borderRadius:'10px', color:'white', fontSize:'14px', fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', transition:'opacity 0.15s' }
  const btnSecondary: React.CSSProperties = { width:'100%', padding:'11px', background:'transparent', border:'1px solid #374151', borderRadius:'10px', color:'#d1d5db', fontSize:'14px', fontWeight:500, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', marginBottom:'12px' }
  const inputS: React.CSSProperties = { width:'100%', padding:'11px 14px', background:'#1f2937', border:'1px solid #374151', borderRadius:'10px', color:'#f9fafb', fontSize:'14px', outline:'none', boxSizing:'border-box' as 'border-box' }
  const line: React.CSSProperties = { flex:1, height:'1px', background:'#1f2937' }

  return (
    <div style={page}>
      <div style={wrap}>
        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', marginBottom:'2rem' }}>
          <div style={{ width:'40px', height:'40px', borderRadius:'10px', background:'#1D9E75', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <svg width="20" height="20" fill="none" stroke="white" strokeWidth={2.5} viewBox="0 0 24 24">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
              <polyline points="16 7 22 7 22 13"/>
            </svg>
          </div>
          <span style={{ fontSize:'22px', fontWeight:600, color:'#f9fafb' }}>UpBot</span>
        </div>

        <div style={card}>
          {tab === 'signup' && accessVerified && (
            <div style={{ display:'flex', alignItems:'center', gap:'8px', background:'rgba(29,158,117,0.1)', border:'1px solid rgba(29,158,117,0.2)', borderRadius:'10px', padding:'10px 14px', marginBottom:'20px' }}>
              <svg width="16" height="16" fill="none" stroke="#1D9E75" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              <span style={{ fontSize:'13px', color:'#1D9E75', fontWeight:500 }}>Access code verified — you can sign up now</span>
            </div>
          )}

          {/* Step: choose */}
          {step === 'choose' && (
            <>
              <div style={{ display:'flex', background:'#1f2937', borderRadius:'10px', padding:'4px', marginBottom:'20px' }}>
                {(['signin','signup'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)} style={{ flex:1, padding:'8px', border:'none', borderRadius:'8px', fontSize:'13px', fontWeight:500, cursor:'pointer', background: tab===t ? '#374151' : 'transparent', color: tab===t ? '#f9fafb' : '#6b7280' }}>
                    {t === 'signin' ? 'Sign in' : 'Create account'}
                  </button>
                ))}
              </div>

              <h1 style={{ fontSize:'20px', fontWeight:600, color:'#f9fafb', margin:'0 0 4px' }}>
                {tab === 'signin' ? 'Welcome back' : 'Create your account'}
              </h1>
              <p style={{ fontSize:'13px', color:'#6b7280', margin:'0 0 20px' }}>
                {tab === 'signin'
                  ? 'Enter email to request OTP.'
                  : 'Verify access code first, then request OTP.'}
              </p>

              {tab === 'signin' && (
                <>
                  <button onClick={handleGoogleLogin} disabled={loading} style={btnSecondary}>
                    <svg width="18" height="18" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                  </button>

                  <div style={{ display:'flex', alignItems:'center', gap:'12px', margin:'16px 0' }}>
                    <div style={line}/><span style={{ fontSize:'12px', color:'#4b5563' }}>or use email</span><div style={line}/>
                  </div>
                </>
              )}

              {tab === 'signup' && (
                <div style={{ display:'flex', alignItems:'center', gap:'12px', margin:'16px 0' }}>
                  <div style={line}/><span style={{ fontSize:'12px', color:'#4b5563' }}>Access code + email</span><div style={line}/>
                </div>
              )}

              <form onSubmit={handleSendOtp}>
                {tab === 'signup' && !accessVerified && (
                  <>
                    <label style={{ display:'block', fontSize:'12px', color:'#9ca3af', fontWeight:500, marginBottom:'6px' }}>Access code</label>
                    <div style={{ display:'flex', gap:'8px', marginBottom:'12px' }}>
                      <input style={{ ...inputS, flex:1 }} type="text" placeholder="XXXX-XXXX-XXXX"
                        value={accessCode} onChange={e => setAccessCode(e.target.value)} />
                      <button type="button" onClick={handleVerifyAccessCode}
                        disabled={loading || !accessCode}
                        style={{ padding:'10px 12px', border:'none', borderRadius:'10px', background:'#1D9E75', color:'white', cursor: loading || !accessCode ? 'not-allowed' : 'pointer' }}>
                        Verify
                      </button>
                    </div>
                    {accessError && <p style={{ color:'#f87171', fontSize:'13px', marginBottom:'10px' }}>{accessError}</p>}
                  </>
                )}

                <label style={{ display:'block', fontSize:'12px', color:'#9ca3af', fontWeight:500, marginBottom:'6px' }}>Email address</label>
                <input style={{ ...inputS, marginBottom:'12px' }} type="email" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)} required />
                {error && <p style={{ color:'#f87171', fontSize:'13px', marginBottom:'10px' }}>{error}</p>}
                <button type="submit" style={{ ...btnPrimary, opacity: loading || !email ? 0.5 : 1 }} disabled={loading || !email || (tab === 'signup' && !accessVerified)}>
                  {loading ? 'Sending…' : '✉ Send OTP code'}
                </button>
              </form>
              <p style={{ fontSize:'12px', color:'#4b5563', textAlign:'center', marginTop:'14px' }}>
                A 6-digit code will be sent to your email. Expires in 15 minutes.
              </p>
            </>
          )}

          {/* Step: OTP */}
          {step === 'otp' && (
            <>
              <h1 style={{ fontSize:'20px', fontWeight:600, color:'#f9fafb', margin:'0 0 6px' }}>Check your email</h1>
              <p style={{ fontSize:'13px', color:'#6b7280', margin:'0 0 20px' }}>
                Code sent to <span style={{ color:'#d1d5db' }}>{email}</span>
              </p>
              <div style={{ display:'flex', gap:'8px', justifyContent:'center', marginBottom:'20px' }}>
                {otp.map((digit, i) => (
                  <input key={i} id={`otp-${i}`}
                    style={{ width:'46px', height:'52px', background:'#1f2937', border:'1px solid #374151', borderRadius:'10px', textAlign:'center', fontSize:'22px', fontWeight:600, color:'#f9fafb', outline:'none', boxSizing:'border-box' as 'border-box' }}
                    value={digit} onChange={e => handleOtpChange(e.target.value, i)}
                    onKeyDown={e => handleOtpKeyDown(e, i)} maxLength={1} inputMode="numeric" autoFocus={i===0}
                  />
                ))}
              </div>
              {error && <p style={{ color:'#f87171', fontSize:'13px', textAlign:'center', marginBottom:'12px' }}>{error}</p>}
              <button onClick={handleVerifyOtp} disabled={otp.join('').length !== 6 || loading}
                style={{ ...btnPrimary, opacity: otp.join('').length !== 6 || loading ? 0.5 : 1 }}>
                {loading ? 'Verifying…' : '→ Verify & Sign In'}
              </button>
              <button onClick={() => { setStep('choose'); setOtp(['','','','','','']); setError('') }}
                style={{ width:'100%', background:'none', border:'none', color:'#6b7280', fontSize:'13px', marginTop:'12px', cursor:'pointer', padding:'4px' }}>
                ← Use a different method
              </button>
              <button onClick={handleResendOtp}
                disabled={loading}
                style={{ width:'100%', background:'none', border:'none', color:'#9ca3af', fontSize:'13px', marginTop:'8px', cursor: loading ? 'not-allowed' : 'pointer', padding:'4px' }}>
                ↻ Resend code
              </button>
            </>
          )}

          {/* Step: done */}
          {step === 'done' && (
            <div style={{ textAlign:'center', padding:'20px 0' }}>
              <div style={{ width:'56px', height:'56px', borderRadius:'50%', background:'rgba(29,158,117,0.15)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px' }}>
                <svg width="28" height="28" fill="none" stroke="#1D9E75" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <h2 style={{ fontSize:'20px', fontWeight:600, color:'#f9fafb', margin:'0 0 6px' }}>You are in!</h2>
              <p style={{ fontSize:'13px', color:'#6b7280' }}>Redirecting to dashboard…</p>
            </div>
          )}
        </div>
      </div>
      <style>{`input:focus { border-color: #1D9E75 !important; box-shadow: 0 0 0 3px rgba(29,158,117,0.15); }`}</style>
    </div>
  )
}