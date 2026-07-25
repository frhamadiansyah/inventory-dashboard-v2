import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getReceivedReport } from "@/lib/db"

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
  const fromParam = params.get("from")
  const toParam = params.get("to")
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  if ((fromParam && !isDate(fromParam)) || (toParam && !isDate(toParam))) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 })
  }
  // Dates are optional: empty means every date for the event. When only one end
  // is given, treat it as a single day; order a two-ended range so a reversed
  // selection still works.
  let from = fromParam ?? toParam ?? null
  let to = toParam ?? fromParam ?? null
  if (from && to && from > to) [from, to] = [to, from]

  try {
    const items = await getReceivedReport(event, from, to)
    const totalUnits = items.reduce((sum, i) => sum + i.unitsReceived, 0)
    return NextResponse.json(
      { event, from, to, items, totalUnits },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to fetch received report:", err)
    return NextResponse.json({ error: "Failed to fetch received report" }, { status: 500 })
  }
}
