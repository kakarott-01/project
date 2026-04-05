import { db } from '@/lib/db'
import { botStatuses } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function assertBotStoppedForSensitiveMutation(
  userId: string,
  errorMessage = 'Stop the bot before changing this configuration.',
) {
  const status = await db.query.botStatuses.findFirst({
    where: eq(botStatuses.userId, userId),
    columns: { status: true },
  })

  if (status?.status === 'running' || status?.status === 'stopping') {
    const error = new Error(errorMessage)
    ;(error as Error & { status?: number }).status = 409
    throw error
  }
}
