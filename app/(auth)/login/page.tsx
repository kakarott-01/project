'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
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
    try {
      await signIn('google', { callbackUrl: '/dashboard' })
    } catch (err) {
      // fallback to direct URL if signIn fails for any reason
      window.location.href = '/api/auth/signin/google?callbackUrl=/dashboard'
    }
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

  // Use Tailwind classes instead of inline style objects

  return (
    <div className="min-h-screen bg-[#030712] flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-[440px]">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-10 h-10 rounded-lg bg-[#1D9E75] flex items-center justify-center">
            <svg width="20" height="20" fill="none" stroke="white" strokeWidth={2.5} viewBox="0 0 24 24">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
              <polyline points="16 7 22 7 22 13"/>
            </svg>
          </div>
          <span className="text-[22px] font-semibold text-gray-100">UpBot</span>
        </div>
        <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-7">
          {tab === 'signup' && accessVerified && (
            <div className="flex items-center gap-2 bg-[#1d9e7530] border border-[#1d9e7530] rounded-lg px-3 py-2 mb-5">
              <svg width="16" height="16" fill="none" stroke="#1D9E75" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              <span className="text-sm text-[#1D9E75] font-medium">Access code verified — you can sign up now</span>
            </div>
          )}

          {/* Step: choose */}
          {step === 'choose' && (
            <>
              <div className="flex bg-[#1f2937] rounded-lg p-1 mb-5">
                {(['signin','signup'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)} className={`flex-1 px-3 py-2 rounded-md text-sm font-medium ${tab===t ? 'bg-[#374151] text-gray-100' : 'text-gray-500'}`}>
                    {t === 'signin' ? 'Sign in' : 'Create account'}
                  </button>
                ))}
              </div>

              <h1 className="text-[20px] font-semibold text-gray-100 mb-1">
                {tab === 'signin' ? 'Welcome back' : 'Create your account'}
              </h1>
              <p className="text-sm text-gray-400 mb-5">
                {tab === 'signin'
                  ? 'Enter email to request OTP.'
                  : 'Verify access code first, then request OTP.'}
              </p>

              {tab === 'signin' && (
                <>
                  <button onClick={handleGoogleLogin} disabled={loading} className="w-full py-2.5 mb-3 border border-[#374151] rounded-lg text-[#d1d5db] text-sm font-medium flex items-center justify-center gap-2">
                    <svg width="18" height="18" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                  </button>

                  <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-[#1f2937]"/><span className="text-xs text-gray-500">or use email</span><div className="flex-1 h-px bg-[#1f2937]"/>
                  </div>
                </>
              )}

              {tab === 'signup' && (
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-[#1f2937]"/><span className="text-xs text-gray-500">Access code + email</span><div className="flex-1 h-px bg-[#1f2937]"/>
                </div>
              )}

              <form onSubmit={handleSendOtp}>
                {tab === 'signup' && !accessVerified && (
                  <>
                    <label className="block text-xs text-gray-400 font-medium mb-1">Access code</label>
                    <div className="flex gap-2 mb-3">
                      <input className="flex-1 px-3 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-gray-100 outline-none" type="text" placeholder="XXXX-XXXX-XXXX"
                        value={accessCode} onChange={e => setAccessCode(e.target.value)} />
                      <button type="button" onClick={handleVerifyAccessCode}
                        disabled={loading || !accessCode}
                        className="px-3 py-2 rounded-lg bg-[#1D9E75] text-white" >
                        Verify
                      </button>
                    </div>
                    {accessError && <p className="text-sm text-red-400 mb-3">{accessError}</p>}
                  </>
                )}

                <label className="block text-xs text-gray-400 font-medium mb-1">Email address</label>
                <input className="w-full px-3 py-2 mb-3 bg-[#1f2937] border border-[#374151] rounded-lg text-gray-100 outline-none" type="email" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)} required />
                {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
                <button type="submit" className={`w-full py-3 rounded-xl text-sm font-semibold ${loading || !email ? 'bg-[#374151] text-gray-400' : 'bg-[#1D9E75] text-white'}`} disabled={loading || !email || (tab === 'signup' && !accessVerified)}>
                  {loading ? 'Sending…' : '✉ Send OTP code'}
                </button>
              </form>
              <p className="text-xs text-gray-500 text-center mt-3">
                A 6-digit code will be sent to your email. Expires in 15 minutes.
              </p>
            </>
          )}

          {/* Step: OTP */}
          {step === 'otp' && (
            <>
              <h1 className="text-[20px] font-semibold text-gray-100 mb-1">Check your email</h1>
              <p className="text-sm text-gray-400 mb-5">Code sent to <span className="text-gray-300">{email}</span></p>
              <div className="flex gap-2 justify-center mb-5">
                {otp.map((digit, i) => (
                  <input key={i} id={`otp-${i}`}
                    className="w-12 h-12 bg-[#1f2937] border border-[#374151] rounded-lg text-center text-2xl font-semibold text-gray-100 outline-none box-border"
                    value={digit} onChange={e => handleOtpChange(e.target.value, i)}
                    onKeyDown={e => handleOtpKeyDown(e, i)} maxLength={1} inputMode="numeric" autoFocus={i===0}
                  />
                ))}
              </div>
              {error && <p className="text-sm text-red-400 text-center mb-3">{error}</p>}
              <button onClick={handleVerifyOtp} disabled={otp.join('').length !== 6 || loading}
                className={`w-full py-3 rounded-xl text-sm font-semibold ${otp.join('').length !== 6 || loading ? 'bg-[#374151] text-gray-400' : 'bg-[#1D9E75] text-white'}`}>
                {loading ? 'Verifying…' : '→ Verify & Sign In'}
              </button>
              <button onClick={() => { setStep('choose'); setOtp(['','','','','','']); setError('') }}
                className="w-full bg-transparent border-none text-gray-400 text-sm mt-3 py-1">
                ← Use a different method
              </button>
              <button onClick={handleResendOtp}
                disabled={loading}
                className="w-full bg-transparent border-none text-gray-400 text-sm mt-2 py-1">
                ↻ Resend code
              </button>
            </>
          )}

          {/* Step: done */}
          {step === 'done' && (
            <div className="text-center py-5">
              <div className="w-14 h-14 rounded-full bg-[#1d9e7530] flex items-center justify-center mx-auto mb-4">
                <svg width="28" height="28" fill="none" stroke="#1D9E75" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <h2 className="text-[20px] font-semibold text-gray-100 mb-1">You are in!</h2>
              <p className="text-sm text-gray-400">Redirecting to dashboard…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}