import { NextResponse } from "next/server"
import { auth } from "@/auth"
import type { Session } from "next-auth"

type AuthResult =
  | { session: Session; error: null }
  | { session: null; error: NextResponse }

/** Verify the request has an active session. Returns a 401 response if not. */
export async function requireSession(): Promise<AuthResult> {
  const session = await auth()
  if (!session?.user) {
    return { session: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  return { session, error: null }
}

/** Verify the session user has a role. Returns a 403 response if not. */
export function requireRole(session: Session): NextResponse | null {
  if (!session.user.role) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  return null
}

/** Verify the session user is an owner. Returns a 403 response if not. */
export function requireOwner(session: Session): NextResponse | null {
  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  return null
}

/** True when the session user is an admin (restricted role). */
export function isAdmin(session: Session): boolean {
  return session.user.role === "admin"
}
