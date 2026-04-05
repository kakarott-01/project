// ═══════════════════════════════════════════════════════════════════════════════
// app/api/exchange/send-reveal-otp/route.ts  — FIXED
// ═══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { auth }                       from '@/lib/auth'
import { redis }                      from '@/lib/redis'
import nodemailer                     from 'nodemailer'
import { generateSecureOtp }          from '@/lib/otp'   // FIX: CSPRNG

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.id || !session.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rateLimitKey = `reveal_otp_rate:${session.id}`
  let limit: { count: number; resetAt: number } | null = null
  const now = Date.now()

  try {
    const raw = await redis.get<string>(rateLimitKey)
    limit = raw ? JSON.parse(raw) : null
  } catch (redisError) {
    console.error('Redis unavailable during reveal OTP rate-limit read:', redisError)
    return NextResponse.json(
      { error: 'Verification service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }

  if (limit && now < limit.resetAt && limit.count >= 3) {
    return NextResponse.json({ error: 'Too many requests. Wait a few minutes.' }, { status: 429 })
  }

  const newLimit = (!limit || now >= limit.resetAt)
    ? { count: 1, resetAt: now + 10 * 60 * 1000 }
    : { ...limit, count: limit.count + 1 }
  try {
    await redis.set(rateLimitKey, JSON.stringify(newLimit), { ex: 600 })
  } catch (redisError) {
    console.error('Redis unavailable during reveal OTP rate-limit store:', redisError)
    return NextResponse.json(
      { error: 'Verification service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }

  const otp = generateSecureOtp()  // FIX: was Math.random()
  try {
    await redis.set(`reveal_otp:${session.id}`, otp, { ex: 300 })
  } catch (redisError) {
    console.error('Redis unavailable during reveal OTP store:', redisError)
    return NextResponse.json(
      { error: 'Verification service temporarily unavailable. Please try again.' },
      { status: 503 },
    )
  }

  console.log(`\n🔐 Reveal OTP for ${session.email}: ${otp}\n`)

  const transporter = nodemailer.createTransport({
    host:   process.env.EMAIL_SERVER_HOST,
    port:   Number(process.env.EMAIL_SERVER_PORT ?? 587),
    secure: false,
    auth: {
      user: process.env.EMAIL_SERVER_USER,
      pass: process.env.EMAIL_SERVER_PASSWORD,
    },
  })

  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM,
      to:      session.email,
      subject: 'AlgoBot — Verify to view API keys',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#030712;color:#f9fafb;border-radius:16px;">
          <h2 style="color:#1D9E75;margin:0 0 6px;">AlgoBot</h2>
          <p style="color:#9ca3af;margin:0 0 8px;font-size:14px;">Someone (hopefully you) requested to view stored API keys.</p>
          <p style="color:#6b7280;margin:0 0 20px;font-size:13px;">If this wasn't you, ignore this email — your keys are safe.</p>
          <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;text-align:center;letter-spacing:10px;font-size:36px;font-weight:700;color:#1D9E75;">
            ${otp}
          </div>
          <p style="color:#6b7280;font-size:12px;margin-top:16px;">
            Expires in <strong style="color:#9ca3af;">5 minutes</strong>. Single use only.
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('Failed to send reveal OTP email:', err)
    return NextResponse.json({ error: 'Failed to send OTP email' }, { status: 500 })
  }

  return NextResponse.json({ success: true, email: session.email })
}
