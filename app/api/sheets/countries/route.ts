import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCountries, addCountry, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const rows = await cached("countries", getCountries)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch countries:", err)
    return NextResponse.json({ error: "Failed to fetch countries" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const { name, currency, kurs, cargoPerKg } = body

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addCountry({
      name: String(name),
      currency: String(currency ?? ""),
      kurs: Number(kurs ?? 0),
      cargoPerKg: Number(cargoPerKg ?? 0),
    }, tx))
    invalidate("countries")

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to add country:", err)
    return NextResponse.json({ error: "Failed to add country" }, { status: 500 })
  }
}
