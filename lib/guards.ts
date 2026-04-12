import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/schema'

type HttpError = Error & { status?: number }

export function createHttpError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError
  error.status = status
  return error
}

export function guardErrorResponse(error: unknown) {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 500

  const message = error instanceof Error ? error.message : 'Server error'
  return NextResponse.json({ error: message }, { status })
}

export async function requireAccess() {
  const session = await auth()
  if (!session?.id) {
    throw createHttpError('Unauthorized', 401)
  }

  // If `auth()` already computed `hasAccess`, trust that value and skip
  // an extra DB lookup to avoid an additional round-trip per request.
  if (typeof session.hasAccess === 'boolean') {
    if (!session.hasAccess) {
      throw createHttpError('Access denied', 403)
    }

    return session
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.id),
    columns: { isWhitelisted: true },
  })

  if (!user?.isWhitelisted) {
    throw createHttpError('Access denied', 403)
  }

  return {
    ...session,
    hasAccess: true,
  }
}
