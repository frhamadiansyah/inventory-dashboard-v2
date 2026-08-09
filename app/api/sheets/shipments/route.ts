import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShippingRecords, updateTrackingNumber, updateShipmentTempAddress, withActor } from "@/lib/db"

// Default recent window (days) for the shipments list, so the payload stays
// bounded as shipment history grows. `?days=all` loads the full history.
const DEFAULT_WINDOW_DAYS = 90

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const daysParam = req.nextUrl.searchParams.get("days")
    let sinceDays: number | null = DEFAULT_WINDOW_DAYS
    if (daysParam === "all") {
      sinceDays = null
    } else if (daysParam) {
      const parsed = parseInt(daysParam, 10)
      if (Number.isFinite(parsed) && parsed > 0) sinceDays = parsed
    }

    const data = await getShippingRecords(sinceDays)
    return NextResponse.json(data)
  } catch (err) {
    console.error("Failed to load shipments:", err)
    return NextResponse.json({ error: "Failed to load shipments" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json() as {
      rowNumber?: number
      trackingNumber?: string
      // null clears, string sets, undefined means "don't touch this field"
      tempAddress?: string | null
    }
    const { rowNumber, trackingNumber, tempAddress } = body
    if (!rowNumber) {
      return NextResponse.json({ error: "rowNumber is required" }, { status: 400 })
    }
    // PATCH lets the caller update either field independently, mirroring how
    // the page surfaces them (inline edits for tracking number and for temp
    // address are two separate flows).
    if (trackingNumber !== undefined) {
      if (typeof trackingNumber !== "string") {
        return NextResponse.json({ error: "trackingNumber must be a string" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateTrackingNumber(rowNumber, trackingNumber, tx))
    }
    if (tempAddress !== undefined) {
      if (tempAddress !== null && typeof tempAddress !== "string") {
        return NextResponse.json({ error: "tempAddress must be a string or null" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateShipmentTempAddress(rowNumber, tempAddress, tx))
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update shipment:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
