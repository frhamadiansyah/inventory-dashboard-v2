import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { getRole } from "@/lib/roles"

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Trust the host/X-Forwarded-Host from the platform proxy. Required on
  // generic Node hosts like Railway (NextAuth only auto-trusts on Vercel);
  // without it, sign-in fails with an UntrustedHost error. Safe behind any
  // trusted reverse proxy, so it's also fine on the current Netlify deploy.
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    jwt({ token, account }) {
      if (account && token.email) {
        token.role = getRole(token.email)
      }
      return token
    },
    session({ session, token }) {
      session.user.role = (token.role as import("@/lib/roles").Role | null | undefined) ?? null
      return session
    },
  },
  pages: {
    signIn: "/login",
  },
})
