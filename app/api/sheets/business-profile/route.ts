import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import { getBusinessProfile, updateBusinessProfile, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const profile = await cached("business-profile", getBusinessProfile)
    return NextResponse.json({ profile }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch business profile:", err)
    return NextResponse.json({ error: "Failed to fetch business profile" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const profile = {
      bankAccountHolder: String(body.bankAccountHolder ?? ""),
      bankAccountLines: String(body.bankAccountLines ?? ""),
      ownerName: String(body.ownerName ?? ""),
      storeName: String(body.storeName ?? ""),
      phoneNumber: String(body.phoneNumber ?? ""),
      publicSiteUrl: String(body.publicSiteUrl ?? ""),
      dpPercent: Number(body.dpPercent) || 0,
    }

    await withActor(session.user.email, (tx) => updateBusinessProfile(profile, tx))
    invalidate("business-profile")
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update business profile:", err)
    return NextResponse.json({ error: "Failed to update business profile" }, { status: 500 })
  }
}
