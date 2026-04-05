/**
 * lib/signed-cookie.ts  — NEW
 * ============================
 * FIX: Replaces the unsigned JSON session cookie (vulnerable to forgery via
 *      XSS / cookie manipulation) with an HMAC-SHA256 signed value.
 *
 * Cookie format: "<base64url(payload)>.<base64url(HMAC-SHA256(payload, secret))>"
 *
 * Legacy unsigned cookies are intentionally rejected.
 */

import { createHmac, timingSafeEqual } from 'crypto'

const SECRET = process.env.NEXTAUTH_SECRET ?? process.env.ENCRYPTION_KEY
if (!SECRET) {
  throw new Error('NEXTAUTH_SECRET or ENCRYPTION_KEY must be set for signed cookies')
}

export interface SessionPayload {
  id:    string
  email: string
  name:  string
}

// ── Sign ──────────────────────────────────────────────────────────────────────

/**
 * Produce a signed cookie value for the given session payload.
 * Store this as the user_session cookie (httpOnly + secure + sameSite=lax).
 */
export function signSession(payload: SessionPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = _sign(data)
  return `${data}.${sig}`
}

// ── Verify ────────────────────────────────────────────────────────────────────

/**
 * Verify and decode a signed session cookie.
 * Returns the payload on success, null on any failure (bad sig, malformed, etc.).
 *
 * Legacy unsigned cookies are rejected.
 */
export function verifySession(cookie: string | undefined): SessionPayload | null {
  if (!cookie) return null

  const dotIdx = cookie.lastIndexOf('.')
  if (dotIdx <= 0) return null

  const data = cookie.slice(0, dotIdx)
  const sig  = cookie.slice(dotIdx + 1)
  return _verifySignedParts(data, sig)
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _sign(data: string): string {
  return createHmac('sha256', SECRET!).update(data).digest('base64url')
}

function _verifySignedParts(data: string, providedSig: string): SessionPayload | null {
  const expectedSig = _sign(data)
  try {
    const a = Buffer.from(providedSig, 'base64url')
    const b = Buffer.from(expectedSig, 'base64url')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  } catch {
    return null
  }
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload
  } catch {
    return null
  }
}
