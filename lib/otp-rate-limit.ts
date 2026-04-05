import { redis } from '@/lib/redis'

const MAX_ATTEMPTS = 5
const WINDOW_SEC = 15 * 60
const LOCKOUT_SEC = 30 * 60

type MemoryEntry = {
  attempts: number
  windowEnd: number
  lockedUntil?: number
}

const memoryStore = new Map<string, MemoryEntry>()

export type OtpVerifyLimitResult =
  | { allowed: true; redisDown: boolean }
  | {
      allowed: false
      redisDown: boolean
      reason: 'locked' | 'exceeded'
      retryAfterSec: number
    }

export async function checkOtpVerifyLimit(identifier: string): Promise<OtpVerifyLimitResult> {
  const key = `otp_verify_limit:${identifier}`
  const lockKey = `otp_verify_lock:${identifier}`
  const nowMs = Date.now()

  try {
    const locked = await redis.get(lockKey)
    if (locked) {
      const ttl = await redis.ttl(lockKey)
      return {
        allowed: false,
        redisDown: false,
        reason: 'locked',
        retryAfterSec: Math.max(ttl, 0),
      }
    }

    const attempts = await redis.incr(key)
    if (attempts === 1) {
      await redis.expire(key, WINDOW_SEC)
    }

    if (attempts > MAX_ATTEMPTS) {
      await redis.set(lockKey, '1', { ex: LOCKOUT_SEC })
      await redis.del(key)
      return {
        allowed: false,
        redisDown: false,
        reason: 'exceeded',
        retryAfterSec: LOCKOUT_SEC,
      }
    }

    return { allowed: true, redisDown: false }
  } catch {
    const entry = memoryStore.get(identifier)

    if (entry?.lockedUntil && nowMs < entry.lockedUntil) {
      return {
        allowed: false,
        redisDown: true,
        reason: 'locked',
        retryAfterSec: Math.ceil((entry.lockedUntil - nowMs) / 1000),
      }
    }

    const fresh = !entry || nowMs > entry.windowEnd
    const next: MemoryEntry = fresh
      ? { attempts: 1, windowEnd: nowMs + WINDOW_SEC * 1000 }
      : { ...entry, attempts: entry.attempts + 1 }

    if (next.attempts > MAX_ATTEMPTS) {
      next.lockedUntil = nowMs + LOCKOUT_SEC * 1000
      memoryStore.set(identifier, next)
      return {
        allowed: false,
        redisDown: true,
        reason: 'exceeded',
        retryAfterSec: LOCKOUT_SEC,
      }
    }

    memoryStore.set(identifier, next)
    return { allowed: true, redisDown: true }
  }
}

export async function resetOtpVerifyLimit(identifier: string): Promise<void> {
  const key = `otp_verify_limit:${identifier}`
  const lockKey = `otp_verify_lock:${identifier}`

  try {
    await Promise.all([redis.del(key), redis.del(lockKey)])
  } catch {
    // best effort
  }

  memoryStore.delete(identifier)
}

export function otpVerifyLimitMessage(retryAfterSec: number): string {
  const mins = Math.max(1, Math.ceil(retryAfterSec / 60))
  return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
}
