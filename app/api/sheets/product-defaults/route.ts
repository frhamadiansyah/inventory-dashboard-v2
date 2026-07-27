import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import { getProductDefaults, updateProductDefaults, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const defaults = await cached("product-defaults", getProductDefaults)
    return NextResponse.json({ defaults }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch product defaults:", err)
    return NextResponse.json({ error: "Failed to fetch product defaults" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const profitPct = Number(body.profitPct)
    const operationalFee = Number(body.operationalFee)
    const packingFee = Number(body.packingFee)
    const markupPct = Number(body.markupPct)
    const tierKursRoundTo = Number(body.tierKursRoundTo)
    const flatFee = Number(body.flatFee)
    const flatFeePct = Number(body.flatFeePct)
    const flatFeeMin = Number(body.flatFeeMin)

    if (!Number.isFinite(profitPct) || !Number.isFinite(operationalFee) || !Number.isFinite(packingFee) || !Number.isFinite(markupPct)) {
      return NextResponse.json({ error: "profitPct, operationalFee, packingFee and markupPct must be numbers" }, { status: 400 })
    }
    // Guarded separately from the pre-fill fields: this one is a price input, and
    // it lands in an INTEGER column with a CHECK (>= 0). 0 is legal — it prices a
    // Flat Fee product at cost.
    if (!Number.isInteger(flatFee) || flatFee < 0) {
      return NextResponse.json({ error: "flatFee must be a whole number of 0 or more" }, { status: 400 })
    }
    // A price input too, but NUMERIC rather than INTEGER, so fractional rates like 4,5%
    // are legal. Bounded 0-100 to match the DB's CHECK, and returns a readable 400 rather
    // than letting Postgres raise one.
    if (!Number.isFinite(flatFeePct) || flatFeePct < 0 || flatFeePct > 100) {
      return NextResponse.json({ error: "flatFeePct must be a number between 0 and 100" }, { status: 400 })
    }
    // Lands in an INTEGER column with a CHECK (>= 0). 0 is legal and means no floor.
    if (!Number.isInteger(flatFeeMin) || flatFeeMin < 0) {
      return NextResponse.json({ error: "flatFeeMin must be a whole number of 0 or more" }, { status: 400 })
    }
    // Guarded separately: it divides in ceilTo(), and a 0 or negative step would
    // be a runtime hazard rather than just a bad default. The DB has a matching
    // CHECK (>= 1); this returns a readable 400 instead of a 500.
    if (!Number.isInteger(tierKursRoundTo) || tierKursRoundTo < 1) {
      return NextResponse.json({ error: "tierKursRoundTo must be a whole number of at least 1" }, { status: 400 })
    }

    // null is a real choice ("start the form on IDR"), so only a present-but-unusable value is
    // rejected. An id for a country that does not exist raises an FK violation, caught below.
    let defaultCountryId: number | null = null
    if (body.defaultCountryId != null) {
      defaultCountryId = Number(body.defaultCountryId)
      if (!Number.isInteger(defaultCountryId) || defaultCountryId < 1) {
        return NextResponse.json({ error: "defaultCountryId must be a country id or null" }, { status: 400 })
      }
    }

    try {
      await withActor(session.user.email, (tx) =>
        updateProductDefaults({
          profitPct, operationalFee, packingFee, markupPct, tierKursRoundTo, flatFee,
          flatFeePct, flatFeeMin, defaultCountryId,
        }, tx),
      )
    } catch (err) {
      // 23503 = foreign_key_violation: the country was deleted between the form loading and
      // this save. A 400 naming it beats the generic 500 below.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23503") {
        return NextResponse.json({ error: "Unknown country" }, { status: 400 })
      }
      throw err
    }
    invalidate("product-defaults")
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update product defaults:", err)
    return NextResponse.json({ error: "Failed to update product defaults" }, { status: 500 })
  }
}
