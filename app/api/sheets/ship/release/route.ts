import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { releasePackingList, withActor } from "@/lib/db"

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { customer, event } = body as { customer?: string; event?: string }
    if (!customer || !event) {
      return NextResponse.json({ error: "customer and event are required" }, { status: 400 })
    }
    await withActor(session.user.email, (tx) => releasePackingList({ customer, event }, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to release packing list:", err)
    return NextResponse.json({ error: "Failed to release packing list" }, { status: 500 })
  }
}
