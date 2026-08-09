import { auth } from "@/auth"
import { NextResponse } from "next/server"
import { canAccessRoute, ADMIN_HOME } from "@/lib/access"

export default auth((req) => {
  const { pathname } = req.nextUrl
  const role = req.auth?.user?.role ?? null

  // Not logged in → send to login
  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url))
  }

  // Logged in but no recognized role → show the dedicated unauthorized page.
  // (/unauthorized is not matched by this middleware, so this cannot loop.)
  if (!role) {
    return NextResponse.redirect(new URL("/unauthorized", req.url))
  }

  // Admins are restricted to a fixed set of routes; owners can access everything.
  // ADMIN_HOME is itself an admin route, so this never loops.
  if (!canAccessRoute(role, pathname)) {
    return NextResponse.redirect(new URL(ADMIN_HOME, req.url))
  }
})

export const config = {
  matcher: ["/dashboard/:path*"],
}
