"use client"

import { apiFetch } from '@/lib/api-client'

export default function useModeOtp() {
  async function sendOtp() {
    return apiFetch('/api/mode/send-otp', { method: 'POST' })
  }

  async function verifyOtp(code: string) {
    return apiFetch('/api/mode/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp: code }),
    })
  }

  return { sendOtp, verifyOtp }
}
