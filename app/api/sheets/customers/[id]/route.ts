import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updateCustomer, deleteCustomer, parseOngkir, withActor } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    const instagramId = String(body.instagramId ?? "").trim()
    if (!instagramId) {
      return NextResponse.json({ error: "instagramId is required" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateCustomer(id, {
      instagramId,
      name: String(body.name ?? "").trim(),
      whatsapp: String(body.whatsapp ?? "").trim(),
      dataDiri: String(body.dataDiri ?? "").trim(),
      ekspedisi: String(body.ekspedisi ?? "").trim(),
      ongkir: parseOngkir(body.ongkir),
      bankName: String(body.bankName ?? "").trim(),
      bankAccountNumber: String(body.bankAccountNumber ?? "").trim(),
      bankAccountHolder: String(body.bankAccountHolder ?? "").trim(),
    }, tx))

    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return NextResponse.json({ error: "A customer with that Instagram ID already exists" }, { status: 409 })
    }
    console.error("Failed to update customer:", err)
    return NextResponse.json({ error: "Failed to update customer" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    await withActor(session.user.email, (tx) => deleteCustomer(id, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("foreign key") || msg.includes("violates")) {
      return NextResponse.json(
        { error: "Cannot delete — this customer has orders, shipments, or payments referencing them" },
        { status: 409 },
      )
    }
    console.error("Failed to delete customer:", err)
    return NextResponse.json({ error: "Failed to delete customer" }, { status: 500 })
  }
}
