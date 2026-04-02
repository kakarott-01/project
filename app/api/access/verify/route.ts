// app/api/access/verify/route.ts
// FIX D: Replace in-memory Map rate limiting with Redis
//         (in-memory Map resets on every Vercel cold start)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { accessCodes, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { getClientIp } from '@/lib/utils'
import { getToken } from 'next-auth/jwt'
import { redis } from '@/lib/redis'

const MAX_ATTEMPTS     = 3
const LOCKOUT_DURATION = 30 * 60  // 30 minutes in seconds

// ── Redis-based rate limiting ─────────────────────────────────────────────────
// Keys:
//   access_attempts:{ip}    → number of failed attempts (expires after lockout duration)
//   access_locked:{ip}      → exists if locked (same TTL)

async function checkLockout(ip: string): Promise<boolean> {
  const locked = await redis.get(`access_locked:${ip}`)
  return locked !== null
}

async function recordFail(ip: string): Promise<number> {
  const attemptsKey = `access_attempts:${ip}`

  // INCR returns new value; set expiry only on first attempt (NX) or refresh
  const attempts = await redis.incr(attemptsKey)

  // Keep the counter alive for the lockout window
  await redis.expire(attemptsKey, LOCKOUT_DURATION)

  if (attempts >= MAX_ATTEMPTS) {
    // Set lockout key — this is what checkLockout reads
    await redis.set(`access_locked:${ip}`, '1', { ex: LOCKOUT_DURATION })
  }

  return MAX_ATTEMPTS - attempts
}

async function clearRateLimit(ip: string): Promise<void> {
  await redis.del(`access_attempts:${ip}`)
  await redis.del(`access_locked:${ip}`)
}

export async function POST(req: NextRequest) {
  try {
    // 1. Validate session
    const token = await getToken({
      req,
      secret: process.env.NEXTAUTH_SECRET,
    })

    if (!token?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Get IP + check lockout (Redis-backed, survives cold starts)
    const ip = getClientIp(req)
    const locked = await checkLockout(ip)

    if (locked) {
      return NextResponse.json(
        { error: 'Too many attempts. Try again in 30 minutes.' },
        { status: 429 }
      )
    }

    // 3. Get code from body
    const body = await req.json()
    const code = body?.code?.toUpperCase().trim()

    if (!code) {
      return NextResponse.json({ error: 'Code is required' }, { status: 400 })
    }

    // 4. Fetch valid (not burned) codes
    const validCodes = await db.query.accessCodes.findMany({
      where: eq(accessCodes.isBurned, false),
    })

    let matchedCode = null

    // 5. Compare hashed codes
    for (const c of validCodes) {
      if (c.expiresAt < new Date()) continue

      const isMatch = await bcrypt.compare(code, c.code)
      if (isMatch) {
        matchedCode = c
        break
      }
    }

    // 6. Invalid code
    if (!matchedCode) {
      const remaining = await recordFail(ip)

      return NextResponse.json(
        {
          error: 'Invalid or expired code',
          attemptsRemaining: Math.max(0, remaining),
        },
        { status: 401 }
      )
    }

    // 7. Burn the code
    await db
      .update(accessCodes)
      .set({
        isBurned:    true,
        burnedAt:    new Date(),
        burnedByIp:  ip,
        usedByEmail: token.email,
      })
      .where(eq(accessCodes.id, matchedCode.id))

    // 8. Whitelist user
    await db
      .update(users)
      .set({ isWhitelisted: true })
      .where(eq(users.email, token.email))

    // 9. Clear rate limit on success
    await clearRateLimit(ip)

    console.info(`✅ Access granted → ${token.email}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('verify-access error:', error)

    return NextResponse.json(
      { error: 'Server error' },
      { status: 500 }
    )
  }
}