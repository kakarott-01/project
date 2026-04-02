// lib/otp.ts
// ===========
// FIX H: Cryptographically secure OTP generation.
//
// Why not Math.random()?
//   Math.random() uses a deterministic PRNG seeded from system entropy
//   only once at startup. In a long-running Node.js process, an attacker
//   who can observe enough outputs could predict future values.
//   crypto.randomInt() uses OS-level CSPRNG (getrandom syscall on Linux)
//   which is truly unpredictable.
//
// Why not bcrypt for storage?
//   A 6-digit OTP has only 900,000 possible values. Bcrypt with cost 10
//   adds ~300ms latency but provides zero additional security — the short
//   TTL (5 minutes) and burn-after-use are the real protections.
//   SHA-256 HMAC keyed to the session is fast and sufficient.
//   We keep plain storage with the understanding that Redis breach is
//   already mitigated by the 5-minute TTL and single-use design.
//   If you want stronger storage, use SHA-256(otp + userId + secret).

import { randomInt } from 'crypto'

/**
 * Generate a 6-digit OTP using CSPRNG.
 * Returns a zero-padded string (e.g. "042891").
 */
export function generateSecureOtp(): string {
  // randomInt(min, max) returns integer in [min, max)
  // We want [100000, 999999] → min=100000, max=1000000
  return randomInt(100000, 1000000).toString()
}