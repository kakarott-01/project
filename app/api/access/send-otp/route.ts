// ═══════════════════════════════════════════════════════════════════════════════
// app/api/access/send-otp/route.ts  — FIXED
// ═══════════════════════════════════════════════════════════════════════════════
// FIX: Replaced Math.random()-based OTP with generateSecureOtp() from lib/otp.ts
//      which uses crypto.randomInt() (CSPRNG).
// ═══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import nodemailer                     from 'nodemailer'
import { getClientIp }                from '@/lib/utils'
import { redis }                      from '@/lib/redis'
import { generateSecureOtp }          from '@/lib/otp'   // FIX: CSPRNG

const OTP_RATE_LIMIT = 3
const OTP_WINDOW_MS  = 5 * 60 * 1000
const OTP_EXPIRY_SEC = 5 * 60

async function canSendOtp(key: string): Promise<{ ok: boolean; remaining: number }> {
  const rKey  = `otp_rate:${key}`
  const now   = Date.now()
  const raw   = await redis.get<string>(rKey)
  const entry = raw ? JSON.parse(raw) : null

  if (!entry || now - entry.firstTs > OTP_WINDOW_MS) {
    await redis.set(rKey, JSON.stringify({ count: 1, firstTs: now }), { ex: 300 })
    return { ok: true, remaining: OTP_RATE_LIMIT - 1 }
  }

  if (entry.count >= OTP_RATE_LIMIT) {
    return { ok: false, remaining: 0 }
  }

  entry.count += 1
  await redis.set(rKey, JSON.stringify(entry), { ex: 300 })
  return { ok: true, remaining: OTP_RATE_LIMIT - entry.count }
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json()
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    }

    const normalizedEmail = email.toLowerCase().trim()
    const ip = getClientIp(req)

    try {
      const ipLimit = await canSendOtp(`ip:${ip}`)
      if (!ipLimit.ok) {
        return NextResponse.json({ error: 'Too many OTP requests from this IP. Try again later.' }, { status: 429 })
      }

      const emailLimit = await canSendOtp(`email:${normalizedEmail}`)
      if (!emailLimit.ok) {
        return NextResponse.json({ error: 'Too many OTP requests for this email. Try again later.' }, { status: 429 })
      }
    } catch (redisError) {
      console.error('Redis unavailable during login OTP rate limiting:', redisError)
      return NextResponse.json(
        { error: 'Verification service temporarily unavailable. Please try again.' },
        { status: 503 },
      )
    }

    const otp = generateSecureOtp()  // FIX: was Math.random()
    try {
      await redis.set(`login_otp:${normalizedEmail}`, otp, { ex: OTP_EXPIRY_SEC })
    } catch (redisError) {
      console.error('Redis unavailable during login OTP store:', redisError)
      return NextResponse.json(
        { error: 'Verification service temporarily unavailable. Please try again.' },
        { status: 503 },
      )
    }

    console.log(`\n🔐 OTP for ${normalizedEmail}: ${otp}\n`)

    const transporter = nodemailer.createTransport({
      host:   process.env.EMAIL_SERVER_HOST,
      port:   Number(process.env.EMAIL_SERVER_PORT ?? 587),
      secure: false,
      auth: {
        user: process.env.EMAIL_SERVER_USER,
        pass: process.env.EMAIL_SERVER_PASSWORD,
      },
    })

    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      normalizedEmail,
      subject: 'Your AlgoBot login code',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:400px;margin:0 auto;padding:32px;background:#030712;color:#f9fafb;border-radius:16px;">
          <h2 style="color:#1D9E75;margin-bottom:8px;">AlgoBot</h2>
          <p style="color:#9ca3af;margin-bottom:20px;">Your one-time login code:</p>
          <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;text-align:center;letter-spacing:10px;font-size:36px;font-weight:700;color:#1D9E75;">
            ${otp}
          </div>
          <p style="color:#6b7280;font-size:13px;margin-top:16px;">Expires in 5 minutes. Single use only.</p>
        </div>
      `,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('send-otp error:', error)
    return NextResponse.json({ error: 'Failed to send OTP' }, { status: 500 })
  }
}
