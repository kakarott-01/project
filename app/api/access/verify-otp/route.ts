import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { verifySignupToken } from '@/lib/jwt'
import { db } from '@/lib/db'
import { accessCodes } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { redis } from '@/lib/redis'

const sql = neon(process.env.DATABASE_URL!)

export async function POST(req: NextRequest) {
  try {
    const { email, otp } = await req.json()
    if (!email || !otp) {
      return NextResponse.json({ error: 'Email and OTP required' }, { status: 400 })
    }

    const normalizedEmail = email.toLowerCase().trim()

    // ── Verify OTP from Redis ──────────────────────────────────────────────────
    // IMPORTANT: Upstash Redis may deserialize a stored numeric string (e.g. "123456")
    // as a JS number (123456). Always coerce to string before comparing.
    const raw = await redis.get(`login_otp:${normalizedEmail}`)

    if (raw === null || raw === undefined) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 })
    }

    const stored   = String(raw).trim()
    const provided = String(otp).trim()

    if (stored !== provided) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 })
    }

    // Burn after use
    await redis.del(`login_otp:${normalizedEmail}`)

    // Find existing user
    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`
    let userId: string

    const signupToken = req.cookies.get('signup_token')?.value

    if (existing.length > 0) {
      if (signupToken) {
        return NextResponse.json({ error: 'User already exists. Please login.' }, { status: 409 })
      }

      userId = existing[0].id
      await sql`UPDATE users SET last_login_at = now() WHERE email = ${normalizedEmail}`
    } else {
      if (!signupToken) {
        return NextResponse.json({ error: 'Access code expired. Please verify again.' }, { status: 403 })
      }

      let payload
      try {
        payload = verifySignupToken(signupToken)
      } catch (err) {
        console.warn('Invalid signup token:', err)
        return NextResponse.json({ error: 'Access code expired. Please verify again.' }, { status: 403 })
      }

      const codeRecord = await db.query.accessCodes.findFirst({
        where: eq(accessCodes.id, payload.accessCodeId),
      })

      if (!codeRecord || !codeRecord.isBurned) {
        return NextResponse.json({ error: 'Access code expired. Please verify again.' }, { status: 403 })
      }

      const newUser = await sql`
        INSERT INTO users (id, email, name, is_whitelisted, is_active, created_at)
        VALUES (gen_random_uuid(), ${normalizedEmail}, ${normalizedEmail.split('@')[0]}, true, true, now())
        RETURNING id
      `
      userId = newUser[0].id
      console.info(`✅ New user created: ${normalizedEmail}`)

      const postResponse = NextResponse.json({ success: true })
      postResponse.cookies.delete('signup_token')
      postResponse.cookies.set('user_session', JSON.stringify({
        id:    userId,
        email: normalizedEmail,
        name:  normalizedEmail.split('@')[0],
      }), {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        maxAge:   30 * 24 * 60 * 60,
        path:     '/',
        sameSite: 'lax',
      })

      return postResponse
    }

    // Set session cookie
    const response = NextResponse.json({ success: true })
    response.cookies.set('user_session', JSON.stringify({
      id:    userId,
      email: normalizedEmail,
      name:  normalizedEmail.split('@')[0],
    }), {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   30 * 24 * 60 * 60,
      path:     '/',
      sameSite: 'lax',
    })

    response.cookies.delete('signup_token')

    return response
  } catch (error) {
    console.error('verify-otp error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}