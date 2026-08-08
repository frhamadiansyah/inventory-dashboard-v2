import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  updateProduct, deleteProduct, setProductActive, getProductPricingContext, withActor,
} from "@/lib/db"
import { computeProductPrice, PricingInputError } from "@/lib/pricing-server"
import { toFlatFeeMode, toPricingMethod } from "@/lib/pricing"

type Params = { params: Promise<{ id: string }> }

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
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive (boolean) is required" }, { status: 400 })
    }
    await withActor(session.user.email, (tx) => setProductActive(id, body.isActive, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to toggle product active:", err)
    return NextResponse.json({ error: "Failed to update product" }, { status: 500 })
  }
}

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
    if (!String(body.name ?? "").trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    await withActor(session.user.email, async (tx) => {
      const current = await getProductPricingContext(id, tx)

      // This is a FULL-ROW update, and several callers rebuild the whole payload
      // just to change one field (e.g. the inline store editor). Treat an absent
      // pricingMethod or countryId as "leave it alone" so those callers can't
      // accidentally reclassify a product or strip its country; an explicit null
      // still clears the country.
      //
      // countryId matters especially for Tier Kurs, whose rate is DERIVED from it:
      // treating absent as null would find no brackets, collapse the spread to 0,
      // and silently reprice the product down to bare cost with no error.
      const pricingMethod =
        body.pricingMethod === undefined
          ? current.pricingMethod
          : toPricingMethod(body.pricingMethod)
      // Same keep-if-absent rule as pricingMethod: a caller that rebuilds the row to change
      // one field must not silently flip a percent-mode Flat Fee row back to fixed.
      const flatFeeMode =
        body.flatFeeMode === undefined
          ? current.flatFeeMode
          : toFlatFeeMode(body.flatFeeMode)
      const countryId =
        body.countryId === undefined
          ? current.countryId
          : body.countryId != null
            ? Number(body.countryId)
            : null

      const priced = await computeProductPrice({
        pricingMethod,
        flatFeeMode,
        countryId,
        body,
        db: tx,
        current: { price: current.price, tieredKurs: current.tieredKurs, profitFixed: current.profitFixed },
      })

      return updateProduct(id, {
        name: String(body.name).trim(),
        store: String(body.store ?? "").trim(),
        price: priced.price,
        gram: Number(body.gram) || 0,
        // The resolved countryId, not the raw body value: otherwise country_id
        // could go NULL while tiered_kurs was resolved from the old country, and
        // the row would contradict itself.
        countryId,
        valas: Number(body.valas) || 0,
        kurs: Number(body.kurs) || 0,
        tieredKurs: priced.tieredKurs,
        cargoPerKg: Number(body.cargoPerKg) || 0,
        profitPct: Number(body.profitPct) || 0,
        operationalFee: Number(body.operationalFee ?? 5000),
        packingFee: Number(body.packingFee ?? 5000),
        // priced.cost is non-null only for the two valas fee modes, where cost is landed
        // cost rather than a typed figure and the server resolves it.
        //
        // `|| 0` inside the parens rather than a third `??` — see the POST handler: NaN is
        // neither null nor undefined, so `??` would let it through to an INTEGER column.
        cost: priced.cost ?? (Number(body.cost) || 0),
        // Server-resolved for flat_fee, the body's own value otherwise.
        profitFixed: priced.profitFixed ?? (Number(body.profitFixed) || 0),
        pricingMethod,
        flatFeeMode,
      }, tx)
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    // The caller sent pricing inputs that cannot produce a price — a Rate row with no
    // country, say. Their problem, not ours, so 400 with the reason rather than a 500.
    if (err instanceof PricingInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error("Failed to update product:", err)
    return NextResponse.json({ error: "Failed to update product" }, { status: 500 })
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
    await withActor(session.user.email, (tx) => deleteProduct(id, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete product:", err)
    return NextResponse.json({ error: "Failed to delete product" }, { status: 500 })
  }
}
