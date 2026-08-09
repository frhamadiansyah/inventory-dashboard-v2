import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getExcessPurchaseRows, bulkUpdateExcessArrive, withActor } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

/** Mark units of a single excess-purchase row arrived. No customer allocation
 *  involved — this just advances that row's own dispatch -> arrive stage. */
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
    const body = await req.json().catch(() => ({})) as { qty?: number }
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "qty must be a positive number" }, { status: 400 })
    }

    const excessRow = (await getExcessPurchaseRows()).find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    const current = excessRow.unitArrive ?? 0
    const cap = (excessRow.unitDispatch ?? 0) - current
    if (qty > cap) {
      return NextResponse.json({ error: `Only ${cap} unit(s) pending arrival` }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => bulkUpdateExcessArrive(
      [{ rowNumber, unitArrive: current + qty }],
      tx,
    ))

    return NextResponse.json({ success: true, unitArrive: current + qty })
  } catch (err) {
    console.error("Failed to mark excess arrived:", err)
    return NextResponse.json({ error: "Failed to mark arrived" }, { status: 500 })
  }
}
