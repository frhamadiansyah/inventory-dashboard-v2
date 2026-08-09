import { requireSession, requireOwner } from "@/lib/api"
import { NextResponse } from "next/server"
import { getEventPerformance } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const rows = await getEventPerformance()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch event performance:", err)
    return NextResponse.json({ error: "Failed to fetch event performance" }, { status: 500 })
  }
}
