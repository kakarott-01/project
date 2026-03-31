// app/api/bot/complete-stop/route.ts
// ====================================
// Called INTERNALLY by the bot engine (Python) when it has finished
// draining or closing all positions and is ready to fully stop.
//
// This is NOT a user-facing endpoint. It is protected by X-Bot-Secret.
// The engine calls this so that:
//   1. DB status transitions from 'stopping' → 'stopped'
//   2. Bot sessions are closed with final stats
//
// We use a separate endpoint (not reusing /stop) to avoid auth complexity
// and to clearly separate user-initiated vs engine-initiated transitions.

import { NextRequest, NextResponse } from 'next/server'
import { _doImmediateStop } from '@/app/api/bot/stop/route'

export async function POST(req: NextRequest) {
  // Verify the request is from the bot engine, not a user
  const secret = req.headers.get('x-bot-secret')
  if (!secret || secret !== process.env.BOT_ENGINE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let userId: string
  try {
    const body = await req.json()
    userId = body?.user_id
    if (!userId) throw new Error('missing user_id')
  } catch {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  await _doImmediateStop(userId, new Date())

  return NextResponse.json({ success: true, status: 'stopped' })
}