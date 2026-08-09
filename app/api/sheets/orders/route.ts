import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import { appendOrders, cancelOrderUnits, withActor } from "@/lib/db"

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const rows = body.rows

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "rows must be a non-empty array" }, { status: 400 })
    }

    for (const row of rows) {
      if (!row.event || !row.customer || !row.productId || !row.unit) {
        return NextResponse.json({ error: "Each row requires event, customer, productId, and unit" }, { status: 400 })
      }
    }

    await withActor(session.user.email, (tx) => appendOrders(
      rows.map((r) => ({
        event: String(r.event),
        customer: String(r.customer),
        productId: Number(r.productId),
        unitPrice: Number(r.unitPrice ?? 0),
        unit: Number(r.unit),
        note: r.note ? String(r.note) : "",
      })),
      tx,
    ))

    return NextResponse.json({ success: true, count: rows.length })
  } catch (err) {
    console.error("Sheets append error:", err)
    return NextResponse.json({ error: "Failed to save orders" }, { status: 500 })
  }
}

/**
 * Cancel some or all units of a single customer order line the customer backed
 * out of. Reduces the line by qty (drops it entirely off the invoice + packing
 * list when qty covers everything ordered), auto-refunds if paid, and returns
 * the still-in-hand bought portion to Inventory as ready stock. Works from the
 * invoice at any stage — arrived or not — unlike the Arrival List flow, which
 * only reaches not-yet-arrived items and only cancels whole lines.
 */
export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  // Cancelling an order refunds money and moves stock — owner-only, matching
  // the Arrival List exception flows.
  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    if (body.action !== "customer_cancelled") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
    const { event, productName, orderId, qty, receipt } = body
    if (!event || !productName || !Number.isInteger(orderId) || !Number.isInteger(qty) || qty < 1) {
      return NextResponse.json(
        { error: "event, productName, orderId and a positive integer qty are required" },
        { status: 400 },
      )
    }
    const result = await withActor(session.user.email, (tx) =>
      cancelOrderUnits({ event, productName, orderId, qty, receipt: typeof receipt === "string" ? receipt : undefined }, tx),
    )
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to cancel order"
    console.error("Failed to cancel order:", err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
