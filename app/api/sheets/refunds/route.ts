import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getRefunds, createRefund, materializeOverpaymentRefunds, getDistinctRefundReasons, withActor } from "@/lib/db"

// Overpayment detection is a full aggregate over orders/payments/adjustments,
// so it shouldn't run on every page open. Skip re-running it if it fired within
// this window. Module-level state persists on the long-lived (Railway) server
// and is shared across requests, so two open tabs don't both pay the cost.
let lastMaterializeAt = 0
const MATERIALIZE_THROTTLE_MS = 30_000

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { searchParams } = req.nextUrl

  // Lightweight path for the reason picker (e.g. the invoice page's Create
  // Refund modal) — skip the full list + materialize scan.
  if (searchParams.get("meta") === "reasons") {
    try {
      const reasons = await getDistinctRefundReasons()
      return NextResponse.json({ reasons }, { headers: { "Cache-Control": "no-store" } })
    } catch (err) {
      console.error("Failed to fetch refund reasons:", err)
      return NextResponse.json({ error: "Failed to fetch refund reasons" }, { status: 500 })
    }
  }

  const event = searchParams.get("event") ?? undefined
  const status = searchParams.get("status") ?? undefined
  const customer = searchParams.get("customer") ?? undefined
  // The Refresh button forces a fresh scan; normal opens use the throttle.
  const forceScan = searchParams.get("forceScan") === "1"

  try {
    // Auto-create pending refunds for detected overpayments before listing.
    // Idempotent (skips pairs that already have an active overpayment refund),
    // but expensive — so throttle it. Set the marker before awaiting so
    // concurrent opens (e.g. two tabs) don't pile up on the advisory lock.
    if (forceScan || Date.now() - lastMaterializeAt >= MATERIALIZE_THROTTLE_MS) {
      lastMaterializeAt = Date.now()
      try {
        await materializeOverpaymentRefunds()
      } catch (err) {
        console.error("Failed to auto-create overpayment refunds:", err)
        // Continue to list whatever's already there; one bad write shouldn't
        // hide the entire refunds page.
      }
    }

    const [rows, reasons] = await Promise.all([
      getRefunds({ event, status, customer }),
      getDistinctRefundReasons(),
    ])
    return NextResponse.json({ rows, reasons }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch refunds:", err)
    return NextResponse.json({ error: "Failed to fetch refunds" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, customer, refundAmount, orderId, affectedUnits, note } = body
    const reason = String(body.reason ?? "").trim()

    if (!event || !customer || !reason || typeof refundAmount !== "number" || refundAmount < 1) {
      return NextResponse.json(
        { error: "event, customer, reason and refundAmount are required" },
        { status: 400 },
      )
    }

    const row = await withActor(session.user.email, (tx) => createRefund({
      event,
      customer,
      reason,
      refundAmount,
      orderId: orderId ?? null,
      affectedUnits: affectedUnits ?? 0,
      note: note ?? "",
    }, tx))
    return NextResponse.json({ success: true, row })
  } catch (err) {
    console.error("Failed to create refund:", err)
    return NextResponse.json({ error: "Failed to create refund" }, { status: 500 })
  }
}
