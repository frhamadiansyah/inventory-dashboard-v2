import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getDispatchDocument } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const event = params.get("event")
  if (!event) {
    return NextResponse.json({ error: "event is required" }, { status: 400 })
  }
  // Optional receipt substring; blank → no filter.
  const receipt = params.get("receipt")?.trim() || null

  try {
    const lines = await getDispatchDocument(event, receipt)
    return NextResponse.json(
      { event, receipt, lines },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to fetch dispatch document:", err)
    return NextResponse.json({ error: "Failed to fetch dispatch document" }, { status: 500 })
  }
}
