import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  updateOperationalExpense,
  toggleOperationalExpenseSettled,
  updateOperationalExpenseRemarks,
  deleteOperationalExpense,
  withActor,
} from "@/lib/db"
import type { ExpenseCategory } from "@/lib/db/types"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    // event is optional — some operating costs aren't tied to a trip/event.
    const category = String(body.category ?? "").trim() as ExpenseCategory
    if (!category) {
      return NextResponse.json({ error: "category is required" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateOperationalExpense(id, {
      event: String(body.event ?? "").trim(),
      expenseDate: String(body.expenseDate ?? "").trim(),
      description: String(body.description ?? "").trim(),
      category,
      amountForeign: Number(body.amountForeign) || 0,
      rate: Number(body.rate) || 0,
      amountIdr: Math.round(Number(body.amountIdr) || 0),
      isSettled: Boolean(body.isSettled),
      method: String(body.method ?? "").trim(),
      remarks: String(body.remarks ?? "").trim(),
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update operational expense:", err)
    return NextResponse.json({ error: "Failed to update operational expense" }, { status: 500 })
  }
}

// Partial update: either a settled toggle or an inline remarks edit.
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    if (typeof body.isSettled === "boolean") {
      await withActor(session.user.email, (tx) => toggleOperationalExpenseSettled(id, body.isSettled, tx))
    } else if (typeof body.remarks === "string") {
      await withActor(session.user.email, (tx) => updateOperationalExpenseRemarks(id, body.remarks.trim(), tx))
    } else {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to patch operational expense:", err)
    return NextResponse.json({ error: "Failed to update operational expense" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    await withActor(session.user.email, (tx) => deleteOperationalExpense(id, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete operational expense:", err)
    return NextResponse.json({ error: "Failed to delete operational expense" }, { status: 500 })
  }
}
