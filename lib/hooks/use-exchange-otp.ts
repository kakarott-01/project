"use client"

import { apiFetch } from '@/lib/api-client'

export type RevealedKeys = {
  apiKey: string
  apiSecret: string
  extra: Record<string, string>
}

export default function useExchangeOtp() {
  async function sendOtp() {
    return apiFetch('/api/exchange/send-reveal-otp', { method: 'POST' })
  }

  async function verifyOtp(otp: string) {
    return apiFetch('/api/exchange/verify-reveal-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp }),
    })
  }

  async function reveal(marketType: string, exchangeName: string) {
    return apiFetch<RevealedKeys>('/api/exchange/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketType, exchangeName }),
    })
  }

  return { sendOtp, verifyOtp, reveal }
}
