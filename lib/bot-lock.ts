// lib/bot-lock.ts
// ================
// Redis-based distributed lock for bot start/stop operations.
// Prevents duplicate bot instances across multiple serverless workers.
//
// Uses SETNX (SET if Not eXists) + expiry for safe distributed locking.
// Lock is automatically released after TTL even if the process crashes.

import { redis } from '@/lib/redis'

const LOCK_TTL_SECONDS = 30  // max time a start/stop operation should take

export type LockResult =
  | { acquired: true;  release: () => Promise<void> }
  | { acquired: false; reason: string }

/**
 * Attempt to acquire a per-user bot operation lock.
 *
 * Usage:
 *   const lock = await acquireBotLock(userId, 'start')
 *   if (!lock.acquired) return { error: lock.reason }
 *   try { ... } finally { await lock.release() }
 */
export async function acquireBotLock(
  userId: string,
  operation: 'start' | 'stop' | 'close_all',
  ttlSeconds = LOCK_TTL_SECONDS,
): Promise<LockResult> {
  const key   = `bot_lock:${userId}`
  const value = `${operation}:${Date.now()}`

  // NX = only set if key doesn't exist, EX = expire after ttlSeconds
  const result = await redis.set(key, value, { nx: true, ex: ttlSeconds })

  if (result === null) {
    // Key already exists → another operation is in progress
    const existing = await redis.get<string>(key)
    const opName   = existing?.split(':')[0] ?? 'unknown'
    return {
      acquired: false,
      reason:   `Bot is already being ${opName === 'start' ? 'started' : 'stopped'} — please wait.`,
    }
  }

  return {
    acquired: true,
    release:  async () => {
      // Only delete if we still own the lock (value matches)
      const current = await redis.get<string>(key)
      if (current === value) {
        await redis.del(key)
      }
    },
  }
}

/**
 * Force-release a lock (emergency use only — admin/cleanup).
 */
export async function forceReleaseBotLock(userId: string): Promise<void> {
  await redis.del(`bot_lock:${userId}`)
}

/**
 * Check if any lock is held for a user (read-only).
 */
export async function isBotLocked(userId: string): Promise<boolean> {
  const val = await redis.get(`bot_lock:${userId}`)
  return val !== null
}