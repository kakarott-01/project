
'use client'

import { useState, useRef, useEffect } from 'react'
import { Loader2, Lock, MailCheck, X } from 'lucide-react'
import useModeOtp from '@/lib/hooks/use-mode-otp'

interface Props {
  email: string
  onVerified: () => void
  onClose: () => void
}

export default function ModeOtpModal({ email, onVerified, onClose }: Props) {
  const { sendOtp, verifyOtp } = useModeOtp()
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const refs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => { sendOtpRequest() }, [])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  async function sendOtpRequest() {
    setSending(true); setError('')
    try {
      await sendOtp()
      setSent(true); setCooldown(60); setTimeout(() => refs.current[0]?.focus(), 100)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to send OTP')
    } finally { setSending(false) }
  }

  async function verify() {
    const code = digits.join('')
    if (code.length !== 6) return
    setVerifying(true); setError('')
    try {
      await verifyOtp(code)
      onVerified()
    } catch (err: any) {
      setError(err?.message ?? 'Invalid OTP')
      setDigits(['', '', '', '', '', ''])
      setTimeout(() => refs.current[0]?.focus(), 50)
    } finally { setVerifying(false) }
  }

  function handleDigit(val: string, idx: number) {
    if (!/^\d*$/.test(val)) return
    const next = [...digits]; next[idx] = val.slice(-1); setDigits(next)
    if (val && idx < 5) refs.current[idx + 1]?.focus()
    if (next.every(d => d) && val) setTimeout(verify, 80)
  }

  function handleKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) refs.current[idx - 1]?.focus()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(3,7,18,0.85)] backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-red-500/15 flex items-center justify-center">
              <Lock className="w-4 h-4 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-100">Verify to view keys</p>
              <p className="text-xs text-gray-500">Security check required</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5">
          {sending && !sent ? (
            <div className="flex flex-col items-center py-4 gap-3">
              <Loader2 className="w-6 h-6 text-red-400 animate-spin" />
              <p className="text-sm text-gray-400">Sending confirmation code…</p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5 bg-red-500/5 border border-red-500/15 rounded-xl px-3.5 py-3 mb-5">
                <MailCheck className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-gray-400">
                  A confirmation code was sent to <span className="text-gray-200 font-medium">{email}</span>.
                  Enter it to enable live trading with real funds.
                </p>
              </div>

              <div className="flex gap-2 justify-center mb-4">
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={el => { refs.current[i] = el }}
                    value={d}
                    onChange={e => handleDigit(e.target.value, i)}
                    onKeyDown={e => handleKeyDown(e, i)}
                    maxLength={1}
                    inputMode="numeric"
                    autoFocus={i === 0 && sent}
                    className="w-11 h-12 text-center text-lg font-semibold bg-gray-800 border border-gray-700
                               rounded-lg text-gray-100 focus:border-red-400 focus:ring-1
                               focus:ring-red-400/30 outline-none transition-all"
                  />
                ))}
              </div>

              {error && <p className="text-xs text-red-400 text-center mb-3">{error}</p>}

              <button
                onClick={verify}
                disabled={digits.join('').length !== 6 || verifying}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all
                           bg-red-600 hover:bg-red-500 text-white
                           disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed"
              >
                {verifying
                  ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Verifying…</span>
                  : 'Confirm — Enable Live Trading'
                }
              </button>
              <button
                onClick={sendOtp}
                disabled={cooldown > 0 || sending}
                className="w-full mt-2 py-2 text-xs text-gray-500 hover:text-gray-300 disabled:text-gray-700 disabled:cursor-not-allowed transition-colors"
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
