import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updateAdjustment, deleteAdjustment, withActor } from "@/lib/db"

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
    const { event, customer, description, amount } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateAdjustment(rowNumber, {
      event: String(event),
      customer: String(customer),
      description: String(description ?? ""),
      amount: Number(amount ?? 0),
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update adjustment:", err)
    return NextResponse.json({ error: "Failed to update adjustment" }, { status: 500 })
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
    await withActor(session.user.email, (tx) => deleteAdjustment(rowNumber, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete adjustment:", err)
    return NextResponse.json({ error: "Failed to delete adjustment" }, { status: 500 })
  }
}
