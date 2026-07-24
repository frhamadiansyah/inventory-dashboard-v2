import sql from "../db-pool"
import { tsToString, normalizeCustomer } from "./helpers"
import type { DBExecutor } from "./actor"
import type { SheetOptions, ItemOption, OrderRow, FormRow, ExcessRow, ExcessReason, PurchaseUpdate, ArriveUpdate, DispatchUpdate } from "./types"

// ─── Options ────────────────────────────────────────────────────────────────

// Seed accounts so the Account picker isn't empty before any payment has used
// them — once a payment uses a new one it's picked up from the DB instead.
const FALLBACK_ACCOUNTS = ["BCA", "JAGO", "QRIS", "TRANSFER"]

export async function getSheetOptions(): Promise<SheetOptions> {
  const [eventsRows, productRows, customerRows, accountRows] = await Promise.all([
    sql`SELECT name, is_active FROM events ORDER BY created_at DESC, id DESC`,
    sql`SELECT id, name, store, price, is_active FROM products WHERE name != '' ORDER BY name`,
    sql`
      SELECT instagram_id FROM customers
      WHERE instagram_id NOT LIKE '\\_old%' AND instagram_id != 'gantialamat'
      ORDER BY instagram_id
    `,
    sql`SELECT DISTINCT account FROM payments WHERE account IS NOT NULL AND account != ''`,
  ])

  // Collapse handles that differ only by a leading "@" or case (legacy Sheets
  // imports stored e.g. "shinta.michiko" while app writes store "@shinta.michiko")
  // into a single canonical entry, so the picker shows each customer once.
  // The customers table is left untouched — this only de-dupes the options list.
  const customers = [
    ...new Set(customerRows.map((r) => normalizeCustomer(r.instagram_id))),
  ].sort()

  const accounts = [
    ...new Set([...FALLBACK_ACCOUNTS, ...accountRows.map((r) => r.account as string)]),
  ].sort()

  return {
    events: eventsRows.map((r) => r.name),
    activeEvents: eventsRows.filter((r) => r.is_active).map((r) => r.name),
    items: productRows.map((r) => ({ id: r.id, name: r.name, store: r.store, price: r.price, active: r.is_active })),
    customers,
    accounts,
  }
}

// ─── Orders (Duplicate_Form) ────────────────────────────────────────────────

export async function getDuplicateFormRows(limit?: number): Promise<FormRow[]> {
  let rows
  if (limit && limit > 0) {
    rows = await sql`
      SELECT * FROM (
        SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
               p.name AS product_name, o.unit, o.note,
               o.created_at, o.updated_at, o.unit_buy, o.receipt,
               o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
               c.data_diri AS customer_data_diri
        FROM orders o
        JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c
          ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
        ORDER BY o.id DESC LIMIT ${limit}
      ) sub ORDER BY id ASC
    `
  } else {
    rows = await sql`
      SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
             p.name AS product_name, o.unit, o.note,
             o.created_at, o.updated_at, o.unit_buy, o.receipt,
             o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
             c.data_diri AS customer_data_diri
      FROM orders o
      JOIN products p ON p.id = o.product_id
      LEFT JOIN customers c
        ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
      ORDER BY o.id ASC
    `
  }

  return rows.map(mapFormRow)
}

/**
 * Returns every order for a single event, ordered chronologically (id ASC).
 * Used by FIFO allocators in /api/sheets/arrive and /api/sheets/purchasing —
 * each route applies its own per-row eligibility filter on top.
 *
 * The win over `getDuplicateFormRows()` is scoping the read to one event so
 * we don't transfer the entire orders table across the wire each time.
 */
export async function getDuplicateFormRowsForEvent(event: string): Promise<FormRow[]> {
  const rows = await sql`
    SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
           p.name AS product_name, o.unit, o.note,
           o.created_at, o.updated_at, o.unit_buy, o.receipt,
           o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
           c.data_diri AS customer_data_diri
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN customers c
      ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
    WHERE o.event = ${event}
    ORDER BY o.id ASC
  `
  return rows.map(mapFormRow)
}

/**
 * Like getDuplicateFormRowsForEvent but for several events in one round-trip.
 * Used by the excess-purchase allocators, whose excess rows can span multiple
 * events: we scope the read to exactly those events instead of transferring the
 * entire orders table (the prior getDuplicateFormRows() behaviour). Returns []
 * for an empty event list so callers can skip the query entirely.
 */
