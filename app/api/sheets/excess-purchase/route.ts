import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getExcessPurchaseRows,
  getExcessPurchasePaginated,
  getDuplicateFormRowsForItems,
  bulkUpdatePurchase,
  bulkUpdateArrive,
  bulkUpdateDispatch,
  deleteExcessRow,
  updateExcessRowUnitBuy,
  appendExcessPurchase,
  withActor,
} from "@/lib/db"

type UpdatedRow = { rowNumber: number; event: string; customer: string; oldUnitBuy: number; unitBuy: number }
type ItemResult = { event: string; items: string; originalUnitBuy: number; filled: UpdatedRow[]; remainder: number }

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json().catch(() => ({})) as { receipt?: string }
    const receipt = body.receipt ? String(body.receipt).trim() : ""

    // Broken inventory is tracked but never sellable, so exclude it from the
    // apply-to-orders working set entirely (not matched, not deleted/updated).
    const excessRows = (await getExcessPurchaseRows()).filter((r) => r.reason !== "broken")

    if (excessRows.length === 0) {
      return NextResponse.json({ results: [] })
    }

    // Excess rows match orders by item name across all events, so fetch orders
    // for just the item names being applied (still bounded — not the whole
    // orders table). Each row fills its own event first, then spills to others.
    const items = [...new Set(excessRows.map((r) => r.items))]
    const formRows = await getDuplicateFormRowsForItems(items)

    // Working copy of unitBuy so sequential excess rows see each other's allocations
    const workingUnitBuy = new Map<number, number>()
    for (const r of formRows) workingUnitBuy.set(r.rowNumber, r.unitBuy ?? 0)

    // Each order's original unit_arrive, to bump alongside unit_buy on apply
    // (applied excess is already in hand, so it counts as arrived).
    const origUnitArrive = new Map<number, number>()
    for (const r of formRows) origUnitArrive.set(r.rowNumber, r.unitArrive ?? 0)

    // Each order's original unit_dispatch, to bump alongside unit_buy on apply
    // (applied excess is already in hand, so it counts as dispatched too).
    const origUnitDispatch = new Map<number, number>()
    for (const r of formRows) origUnitDispatch.set(r.rowNumber, r.unitDispatch ?? 0)

    // Each order's existing dispatch_receipt, preserved on apply — bulkUpdateDispatch
    // always writes the column, so without this a partially-dispatched order's
    // tracking ref would be silently clobbered with "".
    const origDispatchReceipt = new Map<number, string>()
    for (const r of formRows) origDispatchReceipt.set(r.rowNumber, r.dispatchReceipt ?? "")

    // Accumulate Duplicate_Form updates (keyed by rowNumber to merge multi-excess fills)
    const formUpdates = new Map<number, { customer: string; oldUnitBuy: number; unitBuy: number; receipt: string }>()

    const results: ItemResult[] = []
    const excessToDelete: number[] = []
    const excessToUpdate: { rowNumber: number; unitBuy: number }[] = []

    for (const excessRow of excessRows) {
      const eligible = formRows
        .filter(
          (r) =>
            r.items === excessRow.items &&
            (workingUnitBuy.get(r.rowNumber) ?? 0) < r.unit,
        )
        .sort(
          (a, b) =>
            (Number(b.event === excessRow.event) - Number(a.event === excessRow.event)) ||
            (a.rowNumber - b.rowNumber),
        )

      let remaining = excessRow.unitBuy
      const filled: UpdatedRow[] = []

      for (const r of eligible) {
        if (remaining <= 0) break
        const current = workingUnitBuy.get(r.rowNumber) ?? 0
        const allocate = Math.min(r.unit - current, remaining)
        const newUnitBuy = current + allocate

        // Accumulate receipt — chain if this row is touched by multiple excess rows
        const existingReceipt = formUpdates.has(r.rowNumber)
          ? formUpdates.get(r.rowNumber)!.receipt
          : (r.receipt ?? "")
        const combinedReceipt = receipt
          ? existingReceipt ? `${existingReceipt}, ${receipt}` : receipt
          : existingReceipt

        formUpdates.set(r.rowNumber, {
          customer: r.customer,
          // preserve the original unitBuy from before this whole batch
          oldUnitBuy: formUpdates.get(r.rowNumber)?.oldUnitBuy ?? current,
          unitBuy: newUnitBuy,
          receipt: combinedReceipt,
        })
        workingUnitBuy.set(r.rowNumber, newUnitBuy)
        filled.push({ rowNumber: r.rowNumber, event: r.event, customer: r.customer, oldUnitBuy: current, unitBuy: newUnitBuy })
        remaining -= allocate
      }

      results.push({ event: excessRow.event, items: excessRow.items, originalUnitBuy: excessRow.unitBuy, filled, remainder: remaining })

      if (remaining <= 0) {
        excessToDelete.push(excessRow.rowNumber)
      } else {
        excessToUpdate.push({ rowNumber: excessRow.rowNumber, unitBuy: remaining })
      }
    }

    // 1. Write all Duplicate_Form updates in one batch. unit_arrive and
    //    unit_dispatch are both bumped by the same amount applied
    //    (unitBuy - oldUnitBuy) so applied excess — stock already in hand —
    //    drops off the dispatch and receiving lists too, not just the
    //    shopping list.
    await withActor(session.user.email, async (tx) => {
      const entries = Array.from(formUpdates.entries())
      await bulkUpdatePurchase(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitBuy: d.unitBuy,
          receipt: d.receipt,
        })),
        tx,
      )
      await bulkUpdateArrive(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitArrive: (origUnitArrive.get(rowNumber) ?? 0) + (d.unitBuy - d.oldUnitBuy),
        })),
        tx,
      )
      await bulkUpdateDispatch(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitDispatch: (origUnitDispatch.get(rowNumber) ?? 0) + (d.unitBuy - d.oldUnitBuy),
          dispatchReceipt: origDispatchReceipt.get(rowNumber) ?? "",
        })),
        tx,
      )
    })

    // 2. Update partially-consumed excess rows (before deletes shift row numbers)
    for (const { rowNumber, unitBuy } of excessToUpdate) {
      await withActor(session.user.email, (tx) => updateExcessRowUnitBuy(rowNumber, unitBuy, tx))
    }

    // 3. Delete fully-consumed excess rows highest-first so lower indices stay valid
    for (const rowNumber of excessToDelete.sort((a, b) => b - a)) {
      await withActor(session.user.email, (tx) => deleteExcessRow(rowNumber, tx))
    }

    return NextResponse.json({ results })
  } catch (err) {
    console.error("Failed to bulk apply excess:", err)
    return NextResponse.json({ error: "Failed to apply" }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams

  try {
    // Paginated page of rows when ?page is present (the Inventory table).
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const result = await getExcessPurchasePaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        event: params.get("event") ?? undefined,
        items: params.get("items") ?? undefined,
        receipt: params.get("receipt") ?? undefined,
        reason: params.get("reason") ?? undefined,
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        skipCount: params.get("skipCount") === "true",
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise the full list (back-compat: the apply flow re-reads all rows).
    const rows = await getExcessPurchaseRows()
    return NextResponse.json({ rows })
  } catch (err) {
    console.error("Failed to fetch excess purchase rows:", err)
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 })
  }
}

/**
 * Manually add a tracked inventory row — e.g. stock owned before this
 * dashboard existed. Reason is fixed to 'manual' so it's visually distinct
 * from auto-detected overbuy/overship on the Inventory page.
 */
export async function PUT(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, items, unitBuy, receipt } = body as {
      event?: string
      items?: string
      unitBuy?: number
      receipt?: string
    }

    // event is optional — inventory can be logged before it's tied to an event.
    if (!items || typeof unitBuy !== "number" || unitBuy < 1) {
      return NextResponse.json(
        { error: "items and a positive unitBuy are required" },
        { status: 400 },
      )
    }

    await withActor(session.user.email, (tx) => appendExcessPurchase(
      [{ event: event ?? "", items, unitBuy, receipt: receipt ? String(receipt).trim() : "", reason: "manual" }],
      tx,
    ))

    const rows = await getExcessPurchaseRows()
    return NextResponse.json({ success: true, rows })
  } catch (err) {
    console.error("Failed to add inventory:", err)
    return NextResponse.json({ error: "Failed to add inventory" }, { status: 500 })
  }
}
