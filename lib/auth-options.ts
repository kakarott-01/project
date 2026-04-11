import { type NextAuthOptions, type DefaultSession } from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import { db } from "@/lib/db"
import { users } from "@/lib/schema"
import { eq } from "drizzle-orm"

// ✅ Extend Session
declare module "next-auth" {
  interface Session {
    user: {
      id: string
      email: string
      name: string
      image?: string
      hasAccess: boolean
    } & DefaultSession["user"]
  }
}

// ✅ Extend JWT
declare module "next-auth/jwt" {
  interface JWT {
    id?: string
    email?: string
    name?: string
    picture?: string
    hasAccess?: boolean
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  secret: process.env.NEXTAUTH_SECRET,

  session: {
    strategy: "jwt",
  },

  // Use our custom client-side login page instead of NextAuth's default HTML page
  pages: {
    signIn: '/login',
  },

  callbacks: {
    async signIn() {
      return true
    },

    async jwt({ token, user }) {
      try {
        if (user?.email) {
          let dbUser = await db.query.users.findFirst({
            where: eq(users.email, user.email),
          })

          if (!dbUser) {
            const [newUser] = await db
              .insert(users)
              .values({
                email: user.email,
                name: user.name || user.email.split("@")[0],
                googleId: user.id,
                isWhitelisted: false,
              })
              .returning()

            dbUser = newUser
          }

          token.id = dbUser.id
          token.email = dbUser.email
          token.name = dbUser.name || dbUser.email.split("@")[0]
          token.picture = user.image ?? undefined
          token.hasAccess = dbUser.isWhitelisted ?? false
        }

        if (token.email) {
          const dbUser = await db.query.users.findFirst({
            where: eq(users.email, token.email),
          })

          if (dbUser) {
            token.hasAccess = dbUser.isWhitelisted ?? false
          }
        }

        return token
      } catch (err) {
        console.error("JWT ERROR:", err)
        return token
      }
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id ?? ""
        session.user.email = token.email ?? ""
        session.user.name = token.name ?? ""
        session.user.image = token.picture
        session.user.hasAccess = token.hasAccess ?? false
      }
      return session
    },

    async redirect({ url, baseUrl }) {
      if (url.startsWith(baseUrl)) return url
      return `${baseUrl}/dashboard`
    },
  },
}