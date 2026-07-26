import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getProductsPaginated, getProductStores, addProduct, getCountries, withActor } from "@/lib/db"
import { computeProductPrice } from "@/lib/pricing-server"
import { toFlatFeeMode, toPricingMethod } from "@/lib/pricing"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams

  try {
    // Paginated rows when ?page is present.
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const result = await getProductsPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        name: params.get("name") ?? undefined,
        store: params.get("store") ?? undefined,
        type: params.get("type") ?? undefined,
        country: params.get("country") ?? undefined,
        valas: (params.get("valas") as "filled" | "blank" | null) ?? undefined,
        gram: (params.get("gram") as "filled" | "blank" | null) ?? undefined,
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        skipCount: params.get("skipCount") === "true",
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise return dropdown meta (countries + the full distinct store list).
    const [countries, stores] = await Promise.all([getCountries(), getProductStores()])
    return NextResponse.json({ countries, stores }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load products:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const { name, store } = body
    if (!String(name ?? "").trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const pricingMethod = toPricingMethod(body.pricingMethod)
    const flatFeeMode = toFlatFeeMode(body.flatFeeMode)
    const countryId = body.countryId != null ? Number(body.countryId) : null

    const result = await withActor(session.user.email, async (tx) => {
      // Tier Kurs and Flat Fee are recomputed server-side: their margin inputs
      // (the bracket rate, the flat fee) are looked up here and the body's are
      // ignored. Profit Margin and Tier Fee keep storing the client-computed price.
      const priced = await computeProductPrice({ pricingMethod, flatFeeMode, countryId, body, db: tx })

      return addProduct({
        name: String(name).trim(),
        store: String(store ?? "").trim(),
        price: priced.price,
        gram: Number(body.gram) || 0,
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
        // `|| 0` inside the parens, not a third `??`: overseas and Tier Kurs send no `cost`
        // at all, and `Number(undefined)` is NaN — which `??` passes straight through,
        // because NaN is neither null nor undefined. That reached the INTEGER column as
        // "NaN" and failed the whole insert.
        cost: priced.cost ?? (Number(body.cost) || 0),
        // Server-resolved for flat_fee, the body's own value otherwise.
        profitFixed: priced.profitFixed ?? (Number(body.profitFixed) || 0),
        pricingMethod,
        flatFeeMode,
      }, tx)
    })

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to add product:", err)
    return NextResponse.json({ error: "Failed to add product" }, { status: 500 })
  }
}
