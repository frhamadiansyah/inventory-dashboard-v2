import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getCustomers, getCustomersPaginated, addCustomer, parseOngkir, withActor } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams

  try {
    // Paginated page of rows when ?page is present (the dashboard list).
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const result = await getCustomersPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        instagramId: params.get("instagramId") ?? undefined,
        name: params.get("name") ?? undefined,
        whatsapp: params.get("whatsapp") ?? undefined,
        ekspedisi: params.get("ekspedisi") ?? undefined,
        dataDiri: params.get("dataDiri") ?? undefined,
        bankName: params.get("bankName") ?? undefined,
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        balanceStatus: (params.get("balanceStatus") as "outstanding" | "overpayment" | "settled") ?? undefined,
        skipCount: params.get("skipCount") === "true",
        ongkirWarehouseId: params.get("ongkirWarehouseId") ? Number(params.get("ongkirWarehouseId")) : undefined,
        ongkirOp: (params.get("ongkirOp") as "eq" | "gt" | "lt" | "gte" | "lte") ?? undefined,
        ongkirValue: params.get("ongkirValue") ? Number(params.get("ongkirValue")) : undefined,
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise the full list (back-compat for any non-paginated caller).
    const rows = await getCustomers()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch customers:", err)
    return NextResponse.json({ error: "Failed to fetch customers" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const instagramId = String(body.instagramId ?? "").trim()
    if (!instagramId) {
      return NextResponse.json({ error: "instagramId is required" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addCustomer({
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

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return NextResponse.json({ error: "A customer with that Instagram ID already exists" }, { status: 409 })
    }
    console.error("Failed to add customer:", err)
    return NextResponse.json({ error: "Failed to add customer" }, { status: 500 })
  }
}
