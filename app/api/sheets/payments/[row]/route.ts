import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, isAdmin } from "@/lib/api"
import { updatePayment, togglePaymentChecked, updatePaymentRemarks, deletePayment, getPaymentChecked, withActor } from "@/lib/db"

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
    const { event, customer, amount, account, isChecked, payDate, remarks } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    // Admins cannot change the checked status — preserve the stored value.
    const isCheckedValue = isAdmin(session)
      ? await getPaymentChecked(rowNumber)
      : Boolean(isChecked)

    await withActor(session.user.email, (tx) => updatePayment(rowNumber, {
      event: String(event),
      customer: String(customer),
      amount: Number(amount ?? 0),
      account: String(account ?? ""),
      isChecked: isCheckedValue,
      payDate: String(payDate ?? ""),
      remarks: String(remarks ?? ""),
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update payment:", err)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
  }
}

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

    // Toggling the checked status is the one payment action admins cannot perform.
    if (typeof body.isChecked === "boolean") {
      if (isAdmin(session)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      await withActor(session.user.email, (tx) => togglePaymentChecked(rowNumber, body.isChecked, tx))
      return NextResponse.json({ success: true })
    }

    // Remarks are freely editable inline (admins included).
    if (typeof body.remarks === "string") {
      await withActor(session.user.email, (tx) => updatePaymentRemarks(rowNumber, body.remarks, tx))
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: "isChecked (boolean) or remarks (string) is required" }, { status: 400 })
  } catch (err) {
    console.error("Failed to patch payment:", err)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
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
    await withActor(session.user.email, (tx) => deletePayment(rowNumber, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete payment:", err)
    return NextResponse.json({ error: "Failed to delete payment" }, { status: 500 })
  }
}
