import { cookies }         from 'next/headers'
import { getServerSession } from 'next-auth/next'
import { authOptions }      from '@/lib/auth-options'
import { verifySession }    from '@/lib/signed-cookie'  // FIX: HMAC-verified parse

export async function auth() {
  const cookieStore   = cookies()
  const sessionCookie = cookieStore.get('user_session')?.value

  const signed = verifySession(sessionCookie)
  if (signed?.id && signed?.email) {
    return {
      ...signed,
      user: {
        id:    signed.id,
        email: signed.email,
        name:  signed.name,
      },
    }
  }

  // ── NextAuth JWT path (Google OAuth login) ────────────────────────────────
  const nextAuthSession = await getServerSession(authOptions)
  if (!nextAuthSession?.user?.email) return null

  const userId   = (nextAuthSession.user as any).id as string | undefined
  const userName = nextAuthSession.user.name ?? nextAuthSession.user.email.split('@')[0]

  if (!userId) return null

  return {
    id:    userId,
    email: nextAuthSession.user.email,
    name:  userName,
    user: {
      id:    userId,
      email: nextAuthSession.user.email,
      name:  userName,
      image: nextAuthSession.user.image,
    },
  }
}
