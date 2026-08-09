import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getArrivalList, getExcessArrivalPending, markProductArrived, recordWrongProduct, recordBrokenArrival, recordMissingArrival, recordCustomerCancellation, recordNotReceived, withActor } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const [items, excessPending] = await Promise.all([
      getArrivalList(event),
      getExcessArrivalPending(event),
    ])
    return NextResponse.json({ items, excessPending }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch arrival list:", err)
    return NextResponse.json({ error: "Failed to fetch arrival list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()

    // Wrong-product path: supplier sent a different SKU. Log it to ready stock
    // and zero the chosen customer orders (refunds auto-materialize if paid).
    if (body.action === "wrong_product") {
      const { event, expectedItem, receivedItem, qty } = body
      if (!event || !expectedItem || !receivedItem || typeof qty !== "number" || qty < 1) {
        return NextResponse.json(
          { error: "event, expectedItem, receivedItem and qty are required" },
          { status: 400 },
        )
      }
      if (receivedItem === expectedItem) {
        return NextResponse.json(
          { error: "Received item must differ from the expected item" },
          { status: 400 },
        )
      }
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      const result = await withActor(session.user.email, (tx) =>
        recordWrongProduct({ event, expectedItem, receivedItem, qty, cancelOrderIds }, tx),
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Broken path: the expected item arrived damaged. Log the broken units to
    // inventory flagged 'broken' (tracked but never assignable to orders) and
    // cancel the chosen customer orders (refunds auto-materialize if paid).
    if (body.action === "broken") {
      const { event, productName, qty } = body
      if (!event || !productName || typeof qty !== "number" || qty < 1) {
        return NextResponse.json(
          { error: "event, productName and qty are required" },
          { status: 400 },
        )
      }
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      const result = await withActor(session.user.email, (tx) =>
        recordBrokenArrival({ event, productName, qty, cancelOrderIds }, tx),
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Missing path: the expected item never arrived. Like broken, cancel the
    // chosen customer orders (refunds auto-materialize if paid) — but nothing is
    // logged to inventory, since there are no physical units.
    if (body.action === "missing") {
      const { event } = body
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      if (!event || cancelOrderIds.length === 0) {
        return NextResponse.json(
          { error: "event and at least one order to cancel are required" },
          { status: 400 },
        )
      }
      const result = await withActor(session.user.email, (tx) =>
        recordMissingArrival({ cancelOrderIds }, tx),
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Customer-cancelled path: the item is correct and already bought, but the
    // customer backed out (misunderstanding, changed their mind). Log the
    // already-bought units to inventory as ready stock (reason=customer_cancelled,
    // assignable to the next order) and cancel the chosen orders (refunds
    // auto-materialize if paid).
    if (body.action === "customer_cancelled") {
      const { event, productName, receipt } = body
      const cancelOrderIds = Array.isArray(body.cancelOrderIds)
        ? body.cancelOrderIds.filter((n: unknown) => Number.isInteger(n)) as number[]
        : []
      if (!event || !productName || cancelOrderIds.length === 0) {
        return NextResponse.json(
          { error: "event, productName and at least one order to cancel are required" },
          { status: 400 },
        )
      }
      const result = await withActor(session.user.email, (tx) =>
        recordCustomerCancellation({ event, productName, cancelOrderIds, receipt: typeof receipt === "string" ? receipt : undefined }, tx),
      )
      return NextResponse.json({ success: true, ...result })
    }

    // Bulk "Not Received": record a delivery problem against `qty` units of one
    // product, allocated across its waiting orders by priority (recordNotReceived
    // runs its own transaction + actor).
    if (body.action === "not_received") {
      const { event, productId, productName, qty, mode, receivedItem } = body
      const validModes = ["wrong", "broken", "missing", "cancelled"]
      if (!event || !productId || !productName || typeof qty !== "number" || qty < 1 || !validModes.includes(mode)) {
        return NextResponse.json(
          { error: "event, productId, productName, qty (>=1) and a valid mode are required" },
          { status: 400 },
        )
      }
      if (mode === "wrong" && (!receivedItem || receivedItem === productName)) {
        return NextResponse.json(
          { error: "A wrong delivery needs a received item different from the expected one" },
          { status: 400 },
        )
      }
      const result = await recordNotReceived(
        { event, productId: Number(productId), productName, qty, mode, receivedItem },
        session.user.email,
      )
      return NextResponse.json({ success: true, ...result })
    }

    const { event, productId, quantityArrived } = body
    if (!event || !productId || typeof quantityArrived !== "number" || quantityArrived < 1) {
      return NextResponse.json(
        { error: "event, productId and quantityArrived are required" },
        { status: 400 },
      )
    }
    const result = await markProductArrived({
      event,
      productId: Number(productId),
      quantityArrived,
    }, session.user.email)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to mark orders as arrived:", err)
    return NextResponse.json({ error: "Failed to mark as arrived" }, { status: 500 })
  }
}
