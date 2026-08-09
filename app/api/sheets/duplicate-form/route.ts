import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getDuplicateFormRows, getDuplicateFormRowsPaginated } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const pageParam = params.get("page")

  try {
    if (pageParam) {
      const page = Math.max(1, parseInt(pageParam, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const result = await getDuplicateFormRowsPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        event: params.get("event") ?? undefined,
        customer: params.get("customer") ?? undefined,
        items: params.get("items") ?? undefined,
        note: params.get("note") ?? undefined,
        dateFrom: params.get("dateFrom") ?? undefined,
        dateTo: params.get("dateTo") ?? undefined,
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        newestFirst: params.get("newestFirst") === "true",
        skipCount: params.get("skipCount") === "true",
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    const limitParam = params.get("limit")
    const limit = limitParam ? parseInt(limitParam, 10) : undefined
    const rows = await getDuplicateFormRows(limit)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch Duplicate_Form rows:", err)
    return NextResponse.json({ error: "Failed to fetch rows" }, { status: 500 })
  }
}
