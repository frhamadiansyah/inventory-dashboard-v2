import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import {
  getExcessPurchaseRows,
  getDuplicateFormRowsForItems,
  bulkUpdatePurchase,
  bulkUpdateArrive,
  bulkUpdateDispatch,
  deleteExcessRow,
  updateExcessRowUnitBuy,
  updateExcessRow,
  withActor,
} from "@/lib/db"
import type { ExcessReason, ExcessRow, FormRow } from "@/lib/db"

const EXCESS_REASONS: ExcessReason[] = ["overbuy", "overship", "wrong_product", "broken", "customer_cancelled", "manual"]

type Params = { params: Promise<{ row: string }> }
type UpdatedRow = { rowNumber: number; event: string; customer: string; oldUnitBuy: number; unitBuy: number }

/** Orders that can receive this excess row's item: same item, not yet fully
 *  bought, sorted with the excess row's own event first then oldest — the
 *  order the picker lists them in (matching the old auto-fill priority). */
async function getEligibleOrders(excessRow: ExcessRow): Promise<FormRow[]> {
  const formRows = await getDuplicateFormRowsForItems([excessRow.items])
  return formRows
    .filter((r) => r.items === excessRow.items && (r.unitBuy ?? 0) < r.unit)
    .sort(
      (a, b) =>
        (Number(b.event === excessRow.event) - Number(a.event === excessRow.event)) ||
        (a.rowNumber - b.rowNumber),
    )
}

/** Eligible pending orders for this excess row's item, for the Apply picker. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const excessRows = await getExcessPurchaseRows()
    const excessRow = excessRows.find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    const eligible = await getEligibleOrders(excessRow)
    return NextResponse.json({
      orders: eligible.map((r) => ({
        rowNumber: r.rowNumber,
        event: r.event,
        customer: r.customer,
        needed: r.unit - (r.unitBuy ?? 0),
      })),
    })
  } catch (err) {
    console.error("Failed to load eligible orders:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json().catch(() => ({})) as {
      receipt?: string
      allocations?: { rowNumber: number; allocate: number }[]
    }
    const receipt = body.receipt ? String(body.receipt).trim() : ""
    const requested = Array.isArray(body.allocations) ? body.allocations : []

    const excessRows = await getExcessPurchaseRows()

    const excessRow = excessRows.find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }
    if (excessRow.reason === "broken") {
      return NextResponse.json({ error: "Broken inventory can't be applied to orders" }, { status: 400 })
    }
    if (requested.length === 0) {
      return NextResponse.json({ error: "Pick at least one order to apply to" }, { status: 400 })
    }

    // Matched by item name across all events (scoped to this item), so an
    // excess row can spill into other events' orders when its own event is
    // already covered. Re-derived server-side (never trust the client's
    // allocation targets/caps) — the picker only chooses among these.
    const eligibleById = new Map((await getEligibleOrders(excessRow)).map((r) => [r.rowNumber, r]))

    let remaining = excessRow.unitBuy
    const updates: (UpdatedRow & { receipt: string; unitArrive: number; unitDispatch: number })[] = []

    for (const { rowNumber: targetRow, allocate: requestedAllocate } of requested) {
      const r = eligibleById.get(targetRow)
      if (!r || !Number.isFinite(requestedAllocate) || requestedAllocate <= 0) continue
      const current = r.unitBuy ?? 0
      const allocate = Math.min(r.unit - current, requestedAllocate, remaining)
      if (allocate <= 0) continue
      const existingReceipt = r.receipt ?? ""
      const combinedReceipt = receipt
        ? existingReceipt
          ? `${existingReceipt}, ${receipt}`
          : receipt
        : existingReceipt
      updates.push({
        rowNumber: r.rowNumber,
        event: r.event,
        customer: r.customer,
        oldUnitBuy: current,
        unitBuy: current + allocate,
        // Applied excess is stock already in hand, so it counts as arrived AND
        // dispatched too — bump both by the same amount so it drops off the
        // dispatch list and the receiving list, not just the shopping list.
        unitArrive: (r.unitArrive ?? 0) + allocate,
        unitDispatch: (r.unitDispatch ?? 0) + allocate,
        receipt: combinedReceipt,
      })
      remaining -= allocate
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "Nothing to apply — pick at least one order with units allocated" }, { status: 400 })
    }

    await withActor(session.user.email, async (tx) => {
      await bulkUpdatePurchase(
        updates.map(({ rowNumber: rn, unitBuy, receipt }) => ({ rowNumber: rn, unitBuy, receipt })),
        tx,
      )
      await bulkUpdateArrive(
        updates.map(({ rowNumber: rn, unitArrive }) => ({ rowNumber: rn, unitArrive })),
        tx,
      )
      await bulkUpdateDispatch(
        updates.map(({ rowNumber: rn, unitDispatch }) => ({ rowNumber: rn, unitDispatch, dispatchReceipt: "" })),
        tx,
      )
    })

    if (remaining <= 0) {
      await withActor(session.user.email, (tx) => deleteExcessRow(rowNumber, tx))
    } else {
      await withActor(session.user.email, (tx) => updateExcessRowUnitBuy(rowNumber, remaining, tx))
    }

    return NextResponse.json({
      filled: updates.map(({ receipt: _r, ...rest }) => rest),
      remainder: remaining,
    })
  } catch (err) {
    console.error("Failed to apply excess:", err)
    return NextResponse.json({ error: "Failed to apply" }, { status: 500 })
  }
}

/**
 * Edit an inventory row's event/item/quantity/reason/receipt. "Apply" fills the
 * row's own event first and then spills to matching orders in other events, so
 * retargeting the event only changes fill priority, not what's reachable.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json()
    const { event, items, unitBuy, receipt, reason } = body as {
      event?: string
      items?: string
      unitBuy?: number
      receipt?: string
      reason?: string
    }

    if (reason !== undefined && !EXCESS_REASONS.includes(reason as ExcessReason)) {
      return NextResponse.json({ error: "Invalid reason" }, { status: 400 })
    }
    if (unitBuy !== undefined && (typeof unitBuy !== "number" || unitBuy < 1)) {
      return NextResponse.json({ error: "unitBuy must be a positive number" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateExcessRow(rowNumber, {
      event,
      items,
      unitBuy,
      receipt,
      reason: reason as ExcessReason | undefined,
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update excess row:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    await withActor(session.user.email, (tx) => deleteExcessRow(rowNumber, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete excess row:", err)
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
  }
}
