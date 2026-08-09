import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getEvents, addEvent, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const rows = await cached("events", getEvents)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch events:", err)
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const { name, eta, warehouseId, countryId } = body

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addEvent({
      name: String(name),
      eta: String(eta ?? ""),
      warehouseId: warehouseId != null ? Number(warehouseId) : null,
      countryId: countryId != null ? Number(countryId) : null,
    }, tx))
    invalidate("events")

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to add event:", err)
    return NextResponse.json({ error: "Failed to add event" }, { status: 500 })
  }
}
