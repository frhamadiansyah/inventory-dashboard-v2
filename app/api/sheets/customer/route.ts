import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { lookupCustomerDetail, updateCustomerBankInfo, withActor } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = req.nextUrl.searchParams.get("id")?.trim()
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

  try {
    const detail = await lookupCustomerDetail(id)
    return NextResponse.json(detail ?? null)
  } catch (err) {
    console.error("Failed to load customer detail:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const { instagramId, bankName, bankAccountNumber, bankAccountHolder } = await req.json()
    if (!instagramId?.trim()) {
      return NextResponse.json({ error: "instagramId is required" }, { status: 400 })
    }
    await withActor(session.user.email, (tx) => updateCustomerBankInfo(instagramId, {
      bankName: bankName ?? "",
      bankAccountNumber: bankAccountNumber ?? "",
      bankAccountHolder: bankAccountHolder ?? "",
    }, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update bank info:", err)
    return NextResponse.json({ error: "Failed to update bank info" }, { status: 500 })
  }
}
