import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// ─── Access Code Rate Limiting ────────────────────────────────────────────────
const LOCKOUT_DURATION = 30 * 60        // 30 minutes in seconds
const MAX_ATTEMPTS     = 3

export async function checkIpLockout(ip: string): Promise<boolean> {
  const key = `lockout:${ip}`
  const locked = await redis.get(key)
  return !!locked
}

export async function recordFailedAttempt(ip: string): Promise<number> {
  const attemptsKey = `attempts:${ip}`
  const attempts = await redis.incr(attemptsKey)
  await redis.expire(attemptsKey, LOCKOUT_DURATION)

  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(`lockout:${ip}`, '1', { ex: LOCKOUT_DURATION })
  }
  return attempts
}

export async function clearAttempts(ip: string): Promise<void> {
  await redis.del(`attempts:${ip}`)
  await redis.del(`lockout:${ip}`)
}

// ─── OTP Storage ──────────────────────────────────────────────────────────────
const OTP_EXPIRY = 5 * 60  // 5 minutes

export async function storeOtp(email: string, otp: string): Promise<void> {
  await redis.set(`otp:${email}`, otp, { ex: OTP_EXPIRY })
}

export async function verifyOtp(email: string, otp: string): Promise<boolean> {
  const raw = await redis.get(`otp:${email}`)
  if (raw == null) return false
  const stored = String(raw).trim()
  if (stored !== String(otp).trim()) return false
  await redis.del(`otp:${email}`) // burn after use
  return true
}

// ─── Access Code Temp Validation ─────────────────────────────────────────────
export async function markAccessCodeValidated(ip: string): Promise<void> {
  await redis.set(`access_validated:${ip}`, '1', { ex: 30 * 60 })
}

export async function isAccessCodeValidated(ip: string): Promise<boolean> {
  const val = await redis.get(`access_validated:${ip}`)
  return !!val
}