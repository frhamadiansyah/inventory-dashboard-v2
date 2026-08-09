import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShipOrdersFiltered, shipCustomerOrders, shipMergedCustomerOrders, type ShipSegment } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const url = req.nextUrl
    const segment = (url.searchParams.get("segment") ?? "all") as ShipSegment
    const search = url.searchParams.get("search") ?? ""
    const event = url.searchParams.get("event") ?? ""

    const data = await getShipOrdersFiltered({ segment, search, event })
    return NextResponse.json(data)
  } catch (err) {
    console.error("Failed to load ready-to-ship orders:", err)
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    // A "Ship together" payload carries `groups` (one customer, several events);
    // a single-event ship carries `event` + `orders`.
    const result = Array.isArray(body?.groups)
      ? await shipMergedCustomerOrders(body, session.user.email)
      : await shipCustomerOrders(body, session.user.email)
    return NextResponse.json(result)
  } catch (err) {
    console.error("Failed to ship orders:", err)
    return NextResponse.json({ error: "Failed to ship orders" }, { status: 500 })
  }
}
