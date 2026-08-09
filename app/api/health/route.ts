import { NextResponse } from "next/server"

// Lightweight liveness probe for Railway's deploy healthcheck. Not matched by
// middleware (which only guards /dashboard/*), so it answers 200 without a
// session. Deliberately does NOT touch the database — a DB blip should not make
// the platform think the app is dead and restart it in a loop.
export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json({ status: "ok" })
}
