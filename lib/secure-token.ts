// lib/secure-token.ts
// ====================
// HMAC-signed short-lived tokens to replace the forgeable
// base64(userId:timestamp) tokens used in:
//   - reveal_token (view API keys)
//   - mode_switch_token (paper→live)
//
// Why HMAC instead of JWT here?
//   These tokens are set as httpOnly cookies and only need to carry
//   {userId, issuedAt, type}. Full JWT is fine too but HMAC-SHA256
//   is simpler, produces shorter values, and avoids the jsonwebtoken
//   dependency for a cookie that lives 5 minutes.
//
// Format: base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret))
// Payload: JSON { userId, issuedAt, type }

import { createHmac, timingSafeEqual } from 'crypto'

const TOKEN_SECRET = process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY
if (!TOKEN_SECRET) {
  throw new Error('NEXTAUTH_SECRET or ENCRYPTION_KEY must be set')
}

export type TokenType = 'reveal' | 'mode_switch'

interface TokenPayload {
  userId:    string
  issuedAt:  number    // Unix ms
  type:      TokenType
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function sign(data: string): string {
  return createHmac('sha256', TOKEN_SECRET!).update(data).digest('base64url')
}

/**
 * Issue a signed token for the given user and purpose.
 * Default TTL: 5 minutes (suitable for OTP-gated actions).
 */
export function issueSecureToken(userId: string, type: TokenType): string {
  const payload: TokenPayload = {
    userId,
    issuedAt: Date.now(),
    type,
  }
  const encoded = b64url(Buffer.from(JSON.stringify(payload)))
  const sig     = sign(encoded)
  return `${encoded}.${sig}`
}

export type VerifyResult =
  | { ok: true;  userId: string }
  | { ok: false; reason: string }

/**
 * Verify a token.
 * Returns { ok: true, userId } on success.
 * Returns { ok: false, reason } for any failure.
 *
 * TTL: 5 minutes (300_000 ms)
 */
export function verifySecureToken(
  token:    string,
  type:     TokenType,
  ttlMs:    number = 5 * 60 * 1000,
): VerifyResult {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'Missing token' }
  }

  const parts = token.split('.')
  if (parts.length !== 2) {
    return { ok: false, reason: 'Malformed token' }
  }

  const [encoded, providedSig] = parts

  // Timing-safe signature comparison
  const expectedSig = sign(encoded)
  try {
    const a = Buffer.from(providedSig, 'base64url')
    const b = Buffer.from(expectedSig, 'base64url')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: 'Invalid signature' }
    }
  } catch {
    return { ok: false, reason: 'Invalid signature' }
  }

  // Decode payload
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'Malformed payload' }
  }

  // Type check
  if (payload.type !== type) {
    return { ok: false, reason: `Wrong token type: expected ${type}, got ${payload.type}` }
  }

  // Expiry check
  if (Date.now() - payload.issuedAt > ttlMs) {
    return { ok: false, reason: 'Token expired' }
  }

  if (!payload.userId) {
    return { ok: false, reason: 'Missing userId in payload' }
  }

  return { ok: true, userId: payload.userId }
}