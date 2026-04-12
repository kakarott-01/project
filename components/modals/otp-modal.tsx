
'use client'

import { useState, useRef, useEffect } from 'react'
import { Loader2, Lock, MailCheck, X } from 'lucide-react'
import useExchangeOtp, { RevealedKeys } from '@/lib/hooks/use-exchange-otp'

interface OtpModalProps {
  email: string
  onVerified: (data?: RevealedKeys) => void
  onClose: () => void
  revealParams?: { marketType: string; exchangeName: string } | null
}

export default function OtpModal({ email, onVerified, onClose, revealParams = null }: OtpModalProps) {
  const { sendOtp, verifyOtp, reveal } = useExchangeOtp()
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => { sendOtpRequest() }, [])

  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  async function sendOtpRequest() {
    setSending(true)
    setError('')
    try {
      await sendOtp()
      setSent(true)
      setResendCooldown(60)
      setTimeout(() => inputRefs.current[0]?.focus(), 100)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to send OTP')
    } finally {
      setSending(false)
    }
  }

  async function verify() {
    const code = digits.join('')
    if (code.length !== 6) return
    setVerifying(true)
    setError('')
    try {
      await verifyOtp(code)
      // If a reveal target was provided, fetch revealed keys and return them
      if (revealParams) {
        try {
          const data = await reveal(revealParams.marketType, revealParams.exchangeName)
          onVerified(data)
        } catch (err: any) {
          setError(err?.message ?? 'Failed to load keys')
          onVerified(undefined)
        }
      } else {
        onVerified()
      }
    } catch (err: any) {
      setError(err?.message ?? 'Invalid OTP')
      setDigits(['', '', '', '', '', ''])
      setTimeout(() => inputRefs.current[0]?.focus(), 50)
    } finally {
      setVerifying(false)
    }
  }

  function handleDigit(val: string, idx: number) {
    if (!/^\d*$/.test(val)) return
    const next = [...digits]
    next[idx] = val.slice(-1)
    setDigits(next)
    if (val && idx < 5) inputRefs.current[idx + 1]?.focus()
    if (next.every(d => d) && val) setTimeout(verify, 80)
  }

  function handleKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) inputRefs.current[idx - 1]?.focus()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(3,7,18,0.85)] backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center">
              <Lock className="w-4 h-4 text-brand-500" />
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
              <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
              <p className="text-sm text-gray-400">Sending OTP to your email…</p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5 bg-brand-500/5 border border-brand-500/15 rounded-xl px-3.5 py-3 mb-5">
                <MailCheck className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-gray-400">
                    A 6-digit code was sent to <span className="text-gray-200 font-medium">{email}</span>.
                    Enter it below to continue.
                  </p>
              </div>

              <div className="flex gap-2 justify-center mb-4">
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={el => { inputRefs.current[i] = el }}
                    value={d}
                    onChange={e => handleDigit(e.target.value, i)}
                    onKeyDown={e => handleKeyDown(e, i)}
                    maxLength={1}
                    inputMode="numeric"
                    autoFocus={i === 0 && sent}
                    className="w-11 h-12 text-center text-lg font-semibold bg-gray-800 border border-gray-700 rounded-lg text-gray-100 focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none transition-all"
                  />
                ))}
              </div>

              {error && (
                <p className="text-xs text-red-400 text-center mb-3">{error}</p>
              )}


              <button
                onClick={verify}
                disabled={digits.join('').length !== 6 || verifying}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all
                  bg-brand-500 hover:bg-brand-600 text-white
                  disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed"
              >
                {verifying
                  ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Verifying…</span>
                  : "Verify & Continue"
                }
              </button>

              <button
                onClick={sendOtp}
                disabled={resendCooldown > 0 || sending}
                className="w-full mt-2 py-2 text-xs text-gray-500 hover:text-gray-300 disabled:text-gray-700 disabled:cursor-not-allowed transition-colors"
              >
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend OTP"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
