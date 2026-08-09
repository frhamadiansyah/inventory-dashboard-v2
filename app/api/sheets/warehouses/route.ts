import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getWarehouses } from "@/lib/db"
import { cached } from "@/lib/route-cache"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  try {
    const rows = await cached("warehouses", getWarehouses)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch warehouses:", err)
    return NextResponse.json({ error: "Failed to fetch warehouses" }, { status: 500 })
  }
}
