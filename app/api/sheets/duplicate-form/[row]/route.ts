import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updateFormRow, updateFormRowStage2, updateFormRowStage3, updateOrderOwnerCell, updateOrderNote, updateOrderReceipt, updateOrderDispatchReceipt, deleteFormRow, returnOrderUnitsToExcess, withActor } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
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
    const stage = String(body.stage ?? "1")

    if (stage === "2") {
      // Owner only
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const { unitBuy, receipt } = body
      if (unitBuy == null) {
        return NextResponse.json({ error: "unitBuy is required" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateFormRowStage2(rowNumber, {
        unitBuy: Number(unitBuy),
        receipt: receipt ? String(receipt) : "",
      }, tx))

    } else if (stage === "3") {
      const { unitArrive, unitShip, unitHold } = body
      if (unitArrive == null || unitShip == null || unitHold == null) {
        return NextResponse.json({ error: "unitArrive, unitShip, unitHold are required" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateFormRowStage3(rowNumber, {
        unitArrive: Number(unitArrive),
        unitShip: Number(unitShip),
        unitHold: Number(unitHold),
      }, tx))

    } else if (stage === "owner_cell") {
      // Owner-only inline cell edit from the List Order table — updates one
      // column at a time so sibling fields (unit_hold, receipt, etc.) aren't
      // clobbered by what was meant to be a partial edit.
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const { column, value } = body
      if (column !== "unit_buy" && column !== "unit_arrive" && column !== "unit_dispatch") {
        return NextResponse.json({ error: "Invalid column" }, { status: 400 })
      }
      const numericValue = value == null || value === "" ? null : Number(value)
      if (numericValue !== null && !Number.isFinite(numericValue)) {
        return NextResponse.json({ error: "value must be a number or null" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateOrderOwnerCell(rowNumber, column, numericValue, tx))

    } else if (stage === "receipt_cell") {
      // Inline receipt edit — owner-only (receipt is set during purchasing).
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const receipt = body.value == null ? "" : String(body.value)
      await withActor(session.user.email, (tx) => updateOrderReceipt(rowNumber, receipt, tx))

    } else if (stage === "dispatch_receipt_cell") {
      // Inline dispatch-receipt edit — owner-only (dispatch_receipt is set/appended
      // during dispatch, and had no edit path until now).
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const dispatchReceipt = body.value == null ? "" : String(body.value)
      await withActor(session.user.email, (tx) => updateOrderDispatchReceipt(rowNumber, dispatchReceipt, tx))

    } else if (stage === "note_cell") {
      // Inline note edit from the List Order table. Notes are not owner-only
      // (admins edit them via the modal too), so role access is sufficient.
      const note = body.value == null ? "" : String(body.value)
      await withActor(session.user.email, (tx) => updateOrderNote(rowNumber, note, tx))

    } else if (stage === "return_excess") {
      // Owner-only: remove units from this order and bank the bought-but-not-
      // yet-arrived surplus into excess_purchase (reverting a mistaken order).
      if (session.user.role !== "owner") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const removeUnits = Number(body.removeUnits)
      if (!Number.isInteger(removeUnits) || removeUnits < 1) {
        return NextResponse.json({ error: "removeUnits must be a positive integer" }, { status: 400 })
      }
      try {
        const result = await withActor(session.user.email, (tx) => returnOrderUnitsToExcess(rowNumber, removeUnits, tx))
        return NextResponse.json({ success: true, ...result })
      } catch (e) {
        // Guard violations (e.g. units already arrived) are user-actionable.
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "Failed to return units" },
          { status: 400 },
        )
      }

    } else {
      // Stage 1 — order details
      const { event, customer, productId, unitPrice, unit, note } = body
      // `unit == null` (not `!unit`) so 0 is accepted — admins occasionally
      // zero out an order to cancel it while keeping the row for history.
      if (!event || !customer || !productId || unit == null) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
      }
      await withActor(session.user.email, (tx) => updateFormRow(rowNumber, {
        event: String(event),
        customer: String(customer),
        productId: Number(productId),
        unitPrice: Number(unitPrice ?? 0),
        unit: Number(unit),
        note: note ? String(note) : "",
      }, tx))
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update row:", err)
    return NextResponse.json({ error: "Failed to update row" }, { status: 500 })
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
    await withActor(session.user.email, (tx) => deleteFormRow(rowNumber, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete row:", err)
    return NextResponse.json({ error: "Failed to delete row" }, { status: 500 })
  }
}