export async function getDuplicateFormRowsForEvents(events: string[]): Promise<FormRow[]> {
  if (events.length === 0) return []
  const rows = await sql`
    SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
           p.name AS product_name, o.unit, o.note,
           o.created_at, o.updated_at, o.unit_buy, o.receipt,
           o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
           c.data_diri AS customer_data_diri
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN customers c
      ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
    WHERE o.event = ANY(${events})
    ORDER BY o.id ASC
  `
  return rows.map(mapFormRow)
}

/**
 * Like getDuplicateFormRowsForEvent but scoped by product name across ALL
 * events. Used by the excess-purchase allocators so an excess row can spill
 * into matching orders in other events (fill same event first, then oldest
 * elsewhere). Scoping to the handful of item names being applied keeps the read
 * bounded — we still don't transfer the whole orders table. Returns [] for an
 * empty item list so callers can skip the query.
 */
export async function getDuplicateFormRowsForItems(items: string[]): Promise<FormRow[]> {
  if (items.length === 0) return []
  const rows = await sql`
    SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
           p.name AS product_name, o.unit, o.note,
           o.created_at, o.updated_at, o.unit_buy, o.receipt,
           o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
           c.data_diri AS customer_data_diri
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN customers c
      ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
    WHERE p.name = ANY(${items})
    ORDER BY o.id ASC
  `
  return rows.map(mapFormRow)
}

