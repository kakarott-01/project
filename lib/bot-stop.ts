import { db } from '@/lib/db'
import { botStatuses, botSessions, trades } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'

export async function _doImmediateStop(userId: string, now: Date) {
  fetch(`${process.env.BOT_ENGINE_URL}/bot/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bot-Secret': process.env.BOT_ENGINE_SECRET!,
    },
    body: JSON.stringify({ user_id: userId }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)

  const runningSessions = await db.query.botSessions.findMany({
    where: and(
      eq(botSessions.userId, userId),
      sql`${botSessions.status} IN ('running', 'stopping')`,
    ),
  })

  for (const s of runningSessions) {
    const stats = await db
      .select({
        total:  sql<number>`count(*)::int`,
        open:   sql<number>`count(*) filter (where status='open')::int`,
        closed: sql<number>`count(*) filter (where status='closed')::int`,
        pnl:    sql<number>`coalesce(sum(pnl) filter (where status='closed'),0)::float`,
      })
      .from(trades)
      .where(and(
        eq(trades.userId, userId),
        eq(trades.marketType, s.market as any),
        sql`${trades.openedAt} >= ${s.startedAt}`,
      ))

    const row = stats[0]
    await db.update(botSessions)
      .set({
        status:       'stopped',
        endedAt:      now,
        totalTrades:  row?.total  ?? 0,
        openTrades:   row?.open   ?? 0,
        closedTrades: row?.closed ?? 0,
        totalPnl:     String(row?.pnl ?? 0),
      })
      .where(eq(botSessions.id, s.id))
  }

  await db.update(botStatuses)
    .set({
      status:     'stopped',
      stoppedAt:  now,
      updatedAt:  now,
      stopMode:   null,
      stoppingAt: null,
    })
    .where(eq(botStatuses.userId, userId))
}