// lib/bot-lock.ts
// ================
// F7 FIX: Distinguish Redis connection failure from lock contention.
//
// Before this fix, any Redis error (including network outage) caused
// acquireBotLock to throw, which bubbled up as a 500 error. This meant
// users could not stop the bot if Redis was temporarily down — the bot
// kept running with no way to halt it.
//
// Fix: acquireBotLock now returns a third result type { acquired: false,
// isRedisDown: true } when the Redis call itself fails. Callers handle
// this differently per operation:
//   - START: refuse (starting without lock is unsafe — could create duplicates)
//   - STOP:  allow (stopping is always safe, worst case is a no-op)
//   - complete-stop: allow (same reasoning as stop)
//
// The release() function on a Redis-down lock is a no-op (nothing to release).

import { redis } from '@/lib/redis'

const LOCK_TTL_SECONDS = 30

export type LockResult =
  | { acquired: true;  isRedisDown: false; release: () => Promise<void> }
  | { acquired: false; isRedisDown: false; reason: string }
  | { acquired: false; isRedisDown: true;  reason: string }

/**
 * Attempt to acquire a per-user bot operation lock.
 *
 * Usage:
 *   const lock = await acquireBotLock(userId, 'start')
 *   if (!lock.acquired) {
 *     if (lock.isRedisDown && operation === 'stop') {
 *       // proceed without lock — stopping is safe
 *     } else {
 *       return { error: lock.reason }
 *     }
 *   }
 *   try { ... } finally {
 *     if (lock.acquired) await lock.release()
 *   }
 */
export async function acquireBotLock(
  userId: string,
  operation: 'start' | 'stop' | 'close_all',
  ttlSeconds = LOCK_TTL_SECONDS,
): Promise<LockResult> {
  const key   = `bot_lock:${userId}`
  const value = `${operation}:${Date.now()}`

  let result: string | null
  try {
    // NX = only set if key doesn't exist, EX = expire after ttlSeconds
    result = await redis.set(key, value, { nx: true, ex: ttlSeconds })
  } catch (redisError) {
    // Redis is unreachable — not a lock contention, a connection failure.
    console.error(`[bot-lock] Redis connection error for user=${userId}:`, redisError)
    return {
      acquired:    false,
      isRedisDown: true,
      reason:      'Redis is temporarily unavailable. Lock could not be acquired.',
    }
  }

  if (result === null) {
    // Key already exists → another operation is in progress (lock contention)
    let existingOp = 'unknown'
    try {
      const existing = await redis.get<string>(key)
      existingOp = existing?.split(':')[0] ?? 'unknown'
    } catch {
      // Best-effort — don't fail if we can't read the existing lock details
    }
    return {
      acquired:    false,
      isRedisDown: false,
      reason:      `Bot is already being ${existingOp === 'start' ? 'started' : 'stopped'} — please wait.`,
    }
  }

  return {
    acquired:    true,
    isRedisDown: false,
    release: async () => {
      try {
        const current = await redis.get<string>(key)
        if (current === value) {
          await redis.del(key)
        }
      } catch (releaseError) {
        // Redis down during release — lock will expire via TTL automatically.
        // This is safe: the TTL ensures the lock is never held permanently.
        console.warn(`[bot-lock] Could not release lock for user=${userId} (will expire via TTL):`, releaseError)
      }
    },
  }
}

/**
 * Force-release a lock (emergency use only — admin/cleanup).
 */
export async function forceReleaseBotLock(userId: string): Promise<void> {
  try {
    await redis.del(`bot_lock:${userId}`)
  } catch (e) {
    console.warn(`[bot-lock] Force-release failed for user=${userId}:`, e)
  }
}

/**
 * Check if any lock is held for a user (read-only).
 * Returns false if Redis is down (conservative: assume not locked).
 */
export async function isBotLocked(userId: string): Promise<boolean> {
  try {
    const val = await redis.get(`bot_lock:${userId}`)
    return val !== null
  } catch {
    return false
  }
}