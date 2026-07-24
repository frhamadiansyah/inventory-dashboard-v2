import sql from "../db-pool"
import { tsToString } from "./helpers"
import type { DBExecutor } from "./actor"
import type { OperationalExpenseRow, ExpenseCategory } from "./types"

// ─── Operational expenses ────────────────────────────────────────────────────
//
// Per-event operating/trip costs (the old "Operational_2026" sheet). Owner-only
// feature; see app/api/sheets/operational-expenses/route.ts for the auth guard.

// postgres-js returns NUMERIC columns (amount_foreign, rate) as strings, and a
// DATE as a Date — coerce both here. Shared by the list and paginated queries.
function mapExpenseRow(r: Record<string, unknown>): OperationalExpenseRow {
  return {
    rowNumber: r.id as number,
    event: (r.event as string) ?? "",
    expenseDate: r.expense_date ? new Date(r.expense_date as string).toISOString().slice(0, 10) : "",
    description: (r.description as string) ?? "",
    category: (r.category as ExpenseCategory) ?? "Shop",
    amountForeign: Number(r.amount_foreign) || 0,
    rate: Number(r.rate) || 0,
    amountIdr: (r.amount_idr as number) ?? 0,
    isSettled: Boolean(r.is_settled),
    method: (r.method as string) ?? "",
    remarks: (r.remarks as string) ?? "",
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }
}

export interface PaginatedOperationalExpenses {
  rows: OperationalExpenseRow[]
  totalCount: number
  filteredSum: number | null  // null when skipCount=true (use cached value client-side)
  cogsSum: number | null      // Shop + Cargo — null when skipCount=true
  opexSum: number | null      // everything except Shop, Cargo, Dividend — null when skipCount=true
  page: number
  pageSize: number
  totalPages: number
}

/** See PRODUCTS_TOTAL_COUNT_UNCHANGED in catalog.ts — same skipCount sentinel. */
export const OPERATIONAL_EXPENSES_TOTAL_COUNT_UNCHANGED = -1

/** Distinct, non-empty payment methods — for the add/edit method autocomplete. */
export async function getExpenseMethods(): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT method FROM operational_expenses
    WHERE method IS NOT NULL AND method != ''
    ORDER BY method
  `
  return rows.map((r) => r.method as string)
}

/** Distinct, non-empty categories actually in use — merged with the suggested
 *  EXPENSE_CATEGORIES list client-side so custom categories persist as options
 *  for everyone (category is free text; see migration 038). */
export async function getExpenseCategories(): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT category FROM operational_expenses
    WHERE category IS NOT NULL AND category != ''
    ORDER BY category
  `
  return rows.map((r) => r.category as string)
}

/**
 * One page of operational expenses with server-side search/filter/sort.
 * Mirrors getProductsPaginated (catalog.ts).
 */
