// ═══════════════════════════════════════════════════════════════════════════════
// app/api/exchange/verify-reveal-otp/route.ts  — FIXED
// ═══════════════════════════════════════════════════════════════════════════════
// FIX: Replaced base64(userId:timestamp) token (trivially forgeable) with
//      HMAC-signed token from lib/secure-token.ts.
// ═══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { auth }                       from '@/lib/auth'
import { redis }                      from '@/lib/redis'
import { issueSecureToken }           from '@/lib/secure-token'  // FIX
import {
  checkOtpVerifyLimit,
  otpVerifyLimitMessage,
  resetOtpVerifyLimit,
} from '@/lib/otp-rate-limit'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { otp } = await req.json().catch(() => ({}))
  if (!otp || typeof otp !== 'string') {
    return NextResponse.json({ error: 'OTP required' }, { status: 400 })
  }

  const limitKey = `reveal:${session.id}`
  const rateLimit = await checkOtpVerifyLimit(limitKey)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: otpVerifyLimitMessage(rateLimit.retryAfterSec) },
      { status: 429 },
    )
  }

  let raw: unknown
  try {
    raw = await redis.get(`reveal_otp:${session.id}`)
  } catch (redisError) {
    console.error('reveal verify redis error:', redisError)
    return NextResponse.json(
      { error: 'Verification service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }

  if (raw === null || raw === undefined) {
    return NextResponse.json({ error: 'No OTP found. Please request a new one.' }, { status: 401 })
  }

  const stored   = String(raw).trim()
  const provided = otp.trim()

  if (stored !== provided) {
    return NextResponse.json({ error: 'Invalid OTP.' }, { status: 401 })
  }

  await Promise.all([
    redis.del(`reveal_otp:${session.id}`),
    resetOtpVerifyLimit(limitKey),
  ])

  // FIX: Issue HMAC-signed token (was base64(userId:timestamp) — forgeable)
  const token = issueSecureToken(session.id, 'reveal')

  const response = NextResponse.json({ success: true })
  response.cookies.set('reveal_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   5 * 60,
    path:     '/',
    sameSite: 'strict',
  })

  return response
}
