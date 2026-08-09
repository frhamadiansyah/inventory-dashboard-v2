import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getShoppingList, getSellableExcessTotals, applyExcessToShoppingItem, markProductBought, markProductOutOfStock, withActor } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const [items, excessByItem] = await Promise.all([
      getShoppingList(event),
      getSellableExcessTotals(),
    ])
    return NextResponse.json({ items, excessByItem }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch shopping list:", err)
    return NextResponse.json({ error: "Failed to fetch shopping list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()

    // Out-of-stock: FIFO-reduce pending order quantities. The dropped invoice
    // auto-materializes an overpayment refund for anyone who already paid.
    if (body.action === "out_of_stock") {
      const { event, productId, quantityOutOfStock } = body
      if (!event || !productId || typeof quantityOutOfStock !== "number" || quantityOutOfStock < 1) {
        return NextResponse.json({ error: "event, productId and quantityOutOfStock are required" }, { status: 400 })
      }
      const result = await markProductOutOfStock({ event, productId: Number(productId), quantityOutOfStock }, session.user.email)
      return NextResponse.json({ success: true, ...result })
    }

    // Apply excess: pull from existing sellable excess_purchase stock instead
    // of buying more. Mirrors the Inventory page's Apply Excess, started from
    // the order side.
    if (body.action === "apply_excess") {
      const { event, productId, productName, qty, receipt } = body
      if (!event || !productId || !productName || typeof qty !== "number" || qty < 1) {
        return NextResponse.json({ error: "event, productId, productName and qty are required" }, { status: 400 })
      }
      const result = await withActor(session.user.email, (tx) => applyExcessToShoppingItem(
        { event, productId: Number(productId), productName, qty, receipt: receipt ? String(receipt).trim() : "" },
        tx,
      ))
      return NextResponse.json({ success: true, ...result })
    }

    const { event, productId, productName, quantityBought, receipt } = body
    if (!event || !productId || !productName || typeof quantityBought !== "number" || quantityBought < 1) {
      return NextResponse.json({ error: "event, productId, productName and quantityBought are required" }, { status: 400 })
    }
    const result = await markProductBought({ event, productId: Number(productId), productName, quantityBought, receipt: receipt ?? "" }, session.user.email)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to process shopping-list action:", err)
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 })
  }
}