export async function getOperationalExpensesPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  event?: string
  category?: string
  method?: string
  settled?: string // "true" / "false"; anything else = no filter
  dateFrom?: string // inclusive, YYYY-MM-DD
  dateTo?: string   // inclusive, YYYY-MM-DD
  sortKey?: string
  sortDir?: "asc" | "desc"
  skipCount?: boolean
}): Promise<PaginatedOperationalExpenses> {
  const { page, pageSize, search, event, category, method, settled, dateFrom, dateTo, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number | boolean)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(
      `(lower(e.event) LIKE ${p} OR lower(e.description) LIKE ${p} ` +
      `OR lower(e.method) LIKE ${p} OR lower(e.remarks) LIKE ${p} ` +
      `OR lower(e.category) LIKE ${p} ` +
      `OR e.amount_foreign::text LIKE ${p} OR e.amount_idr::text LIKE ${p})`,
    )
  }
  if (event) {
    params.push(`%${event.toLowerCase()}%`)
    conditions.push(`lower(e.event) LIKE $${params.length}`)
  }
  if (category) {
    params.push(`%${category.toLowerCase()}%`)
    conditions.push(`lower(e.category) LIKE $${params.length}`)
  }
  if (method) {
    params.push(`%${method.toLowerCase()}%`)
    conditions.push(`lower(e.method) LIKE $${params.length}`)
  }
  if (settled === "true" || settled === "false") {
    params.push(settled === "true")
    conditions.push(`e.is_settled = $${params.length}`)
  }
  if (dateFrom) {
    params.push(dateFrom)
    conditions.push(`e.expense_date >= $${params.length}`)
  }
  if (dateTo) {
    params.push(dateTo)
    conditions.push(`e.expense_date <= $${params.length}`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    id: "e.id",
    event: "e.event",
    expenseDate: "e.expense_date",
    description: "e.description",
    category: "e.category",
    amountForeign: "e.amount_foreign",
    rate: "e.rate",
    amountIdr: "e.amount_idr",
    isSettled: "e.is_settled",
    method: "e.method",
    createdAt: "e.created_at",
    updatedAt: "e.updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "e.id"
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC"

  const selectCols =
    `e.id, e.event, e.expense_date, e.description, e.category, ` +
    `e.amount_foreign, e.rate, e.amount_idr, e.is_settled, e.method, ` +
    `e.remarks, e.created_at, e.updated_at`

  const dataQuery = sql.unsafe(
    `SELECT ${selectCols}
     FROM operational_expenses e
     ${where}
     ORDER BY ${sortCol} ${sortDir}, e.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  if (skipCount) {
    const dataRows = await dataQuery
    return {
      rows: dataRows.map(mapExpenseRow),
      totalCount: OPERATIONAL_EXPENSES_TOTAL_COUNT_UNCHANGED,
      filteredSum: null,
      cogsSum: null,
      opexSum: null,
      page,
      pageSize,
      totalPages: OPERATIONAL_EXPENSES_TOTAL_COUNT_UNCHANGED,
    }
  }

  const countQuery = sql.unsafe(
    `SELECT COUNT(*)::int AS c FROM operational_expenses e ${where}`,
    params,
  )
  // COGS = Shop + Cargo. OPEX = everything else except Shop, Cargo, Dividend
  // (Dividend is a payout, not an operating expense — excluded from both).
  const sumQuery = sql.unsafe(
    `SELECT
       COALESCE(SUM(e.amount_idr), 0)::bigint AS s,
       COALESCE(SUM(e.amount_idr) FILTER (WHERE lower(e.category) IN ('shop', 'cargo')), 0)::bigint AS cogs,
       COALESCE(SUM(e.amount_idr) FILTER (WHERE lower(e.category) NOT IN ('shop', 'cargo', 'dividend')), 0)::bigint AS opex
     FROM operational_expenses e ${where}`,
    params,
  )

  const [dataRows, countRows, sumRows] = await Promise.all([dataQuery, countQuery, sumQuery])
  const totalCount = Number(countRows[0]?.c ?? 0)
  const filteredSum = Number(sumRows[0]?.s ?? 0)
  const cogsSum = Number(sumRows[0]?.cogs ?? 0)
  const opexSum = Number(sumRows[0]?.opex ?? 0)
  return {
    rows: dataRows.map(mapExpenseRow),
    totalCount,
    filteredSum,
    cogsSum,
    opexSum,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

export async function addOperationalExpense(data: {
  event: string
  expenseDate: string
  description: string
  category: ExpenseCategory
  amountForeign: number
  rate: number
  amountIdr: number
  isSettled: boolean
  method: string
  remarks: string
}, db: DBExecutor = sql): Promise<{ rowNumber: number }> {
  const [row] = await db`
    INSERT INTO operational_expenses
      (event, expense_date, description, category, amount_foreign, rate,
       amount_idr, is_settled, method, remarks)
    VALUES
      (${data.event || null}, ${data.expenseDate || null}, ${data.description},
       ${data.category}, ${data.amountForeign}, ${data.rate}, ${data.amountIdr},
       ${data.isSettled}, ${data.method}, ${data.remarks})
    RETURNING id
  `
  return { rowNumber: row.id }
}

export async function updateOperationalExpense(
  rowNumber: number,
  data: {
    event: string
    expenseDate: string
    description: string
    category: ExpenseCategory
    amountForeign: number
    rate: number
    amountIdr: number
    isSettled: boolean
    method: string
    remarks: string
  },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE operational_expenses
    SET event = ${data.event || null}, expense_date = ${data.expenseDate || null},
        description = ${data.description}, category = ${data.category},
        amount_foreign = ${data.amountForeign}, rate = ${data.rate},
        amount_idr = ${data.amountIdr}, is_settled = ${data.isSettled},
        method = ${data.method}, remarks = ${data.remarks}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function toggleOperationalExpenseSettled(
  rowNumber: number,
  isSettled: boolean,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE operational_expenses SET is_settled = ${isSettled}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updateOperationalExpenseRemarks(
  rowNumber: number,
  remarks: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE operational_expenses SET remarks = ${remarks}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deleteOperationalExpense(rowNumber: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM operational_expenses WHERE id = ${rowNumber}`
}
