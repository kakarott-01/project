import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { backtestRuns } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const run = await db.query.backtestRuns.findFirst({
    where: and(
      eq(backtestRuns.id, params.id),
      eq(backtestRuns.userId, session.id),
    ),
  })

  if (!run) return NextResponse.json({ error: 'Backtest not found.' }, { status: 404 })
  return NextResponse.json(run)
}
