import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, isAdmin } from "@/lib/api"
import { getPaymentRows, getPaymentsPaginated, addPayment, withActor } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams

  try {
    // Paginated page of rows when ?page is present (the dashboard table).
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const checkedParam = params.get("isChecked")
      const result = await getPaymentsPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        event: params.get("event") ?? undefined,
        customer: params.get("customer") ?? undefined,
        account: params.get("account") ?? undefined,
        remarks: params.get("remarks") ?? undefined,
        kind: params.get("kind") ?? undefined,
        dateFrom: params.get("dateFrom") ?? undefined,
        dateTo: params.get("dateTo") ?? undefined,
        isChecked: checkedParam == null ? undefined : checkedParam === "true",
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        skipCount: params.get("skipCount") === "true",
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise the full list (back-compat for any non-paginated caller).
    const rows = await getPaymentRows()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch payments:", err)
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, customer, amount, account, isChecked, payDate, remarks } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addPayment({
      event: String(event),
      customer: String(customer),
      amount: Number(amount ?? 0),
      account: String(account ?? ""),
      // Admins cannot confirm payments — new payments are always unchecked.
      isChecked: isAdmin(session) ? false : Boolean(isChecked),
      payDate: String(payDate ?? ""),
      remarks: String(remarks ?? ""),
    }, tx))

    return NextResponse.json({ success: true, rowNumber: result.rowNumber })
  } catch (err) {
    console.error("Failed to add payment:", err)
    return NextResponse.json({ error: "Failed to add payment" }, { status: 500 })
  }
}
