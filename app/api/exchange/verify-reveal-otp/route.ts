import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { redis } from '@/lib/redis'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { otp } = await req.json()
  if (!otp || typeof otp !== 'string') {
    return NextResponse.json({ error: 'OTP required' }, { status: 400 })
  }

  // Upstash may deserialize a stored numeric string as a JS number.
  // Always coerce to string before comparing.
  const raw = await redis.get(`reveal_otp:${session.id}`)

  if (raw === null || raw === undefined) {
    return NextResponse.json({ error: 'No OTP found. Please request a new one.' }, { status: 401 })
  }

  const stored = String(raw).trim()
  const provided = otp.trim()

  if (stored !== provided) {
    return NextResponse.json({ error: 'Invalid OTP.' }, { status: 401 })
  }

  // Burn OTP
  await redis.del(`reveal_otp:${session.id}`)

  // Issue short-lived reveal token cookie (5 minutes)
  const token = Buffer.from(`${session.id}:${Date.now()}`).toString('base64')

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