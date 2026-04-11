import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { verifySessionCookieEdge } from '@/lib/signed-cookie-edge'

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // ✅ Public routes
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/access')
  ) {
    return NextResponse.next()
  }

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  })

  const cookieSession = await verifySessionCookieEdge(req.cookies.get('user_session')?.value)

  const tokenSession = token
    ? {
        id: (token.id as string | undefined) ?? token.sub ?? '',
        hasAccess: token.hasAccess as boolean | undefined,
      }
    : null

  // prefer a fresh JWT/token-derived session over an older cookie session
  const session = tokenSession ?? cookieSession

  // ❌ Not logged in → LOGIN
  if (!session?.id) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // ❌ Logged in but NO access → ACCESS page
  if (session.hasAccess === false && pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/access', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*'], // ✅ ONLY protect dashboard
}
