import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getProductIndo, addProductIndo, updateProductIndo, withActor } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    return NextResponse.json(await getProductIndo())
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
    const { product, store, price } = await req.json()
    if (!String(product ?? "").trim()) return NextResponse.json({ error: "product is required" }, { status: 400 })
    if (!String(store ?? "").trim()) return NextResponse.json({ error: "store is required" }, { status: 400 })
    const p = Number(price) || 0
    const { rowNumber } = await withActor(session.user.email, (tx) => addProductIndo({
      product: String(product).trim(),
      store: String(store).trim(),
      price: p,
    }, tx))
    return NextResponse.json({
      rowNumber,
      product: String(product).trim(),
      store: String(store).trim(),
      price: p,
    })
  } catch (err) {
    console.error("Failed to add product:", err)
    return NextResponse.json({ error: "Failed to add" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const { rowNumber, product, store, price } = await req.json()
    if (!rowNumber) return NextResponse.json({ error: "rowNumber is required" }, { status: 400 })
    if (!String(product ?? "").trim()) return NextResponse.json({ error: "product is required" }, { status: 400 })
    if (!String(store ?? "").trim()) return NextResponse.json({ error: "store is required" }, { status: 400 })
    await withActor(session.user.email, (tx) => updateProductIndo(rowNumber, {
      product: String(product).trim(),
      store: String(store).trim(),
      price: Number(price) || 0,
    }, tx))
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update product:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