export interface PaginatedFormRows {
  rows: FormRow[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * Sentinel value for {@link PaginatedFormRows.totalCount} when the caller
 * passed `skipCount: true`. Means "I already have the total from a prior
 * request with the same filters/search/sort — don't trust this field, reuse
 * your cached value." Avoids the O(N) `COUNT(*)` work when the user is just
 * paging through results without changing what's being counted.
 */
export const TOTAL_COUNT_UNCHANGED = -1

export async function getDuplicateFormRowsPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  event?: string
  customer?: string
  items?: string
  note?: string
  dateFrom?: string
  dateTo?: string
  sortKey?: string
  sortDir?: "asc" | "desc"
  newestFirst?: boolean
  /**
   * When true, skip the COUNT(*) query and return TOTAL_COUNT_UNCHANGED for
   * totalCount / totalPages. The caller is responsible for reusing the
   * previously cached count. Set this when only the page changed within an
   * otherwise identical query — the count cannot have changed.
   */
  skipCount?: boolean
}): Promise<PaginatedFormRows> {
  const { page, pageSize, search, event, customer, items, note, dateFrom, dateTo, newestFirst, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  // Column filters are "contains" in the UI (and on every client-side page),
  // so match them case-insensitively as substrings — not exact equality.
  if (event) {
    params.push(`%${event.toLowerCase()}%`)
    conditions.push(`lower(o.event) LIKE $${params.length}`)
  }
  if (customer) {
    params.push(`%${customer.toLowerCase()}%`)
    conditions.push(`lower(o.customer) LIKE $${params.length}`)
  }
  if (items) {
    params.push(`%${items.toLowerCase()}%`)
    conditions.push(`lower(p.name) LIKE $${params.length}`)
  }
  // Note presence filter: "has" = non-empty note, "none" = blank/null.
  if (note === "has") {
    conditions.push(`COALESCE(TRIM(o.note), '') <> ''`)
  } else if (note === "none") {
    conditions.push(`COALESCE(TRIM(o.note), '') = ''`)
  }
  // Inclusive date range on the order's created_at day (timestamptz → ::date).
  if (dateFrom) {
    params.push(dateFrom)
    conditions.push(`o.created_at::date >= $${params.length}`)
  }
  if (dateTo) {
    params.push(dateTo)
    conditions.push(`o.created_at::date <= $${params.length}`)
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(`(lower(o.event) LIKE ${p} OR lower(o.customer) LIKE ${p} OR lower(p.name) LIKE ${p} OR lower(o.note) LIKE ${p} OR CAST(o.unit AS TEXT) LIKE ${p})`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    event: "o.event", customer: "o.customer", items: "p.name",
    unit: "o.unit", unitPrice: "o.unit_price", note: "o.note", createdAt: "o.created_at",
    unitBuy: "o.unit_buy", receipt: "o.receipt",
    unitArrive: "o.unit_arrive", unitShip: "o.unit_ship", unitHold: "o.unit_hold",
    unitDispatch: "o.unit_dispatch",
    updatedAt: "o.updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "o.id"
  const sortDir = opts.sortDir === "desc" || (!opts.sortKey && newestFirst) ? "DESC" : "ASC"

  // Rows query: LIMIT/OFFSET means this is bounded work even on a big table.
  // The customers LEFT JOIN is here (not in the count) because hasAddress is
  // read off it for each rendered row.
  const dataQuery = sql.unsafe(
    `SELECT o.id, o.event, o.customer, o.product_id, o.unit_price,
            p.name AS product_name, o.unit, o.note,
            o.created_at, o.updated_at, o.unit_buy, o.receipt,
            o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
            c.data_diri AS customer_data_diri
     FROM orders o
     JOIN products p ON p.id = o.product_id
     LEFT JOIN customers c
       ON lower(replace(c.instagram_id, '@', '')) = lower(replace(o.customer, '@', ''))
     ${where}
     ORDER BY ${sortCol} ${sortDir}, o.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  if (skipCount) {
    const dataRows = await dataQuery
    return {
      rows: dataRows.map(mapFormRow),
      totalCount: TOTAL_COUNT_UNCHANGED,
      page,
      pageSize,
      totalPages: TOTAL_COUNT_UNCHANGED,
    }
  }

  // Count query: mirrors the rows query's WHERE but omits the customers join
  // (LEFT JOIN can't change row count) so the planner has less to do.
  const countQuery = sql.unsafe(
    `SELECT COUNT(*)::int AS c
     FROM orders o
     JOIN products p ON p.id = o.product_id
     ${where}`,
    params,
  )

  const [dataRows, countRows] = await Promise.all([dataQuery, countQuery])
  const totalCount = Number(countRows[0]?.c ?? 0)
  return {
    rows: dataRows.map(mapFormRow),
    totalCount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

function mapFormRow(r: Record<string, unknown>): FormRow {
  // NULL means the customer row doesn't exist (yet); treat as no address.
  const dataDiri = (r.customer_data_diri as string | null) ?? ""
  return {
    rowNumber: r.id as number,
    event: r.event as string,
    customer: r.customer as string,
    productId: r.product_id as number,
    items: r.product_name as string,
    unitPrice: r.unit_price as number,
    unit: r.unit as number,
    note: r.note as string,
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
    unitBuy: (r.unit_buy as number) ?? null,
    receipt: (r.receipt as string) ?? "",
    unitArrive: (r.unit_arrive as number) ?? null,
    unitShip: (r.unit_ship as number) ?? null,
    unitDispatch: (r.unit_dispatch as number) ?? null,
    dispatchReceipt: (r.dispatch_receipt as string) ?? "",
    unitHold: (r.unit_hold as number) ?? null,
    hasAddress: dataDiri.trim().length > 0,
  }
}

export async function appendOrders(orders: OrderRow[], db: DBExecutor = sql): Promise<void> {
  if (orders.length === 0) return

  const normalized = orders.map((o) => ({
    ...o,
    customer: normalizeCustomer(o.customer),
  }))

  // Auto-create customer records for any new customers
  const uniqueCustomers = [...new Set(normalized.map((o) => o.customer))]
  await db`
    INSERT INTO customers (instagram_id)
    VALUES ${db(uniqueCustomers.map((c) => [c]))}
    ON CONFLICT (instagram_id) DO NOTHING
  `

  await db`
    INSERT INTO orders ${db(
      normalized.map((o) => ({
        event: o.event,
        customer: o.customer,
        product_id: o.productId,
        unit_price: o.unitPrice,
        unit: o.unit,
        note: o.note,
      }))
    )}
  `
}

export async function updateFormRow(
  rowNumber: number,
  data: Pick<FormRow, "event" | "customer" | "productId" | "unitPrice" | "unit" | "note">,
  db: DBExecutor = sql,
): Promise<void> {
  const customer = normalizeCustomer(data.customer)
  // Auto-create customer record if it doesn't exist
  await db`
    INSERT INTO customers (instagram_id) VALUES (${customer})
    ON CONFLICT (instagram_id) DO NOTHING
  `
  await db`
    UPDATE orders
    SET event = ${data.event}, customer = ${customer}, product_id = ${data.productId},
        unit_price = ${data.unitPrice}, unit = ${data.unit}, note = ${data.note},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updateFormRowStage2(
  rowNumber: number,
  data: { unitBuy: number; receipt: string },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE orders
    SET unit_buy = ${data.unitBuy}, receipt = ${data.receipt}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updateFormRowStage3(
  rowNumber: number,
  data: { unitArrive: number; unitShip: number; unitHold: number },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE orders
    SET unit_arrive = ${data.unitArrive}, unit_ship = ${data.unitShip},
        unit_hold = ${data.unitHold}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

/**
 * Owner-only edit of a single quantity column on an order row, used by both
 * the List Order table's inline cells and its edit modal. Updates exactly one
 * column so sibling fields (e.g. unit_hold, receipt) aren't clobbered by a
 * partial edit. Kept separate from Stages 2/3 so the purchasing/arrival flow
 * contracts (which write multiple columns together) aren't entangled with
 * one-off manual fixes.
 */
export async function updateOrderOwnerCell(
  rowNumber: number,
  column: "unit_buy" | "unit_arrive" | "unit_dispatch",
  value: number | null,
  db: DBExecutor = sql,
): Promise<void> {
  if (column === "unit_buy") {
    await db`
      UPDATE orders
      SET unit_buy = ${value}, updated_at = NOW()
      WHERE id = ${rowNumber}
    `
  } else if (column === "unit_dispatch") {
    await db`
      UPDATE orders
      SET unit_dispatch = ${value}, updated_at = NOW()
      WHERE id = ${rowNumber}
    `
  } else {
    await db`
      UPDATE orders
      SET unit_arrive = ${value}, updated_at = NOW()
      WHERE id = ${rowNumber}
    `
  }
}

/**
 * Inline note edit from the List Order table. Notes carry no permission
 * restriction (admins edit them through the modal too), so this is intentionally
 * separate from updateOrderOwnerCell and touches only the note column.
 */
export async function updateOrderNote(
  rowNumber: number,
  note: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE orders
    SET note = ${note}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function updateOrderReceipt(
  rowNumber: number,
  receipt: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE orders
    SET receipt = ${receipt}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

export async function deleteFormRow(rowNumber: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM orders WHERE id = ${rowNumber}`
}

export interface ReturnToExcessResult {
  /** Bought units moved into excess_purchase. */
  excessUnits: number
  /** Whether the order row was removed entirely (quantity hit 0). */
  deleted: boolean
  /** The order's quantity after the operation (0 when deleted). */
  newUnit: number
}

/**
 * Reverse a mistaken order: remove `removeUnits` from an order row and bank the
 * bought-but-not-yet-arrived surplus into excess_purchase — atomically.
 *
 * Handles both mistake shapes:
 *  - doubled quantity on one row → the row shrinks; surplus bought units → excess.
 *  - a whole duplicate row       → removing its full quantity deletes the row;
 *                                  its bought units → excess.
 *
 * Only bought units that have NOT progressed to arrived/shipped/held can move
 * to excess (stock already committed to this customer can't be reassigned), so
 * the order may not shrink below what's already arrived/shipped/held. Run via
 * withActor so the read-modify-write is one audited transaction.
 */
export async function returnOrderUnitsToExcess(
  rowNumber: number,
  removeUnits: number,
  db: DBExecutor = sql,
): Promise<ReturnToExcessResult> {
  if (!Number.isInteger(removeUnits) || removeUnits < 1) {
    throw new Error("removeUnits must be a positive integer")
  }

  const rows = await db`
    SELECT o.event, o.unit, o.unit_buy, o.unit_arrive, o.unit_ship, o.unit_hold,
           o.receipt, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ${rowNumber}
    FOR UPDATE OF o
  `
  if (rows.length === 0) throw new Error("Order not found")
  const r = rows[0]

  const unit = Number(r.unit) || 0
  const unitBuy = Number(r.unit_buy) || 0
  const unitArrive = Number(r.unit_arrive) || 0
  const unitShip = Number(r.unit_ship) || 0
  const unitHold = Number(r.unit_hold) || 0

  // Units already received/committed to this customer can't be reassigned.
  const committed = Math.max(unitArrive, unitShip + unitHold)
  const newUnit = unit - removeUnits
  if (newUnit < committed) {
    throw new Error(
      `Cannot remove ${removeUnits} unit(s): ${committed} already arrived/shipped/held on this order.`,
    )
  }

  // Bought units the shrunk order no longer needs become excess. Because
  // newUnit >= committed >= unitArrive, this never moves arrived stock.
  const excessUnits = Math.max(0, unitBuy - newUnit)
  const receipt = (r.receipt as string) ?? ""

  if (excessUnits > 0) {
    await db`
      INSERT INTO excess_purchase (event, items, unit_buy, receipt)
      VALUES (${r.event as string}, ${r.product_name as string}, ${excessUnits}, ${receipt})
    `
  }

  if (newUnit <= 0) {
    await db`DELETE FROM orders WHERE id = ${rowNumber}`
    return { excessUnits, deleted: true, newUnit: 0 }
  }

  // Drop unit_buy to the row's new (smaller) need only when units actually moved
  // to excess; otherwise leave unit_buy untouched (e.g. removing unbought units).
  if (excessUnits > 0) {
    await db`
      UPDATE orders
      SET unit = ${newUnit}, unit_buy = ${unitBuy - excessUnits},
          unit_dispatch = LEAST(COALESCE(unit_dispatch, 0), ${newUnit}), updated_at = NOW()
      WHERE id = ${rowNumber}
    `
  } else {
    await db`
      UPDATE orders
      SET unit = ${newUnit}, updated_at = NOW()
      WHERE id = ${rowNumber}
    `
  }
  return { excessUnits, deleted: false, newUnit }
}

// ─── Bulk updates ───────────────────────────────────────────────────────────

export async function bulkUpdatePurchase(updates: PurchaseUpdate[], db: DBExecutor = sql): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const unitBuys = updates.map((u) => u.unitBuy)
  const receipts = updates.map((u) => u.receipt)
  await db`
    UPDATE orders SET
      unit_buy = data.unit_buy,
      receipt = data.receipt,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${unitBuys}::int[], ${receipts}::text[])
      AS data(id, unit_buy, receipt)
    WHERE orders.id = data.id
  `
}

export async function bulkUpdateArrive(updates: ArriveUpdate[], db: DBExecutor = sql): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const arrives = updates.map((u) => u.unitArrive)
  await db`
    UPDATE orders SET
      unit_arrive = data.unit_arrive,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${arrives}::int[])
      AS data(id, unit_arrive)
    WHERE orders.id = data.id
  `
}

export async function bulkUpdateDispatch(updates: DispatchUpdate[], db: DBExecutor = sql): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const dispatches = updates.map((u) => u.unitDispatch)
  const receipts = updates.map((u) => u.dispatchReceipt)
  await db`
    UPDATE orders SET
      unit_dispatch = data.unit_dispatch,
      dispatch_receipt = data.dispatch_receipt,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${dispatches}::int[], ${receipts}::text[])
      AS data(id, unit_dispatch, dispatch_receipt)
    WHERE orders.id = data.id
  `
}

// ─── Excess Purchase ────────────────────────────────────────────────────────

export async function getExcessPurchaseRows(): Promise<ExcessRow[]> {
  const rows = await sql`
    SELECT id, event, items, unit_buy, receipt, reason, expected_item, created_at, updated_at
    FROM excess_purchase ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    items: r.items,
    unitBuy: r.unit_buy,
    receipt: r.receipt ?? "",
    reason: (r.reason ?? "overbuy") as ExcessReason,
    expectedItem: r.expected_item ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

function mapExcessRow(r: Record<string, unknown>): ExcessRow {
  return {
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    unitBuy: r.unit_buy as number,
    receipt: (r.receipt as string) ?? "",
    reason: ((r.reason as string) ?? "overbuy") as ExcessReason,
    expectedItem: (r.expected_item as string) ?? "",
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
    price: r.price != null ? Number(r.price) : null,
  }
}

export interface PaginatedExcess {
  rows: ExcessRow[]
  totalCount: number
  filteredSum: number | null
  filteredValue: number | null  // sum(unit_buy × product sell price), matched by item name — null when skipCount=true
  page: number
  pageSize: number
  totalPages: number
}

/** Sentinel for totalCount/totalPages when skipCount was requested. */
export const EXCESS_TOTAL_COUNT_UNCHANGED = -1

/**
 * One page of excess-purchase (Inventory) rows with server-side
 * search/filter/sort. Mirrors getPaymentsPaginated. filteredSum is the summed
 * unit_buy across the whole filtered set (units still to apply). filteredValue
 * estimates the sell-through value by joining each row's item name to the
 * products table's price — same name-collision-across-stores caveat as
 * Apply's matching, so a bare name shared by multiple stores is averaged
 * rather than picked exactly.
 */
export async function getExcessPurchasePaginated(opts: {
  page: number
  pageSize: number
  search?: string
  event?: string
  items?: string
  receipt?: string
  reason?: string
  sortKey?: string
  sortDir?: "asc" | "desc"
  skipCount?: boolean
}): Promise<PaginatedExcess> {
  const { page, pageSize, search, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(
      `(lower(e.event) LIKE ${p} OR lower(e.items) LIKE ${p} OR lower(COALESCE(e.receipt,'')) LIKE ${p} OR lower(COALESCE(e.expected_item,'')) LIKE ${p})`,
    )
  }

  const textFilters: [string | undefined, string][] = [
    [opts.event, "event"],
    [opts.items, "items"],
    [opts.receipt, "receipt"],
    [opts.reason, "reason"],
  ]
  for (const [value, col] of textFilters) {
    if (value) {
      params.push(`%${value.toLowerCase()}%`)
      conditions.push(`lower(COALESCE(e.${col},'')) LIKE $${params.length}`)
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    event: "event", items: "items", reason: "reason",
    unitBuy: "unit_buy", receipt: "receipt", createdAt: "created_at", updatedAt: "updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "id"
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC"

  const dataRows = await sql.unsafe(
    `WITH product_price AS (SELECT name, AVG(price) AS price FROM products GROUP BY name)
     SELECT e.id, e.event, e.items, e.unit_buy, e.receipt, e.reason, e.expected_item, e.created_at, e.updated_at, pp.price
     FROM excess_purchase e
     LEFT JOIN product_price pp ON pp.name = e.items
     ${where}
     ORDER BY ${sortCol} ${sortDir}, e.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const rows = (dataRows as Record<string, unknown>[]).map(mapExcessRow)

  if (skipCount) {
    return { rows, totalCount: EXCESS_TOTAL_COUNT_UNCHANGED, filteredSum: null, filteredValue: null, page, pageSize, totalPages: EXCESS_TOTAL_COUNT_UNCHANGED }
  }

  const [countRows, sumRows] = await Promise.all([
    sql.unsafe(`SELECT COUNT(*)::int AS c FROM excess_purchase e ${where}`, params),
    sql.unsafe(
      `WITH product_price AS (SELECT name, AVG(price) AS price FROM products GROUP BY name)
       SELECT
         COALESCE(SUM(e.unit_buy), 0)::bigint AS s,
         COALESCE(SUM(e.unit_buy * COALESCE(pp.price, 0)), 0)::bigint AS v
       FROM excess_purchase e
       LEFT JOIN product_price pp ON pp.name = e.items
       ${where}`,
      params,
    ),
  ])
  const totalCount = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0)
  const filteredSum = Number((sumRows as Record<string, unknown>[])[0]?.s ?? 0)
  const filteredValue = Number((sumRows as Record<string, unknown>[])[0]?.v ?? 0)
  return { rows, totalCount, filteredSum, filteredValue, page, pageSize, totalPages: Math.max(1, Math.ceil(totalCount / pageSize)) }
}

/**
 * Zero the given order lines (unit + unit_buy + unit_dispatch + unit_arrive → 0),
 * keeping the rows for history so they drop off the shopping/dispatch/arrival
 * lists. Used when an order can't be fulfilled (wrong/broken delivery): each
 * invoice drops, so the existing overpayment materialization auto-creates a
 * refund for any customer who already paid. Returns rows affected.
 */
export async function cancelOrderLines(orderIds: number[], db: DBExecutor = sql): Promise<number> {
  if (orderIds.length === 0) return 0
  const res = await db`
    UPDATE orders
    SET unit = 0, unit_buy = 0, unit_dispatch = 0, unit_arrive = 0, updated_at = NOW()
    WHERE id = ANY(${orderIds})
  `
  return res.count
}

/**
 * Wrong-product delivery for overseas events where the expected item can't be
 * re-ordered. In one audited transaction:
 *  - log the received SKU to excess_purchase as ready stock (reason=wrong_product), and
 *  - zero the chosen customer orders (unit + unit_buy → 0, rows kept for history)
 *    so the expected item drops off their invoices.
 * No refund is created here: once the invoice drops, the existing overpayment
 * materialization auto-creates a refund for any customer who already paid.
 */
export async function recordWrongProduct(
  data: {
    event: string
    expectedItem: string
    receivedItem: string
    qty: number
    cancelOrderIds: number[]
  },
  db: DBExecutor = sql,
): Promise<{ cancelledOrders: number; excessUnits: number }> {
  if (data.qty > 0 && data.receivedItem.trim()) {
    await appendExcessPurchase(
      [{
        event: data.event,
        items: data.receivedItem,
        unitBuy: data.qty,
        receipt: "",
        reason: "wrong_product",
        expectedItem: data.expectedItem,
      }],
      db,
    )
  }

  const cancelledOrders = await cancelOrderLines(data.cancelOrderIds, db)
  return { cancelledOrders, excessUnits: data.qty }
}

/**
 * Broken on arrival: the expected product arrived but is damaged/unsellable.
 * Log the broken units to inventory (excess_purchase) flagged reason 'broken'
 * — so they're tracked but NOT assignable to orders (the apply-to-orders flow
 * skips broken rows) — and cancel the chosen customer orders (refunds
 * auto-materialize if paid). Mirrors recordWrongProduct.
 */
export async function recordBrokenArrival(
  data: {
    event: string
    productName: string
    qty: number
    cancelOrderIds: number[]
  },
  db: DBExecutor = sql,
): Promise<{ cancelledOrders: number; excessUnits: number }> {
  if (data.qty > 0 && data.productName.trim()) {
    await appendExcessPurchase(
      [{
        event: data.event,
        items: data.productName,
        unitBuy: data.qty,
        receipt: "",
        reason: "broken",
      }],
      db,
    )
  }

  const cancelledOrders = await cancelOrderLines(data.cancelOrderIds, db)
  return { cancelledOrders, excessUnits: data.qty }
}

/**
 * Missing on arrival: the expected item never showed up (lost in transit, short
 * shipment, etc.). Like recordBrokenArrival, the chosen customer orders are
 * cancelled (refunds auto-materialize if paid) — but nothing is logged to
 * excess_purchase, because there are no physical units to track.
 */
export async function recordMissingArrival(
  data: { cancelOrderIds: number[] },
  db: DBExecutor = sql,
): Promise<{ cancelledOrders: number }> {
  const cancelledOrders = await cancelOrderLines(data.cancelOrderIds, db)
  return { cancelledOrders }
}

/**
 * Customer cancelled an order we'd already bought (misunderstanding, changed
 * their mind, etc.) — unlike wrong/broken/missing, the item itself is correct:
 * it's real, sellable stock that just lost its buyer. Log the still-in-hand
 * bought units for the chosen order lines to Inventory as ready stock
 * (reason=customer_cancelled, assignable to the next customer who wants it) and
 * cancel those orders (refunds auto-materialize if paid).
 *
 * The returned quantity is `unit_buy - unit_ship` (already-shipped units are
 * gone, so they aren't re-added to stock), read from the orders themselves
 * rather than trusted from the client. For the arrival-list callers nothing is
 * shipped yet, so this is simply their unit_buy.
 */
export async function recordCustomerCancellation(
  data: { event: string; productName: string; cancelOrderIds: number[] },
  db: DBExecutor = sql,
): Promise<{ cancelledOrders: number; excessUnits: number }> {
  if (data.cancelOrderIds.length === 0) return { cancelledOrders: 0, excessUnits: 0 }

  const [{ total }] = await db`
    SELECT COALESCE(SUM(GREATEST(0, unit_buy - COALESCE(unit_ship, 0))), 0)::int AS total
    FROM orders
    WHERE id = ANY(${data.cancelOrderIds})
  `
  const excessUnits = total as number

  if (excessUnits > 0) {
    await appendExcessPurchase(
      [{
        event: data.event,
        items: data.productName,
        unitBuy: excessUnits,
        receipt: "",
        reason: "customer_cancelled",
      }],
      db,
    )
  }

  const cancelledOrders = await cancelOrderLines(data.cancelOrderIds, db)
  return { cancelledOrders, excessUnits }
}

/**
 * Cancel `qty` units of a single order line rather than the whole line —
 * the invoice's per-line "Cancel Order" action, for when only part of what a
 * customer ordered falls through. Reduces `unit` by qty; `unit_buy` drops by
 * whichever is smaller of qty and the still-in-hand bought units
 * (unit_buy - unit_ship), so it never falls below what's already shipped.
 * That reclaimed portion is logged to Inventory (reason=customer_cancelled).
 * qty === the full unit count behaves like a full-line cancel, except
 * unit_buy lands on unit_ship instead of being force-zeroed — correct even
 * when part of the line already shipped, unlike the bulk cancelOrderLines
 * path the Arrival List uses (which always zeroes both fields outright).
 */
export async function cancelOrderUnits(
  data: { orderId: number; qty: number; event: string; productName: string },
  db: DBExecutor = sql,
): Promise<{ excessUnits: number; remainingUnit: number }> {
  const [order] = await db`
    SELECT unit, unit_buy, unit_ship FROM orders WHERE id = ${data.orderId} FOR UPDATE
  `
  if (!order) throw new Error("Order not found")

  const unit = order.unit as number
  const unitBuy = (order.unit_buy as number) ?? 0
  const unitShip = (order.unit_ship as number) ?? 0

  if (!(data.qty >= 1)) throw new Error("qty must be at least 1")
  if (data.qty > unit) throw new Error(`Cannot cancel more than the ${unit} units ordered`)

  const excessUnits = Math.min(data.qty, Math.max(0, unitBuy - unitShip))
  const remainingUnit = unit - data.qty
  const remainingUnitBuy = unitBuy - excessUnits

  if (excessUnits > 0) {
    await appendExcessPurchase(
      [{
        event: data.event,
        items: data.productName,
        unitBuy: excessUnits,
        receipt: "",
        reason: "customer_cancelled",
      }],
      db,
    )
  }

  await db`
    UPDATE orders
    SET unit = ${remainingUnit}, unit_buy = ${remainingUnitBuy},
        unit_dispatch = LEAST(COALESCE(unit_dispatch, 0), ${remainingUnitBuy}), updated_at = NOW()
    WHERE id = ${data.orderId}
  `

  return { excessUnits, remainingUnit }
}

export async function appendExcessPurchase(
  rows: {
    event: string
    items: string
    unitBuy: number
    receipt: string
    reason?: ExcessReason
    expectedItem?: string
  }[],
  db: DBExecutor = sql,
): Promise<void> {
  if (rows.length === 0) return
  await db`
    INSERT INTO excess_purchase ${db(
      rows.map((r) => ({
        // Blank event → NULL: manual "Add Inventory" rows may have no event.
        // Auto-spill callers always pass a real event, so this is a no-op there.
        event: r.event || null,
        items: r.items,
        unit_buy: r.unitBuy,
        receipt: r.receipt,
        reason: r.reason ?? "overbuy",
        expected_item: r.expectedItem ?? null,
      }))
    )}
  `
}

export async function updateExcessRowUnitBuy(rowNumber: number, unitBuy: number, db: DBExecutor = sql): Promise<void> {
  await db`
    UPDATE excess_purchase SET unit_buy = ${unitBuy}, updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

/**
 * Edit a manually-tracked (or any) excess row — event, item, quantity, reason,
 * receipt/note. Mainly for retargeting a manually-added row's event when it's
 * finally going to be applied against a real future order: "Apply" only ever
 * matches orders in the row's own event, so old stock has to be pointed at
 * whichever event is about to use it.
 */
export async function updateExcessRow(
  rowNumber: number,
  data: Partial<{
    event: string
    items: string
    unitBuy: number
    receipt: string
    reason: ExcessReason
  }>,
  db: DBExecutor = sql,
): Promise<void> {
  const fields: string[] = []
  const params: (string | number | null)[] = []
  // Blank event → NULL so clearing the event on edit passes the FK (NULL is exempt).
  if (data.event !== undefined) { params.push(data.event || null); fields.push(`event = $${params.length}`) }
  if (data.items !== undefined) { params.push(data.items); fields.push(`items = $${params.length}`) }
  if (data.unitBuy !== undefined) { params.push(data.unitBuy); fields.push(`unit_buy = $${params.length}`) }
  if (data.receipt !== undefined) { params.push(data.receipt); fields.push(`receipt = $${params.length}`) }
  if (data.reason !== undefined) { params.push(data.reason); fields.push(`reason = $${params.length}`) }

  if (fields.length === 0) return
  params.push(rowNumber)
  await db.unsafe(
    `UPDATE excess_purchase SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`,
    params,
  )
}

export async function deleteExcessRow(rowNumber: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM excess_purchase WHERE id = ${rowNumber}`
}

