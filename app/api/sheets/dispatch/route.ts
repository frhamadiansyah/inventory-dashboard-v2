import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getDispatchList, getDuplicateFormRowsForEvent, bulkUpdateDispatch, cancelUndispatchedRemainder, withActor, fetchPaidStatusMap, PAID_PRIORITY_RANK, type PaidStatus } from "@/lib/db"

type ItemLine = { item: string; qty: number }
type UpdatedRow = { rowNumber: number; customer: string; oldUnitDispatch: number; unitDispatch: number }
type FormRows = Awaited<ReturnType<typeof getDuplicateFormRowsForEvent>>

/**
 * Build a map of item name → eligible rows, ordered by allocation priority:
 * paid → partial → unpaid (customers who've committed money are dispatched
 * first), then earliest order within a tier. Mirrors getDispatchList /
 * /api/sheets/purchasing — one lifecycle stage later (buy → DISPATCH →
 * arrive), so the cap is unit_buy (units bought, i.e. dispatchable) instead
 * of unit, and only rows that were actually bought are eligible at all.
 */
function buildEligibleMap(rows: FormRows, event: string, statusMap: Map<string, PaidStatus>): Map<string, FormRows> {
  const rank = (customer: string) => PAID_PRIORITY_RANK[statusMap.get(`${event}|${customer}`) ?? "unpaid"]
  const map = new Map<string, FormRows>()
  for (const r of rows) {
    if (r.unitBuy == null) continue
    if ((r.unitDispatch ?? 0) >= r.unitBuy) continue
    const group = map.get(r.items)
    if (group) group.push(r)
    else map.set(r.items, [r])
  }
  for (const group of map.values()) {
    group.sort((a, b) => rank(a.customer) - rank(b.customer) || a.rowNumber - b.rowNumber)
  }
  return map
}

function distribute(
  eligible: FormRows,
  item: string,
  qty: number,
  receipt: string,
): {
  updates: (UpdatedRow & { dispatchReceipt: string })[]
  itemResult: { item: string; rows: UpdatedRow[]; excess: number }
} {
  let remaining = qty
  const updates: (UpdatedRow & { dispatchReceipt: string })[] = []

  for (const row of eligible) {
    if (remaining <= 0) break
    const current = row.unitDispatch ?? 0
    const cap = (row.unitBuy ?? 0) - current
    const allocate = Math.min(cap, remaining)
    const existingReceipt = row.dispatchReceipt ?? ""
    const combinedReceipt = receipt
      ? (existingReceipt ? `${existingReceipt}, ${receipt}` : receipt)
      : existingReceipt
    updates.push({
      rowNumber: row.rowNumber,
      customer: row.customer,
      oldUnitDispatch: current,
      unitDispatch: current + allocate,
      dispatchReceipt: combinedReceipt,
    })
    remaining -= allocate
  }

  return {
    updates,
    itemResult: {
      item,
      rows: updates.map(({ dispatchReceipt: _r, ...rest }) => rest),
      excess: remaining,
    },
  }
}

// GET — list bought-not-yet-dispatched orders, grouped by product. Mirrors
// /api/sheets/shopping-list's GET (same getShoppingList -> getDispatchList
// swap as the rest of this dispatch stage); the client (DispatchListClient)
// polls this to render the list and to silently refresh after a dispatch.
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const items = await getDispatchList(event)
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch dispatch list:", err)
    return NextResponse.json({ error: "Failed to fetch dispatch list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const body = await req.json()

    // Cancel path: drop only the un-dispatched remainder of the chosen orders
    // (unit_buy → unit_dispatch, and reduce unit by the same amount) so those
    // units fall off each customer's invoice — the overpayment materialization
    // then auto-refunds anyone who paid. Already-dispatched units stay, and
    // nothing is logged to Inventory (unlike customer_cancelled).
    if (body.action === "cancel") {
      const orderIds = Array.isArray(body.orderIds)
        ? (body.orderIds.filter((n: unknown) => Number.isInteger(n)) as number[])
        : []
      if (orderIds.length === 0) {
        return NextResponse.json({ error: "orderIds are required" }, { status: 400 })
      }
      const cancelled = await withActor(session.user.email, (tx) => cancelUndispatchedRemainder(orderIds, tx))
      return NextResponse.json({ cancelled })
    }

    const { event, items, receipt } = body as {
      event: string
      items: ItemLine[]
      receipt?: string
    }

    if (!event || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "event and at least one item are required" }, { status: 400 })
    }

    for (const line of items) {
      if (!line.item) return NextResponse.json({ error: "Each line must have an item" }, { status: 400 })
      const q = Number(line.qty)
      if (!Number.isFinite(q) || q <= 0) {
        return NextResponse.json({ error: `qty for "${line.item}" must be a positive number` }, { status: 400 })
      }
    }

    const [rows, statusMap] = await Promise.all([
      getDuplicateFormRowsForEvent(event),
      fetchPaidStatusMap([event]),
    ])
    const receiptStr = receipt ? String(receipt) : ""
    const eligibleMap = buildEligibleMap(rows, event, statusMap)

    const allUpdates: (UpdatedRow & { dispatchReceipt: string })[] = []
    const results: { item: string; rows: UpdatedRow[]; excess: number }[] = []

    for (const line of items) {
      const eligible = eligibleMap.get(line.item) ?? []
      const { updates, itemResult } = distribute(eligible, line.item, Number(line.qty), receiptStr)
      allUpdates.push(...updates)
      results.push(itemResult)
    }

    await withActor(session.user.email, (tx) => bulkUpdateDispatch(
      allUpdates.map(({ rowNumber, unitDispatch, dispatchReceipt }) => ({ rowNumber, unitDispatch, dispatchReceipt })),
      tx,
    ))

    return NextResponse.json({ results })
  } catch (err) {
    console.error("Failed to process dispatch:", err)
    return NextResponse.json({ error: "Failed to process" }, { status: 500 })
  }
}
