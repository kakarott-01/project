// ═══════════════════════════════════════════════════════════════════════════════
// app/api/access/verify/route.ts  — FIXED
// ═══════════════════════════════════════════════════════════════════════════════
// FIX (medium): Replaced O(n) bcrypt comparison (one bcrypt.compare per code)
//      with SHA-256 pre-filtering.
//
//      How it works:
//        - When an access code is created (admin side), store both:
//            code  = bcrypt(rawCode)          ← existing, for security
//            codeSha256 = SHA-256(rawCode.toUpperCase())  ← NEW, for fast lookup
//        - On verification:
//            1. SHA-256 the input → look up by codeSha256 → O(1) DB lookup
//            2. bcrypt.compare just that one candidate  → O(1) bcrypt
//
//      MIGRATION REQUIRED for existing codes:
//        UPDATE access_codes SET code_sha256 = encode(sha256(UPPER(plain_code)::bytea), 'hex')
//        (You'll need to know the plain codes to backfill — or just burn old ones and recreate.)
//
//      SCHEMA MIGRATION (run in Neon console):
//        ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS code_sha256 varchar(64);
//        CREATE INDEX IF NOT EXISTS idx_access_codes_sha256 ON access_codes(code_sha256)
//          WHERE is_burned = false;
//
//      FALLBACK: If code_sha256 is not yet populated for a code, we fall back
//      to the old O(n) loop so nothing breaks during the migration window.
// ═══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { db }                         from '@/lib/db'
import { accessCodes, users }         from '@/lib/schema'
import { eq, and }                    from 'drizzle-orm'
import bcrypt                          from 'bcryptjs'
import { createHash }                  from 'crypto'
import { getClientIp }                 from '@/lib/utils'
import { auth }                        from '@/lib/auth'
import { redis }                       from '@/lib/redis'

const MAX_ATTEMPTS     = 3
const LOCKOUT_DURATION = 30 * 60

async function checkLockout(ip: string): Promise<boolean> {
  const locked = await redis.get(`access_locked:${ip}`)
  return locked !== null
}

async function recordFail(ip: string): Promise<number> {
  const attemptsKey = `access_attempts:${ip}`
  const attempts    = await redis.incr(attemptsKey)
  await redis.expire(attemptsKey, LOCKOUT_DURATION)
  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(`access_locked:${ip}`, '1', { ex: LOCKOUT_DURATION })
  }
  return MAX_ATTEMPTS - attempts
}

async function clearRateLimit(ip: string): Promise<void> {
  await redis.del(`access_attempts:${ip}`)
  await redis.del(`access_locked:${ip}`)
}

/** Compute SHA-256 hex of the normalised code string. */
function codeSha256(code: string): string {
  return createHash('sha256').update(code.toUpperCase()).digest('hex')
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const ip     = getClientIp(req)
    const locked = await checkLockout(ip)
    if (locked) {
      return NextResponse.json({ error: 'Too many attempts. Try again in 30 minutes.' }, { status: 429 })
    }

    const body = await req.json().catch(() => ({}))
    const code = body?.code?.toUpperCase().trim()
    if (!code) {
      return NextResponse.json({ error: 'Code is required' }, { status: 400 })
    }

    const sha = codeSha256(code)
    let matchedCode = null

    // ── Fast path: O(1) lookup via SHA-256 index ──────────────────────────────
    const fastMatch = await db.query.accessCodes.findFirst({
      where: and(
        eq(accessCodes.isBurned, false),
        eq((accessCodes as any).codeSha256, sha),   // new column
      ),
    }).catch(() => null)   // column may not exist yet — fall through to O(n)

    if (fastMatch) {
      // Still verify expiry and bcrypt (defence in depth)
      if (fastMatch.expiresAt > new Date()) {
        const isMatch = await bcrypt.compare(code, fastMatch.code)
        if (isMatch) matchedCode = fastMatch
      }
    }

    // ── Slow fallback: O(n) bcrypt loop for codes without sha256 column ───────
    if (!matchedCode) {
      const allValid = await db.query.accessCodes.findMany({
        where: eq(accessCodes.isBurned, false),
      })

      // Safety cap: if there are somehow hundreds of codes, refuse rather
      // than doing hundreds of bcrypt ops in a single serverless invocation.
      if (allValid.length > 50) {
        console.error(`[access/verify] Too many active codes (${allValid.length}) — refusing O(n) scan`)
        return NextResponse.json({ error: 'Server error' }, { status: 500 })
      }

      for (const c of allValid) {
        // Skip codes that have a sha256 (already tried those above)
        if ((c as any).codeSha256) continue
        if (c.expiresAt < new Date()) continue
        const isMatch = await bcrypt.compare(code, c.code)
        if (isMatch) { matchedCode = c; break }
      }
    }

    if (!matchedCode) {
      const remaining = await recordFail(ip)
      return NextResponse.json(
        { error: 'Invalid or expired code', attemptsRemaining: Math.max(0, remaining) },
        { status: 401 }
      )
    }

    // Burn the code
    await db.update(accessCodes)
      .set({ isBurned: true, burnedAt: new Date(), burnedByIp: ip, usedByEmail: session.email })
      .where(eq(accessCodes.id, matchedCode.id))

    // Whitelist user
    await db.update(users)
      .set({ isWhitelisted: true })
      .where(eq(users.email, session.email))

    await clearRateLimit(ip)
    console.info(`✅ Access granted → ${session.email}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('verify-access error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
