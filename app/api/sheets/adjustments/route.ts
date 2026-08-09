import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getAdjustmentRows, getAdjustmentsPaginated, getDistinctAdjustmentDescriptions, addAdjustment, withActor } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams

  try {
    // Lightweight path for the description picker (adjustments form + the
    // invoice page's per-row "+ Adjustment" modals).
    if (params.get("meta") === "descriptions") {
      const descriptions = await getDistinctAdjustmentDescriptions()
      return NextResponse.json({ descriptions }, { headers: { "Cache-Control": "no-store" } })
    }

    // Paginated page of rows when ?page is present (the dashboard table).
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const result = await getAdjustmentsPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        event: params.get("event") ?? undefined,
        customer: params.get("customer") ?? undefined,
        description: params.get("description") ?? undefined,
        dateFrom: params.get("dateFrom") ?? undefined,
        dateTo: params.get("dateTo") ?? undefined,
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        skipCount: params.get("skipCount") === "true",
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise the full list (back-compat for any non-paginated caller).
    const rows = await getAdjustmentRows()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch adjustments:", err)
    return NextResponse.json({ error: "Failed to fetch adjustments" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, customer, description, amount } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addAdjustment({
      event: String(event),
      customer: String(customer),
      description: String(description ?? ""),
      amount: Number(amount ?? 0),
    }, tx))

    return NextResponse.json({ success: true, rowNumber: result.rowNumber })
  } catch (err) {
    console.error("Failed to add adjustment:", err)
    return NextResponse.json({ error: "Failed to add adjustment" }, { status: 500 })
  }
}
