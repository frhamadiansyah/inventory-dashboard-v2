import sql from "../db-pool"
import { tsToString } from "./helpers"
import type { DBExecutor } from "./actor"
import type { ProductRow, ProductIndoRow, CountryRow, WarehouseRow } from "./types"

// ─── Products Indo ──────────────────────────────────────────────────────────

export async function getProductIndo(): Promise<ProductIndoRow[]> {
  const rows = await sql`
    SELECT id, product, store, price, created_at, updated_at FROM products_indo
    WHERE product != '' ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    product: r.product,
    store: r.store,
    price: r.price ?? 0,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addProductIndo(data: {
  product: string
  store: string
  price: number
}, db: DBExecutor = sql): Promise<{ rowNumber: number }> {
  const [row] = await db`
    INSERT INTO products_indo (product, store, price)
    VALUES (${data.product}, ${data.store}, ${data.price})
    RETURNING id
  `
  return { rowNumber: row.id }
}

export async function updateProductIndo(
  rowNumber: number,
  data: { product: string; store: string; price: number },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE products_indo
    SET product = ${data.product}, store = ${data.store}, price = ${data.price},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

// ─── Products (abroad + domestic) ─────────────────────────────────────────

export async function getProducts(): Promise<ProductRow[]> {
  const rows = await sql`
    SELECT p.id, p.name, p.store, p.price, p.gram,
           p.country_id, COALESCE(c.name, '') AS country_name,
           p.valas, p.kurs, p.cargo_per_kg, p.profit_pct,
           p.operational_fee, p.packing_fee, p.cost, p.profit_fixed,
           p.is_active, p.created_at, p.updated_at
    FROM products p
    LEFT JOIN countries c ON c.id = p.country_id
    WHERE p.name != ''
    ORDER BY p.name
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    store: r.store ?? "",
    price: r.price ?? 0,
    gram: r.gram ?? 0,
    countryId: r.country_id,
    countryName: r.country_name ?? "",
    valas: Number(r.valas) || 0,
    // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce.
    kurs: Number(r.kurs) || 0,
    cargoPerKg: r.cargo_per_kg ?? 0,
    profitPct: r.profit_pct ?? 0,
    operationalFee: r.operational_fee ?? 5000,
    packingFee: r.packing_fee ?? 5000,
    cost: r.cost ?? 0,
    profitFixed: r.profit_fixed ?? 0,
    isActive: (r.is_active as boolean | undefined) ?? true,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

// Shared row → ProductRow mapper for the paginated query below.
function mapProductRow(r: Record<string, unknown>): ProductRow {
  return {
    id: r.id as number,
    name: (r.name as string) ?? "",
    store: (r.store as string) ?? "",
    price: (r.price as number) ?? 0,
    gram: (r.gram as number) ?? 0,
    countryId: (r.country_id as number | null) ?? null,
    countryName: (r.country_name as string) ?? "",
    valas: Number(r.valas) || 0,
    // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce.
    kurs: Number(r.kurs) || 0,
    cargoPerKg: (r.cargo_per_kg as number) ?? 0,
    profitPct: (r.profit_pct as number) ?? 0,
    operationalFee: (r.operational_fee as number) ?? 5000,
    packingFee: (r.packing_fee as number) ?? 5000,
    cost: (r.cost as number) ?? 0,
    profitFixed: (r.profit_fixed as number) ?? 0,
    // Defaults true when the column is absent (e.g. products_indo mapping paths
    // that never select it) so those rows stay usable.
    isActive: (r.is_active as boolean | undefined) ?? true,
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }
}

export interface PaginatedProducts {
  rows: ProductRow[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
}

/** See {@link TOTAL_COUNT_UNCHANGED} in orders.ts — same skipCount sentinel. */
export const PRODUCTS_TOTAL_COUNT_UNCHANGED = -1

/** Distinct, non-empty store names — for the add/edit store autocomplete. */
export async function getProductStores(): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT store FROM products
    WHERE store IS NOT NULL AND store != ''
    ORDER BY store
  `
  return rows.map((r) => r.store as string)
}

/**
 * One page of products with server-side search/filter/sort. LIMIT/OFFSET keeps
 * this bounded even as the catalogue grows. Mirrors getDuplicateFormRowsPaginated.
 */
export async function getProductsPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  name?: string
  store?: string
  type?: string
  country?: string
  // "filled" = has a non-zero value; "blank" = null or 0. Undefined = no filter.
  valas?: "filled" | "blank"
  gram?: "filled" | "blank"
  sortKey?: string
  sortDir?: "asc" | "desc"
  skipCount?: boolean
}): Promise<PaginatedProducts> {
  const { page, pageSize, search, name, store, type, country, valas, gram, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = ["p.name != ''"]
  const params: (string | number)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(`(lower(p.name) LIKE ${p} OR lower(p.store) LIKE ${p} OR lower(COALESCE(c.name, '')) LIKE ${p})`)
  }
  if (name) {
    params.push(`%${name.toLowerCase()}%`)
    conditions.push(`lower(p.name) LIKE $${params.length}`)
  }
  if (store) {
    params.push(`%${store.toLowerCase()}%`)
    conditions.push(`lower(p.store) LIKE $${params.length}`)
  }
  if (country) {
    params.push(`%${country.toLowerCase()}%`)
    conditions.push(`lower(COALESCE(c.name, '')) LIKE $${params.length}`)
  }
  if (type) {
    const t = type.toLowerCase()
    // "Overseas" rows have a country; "Domestic" rows don't.
    if (t.includes("over") || t.includes("abroad")) conditions.push("p.country_id IS NOT NULL")
    else if (t.includes("dom")) conditions.push("p.country_id IS NULL")
  }
  // valas / gram default to 0 (never null in practice), so "blank" = 0.
  if (valas === "filled") conditions.push("COALESCE(p.valas, 0) <> 0")
  else if (valas === "blank") conditions.push("COALESCE(p.valas, 0) = 0")
  if (gram === "filled") conditions.push("COALESCE(p.gram, 0) <> 0")
  else if (gram === "blank") conditions.push("COALESCE(p.gram, 0) = 0")

  const where = `WHERE ${conditions.join(" AND ")}`

  const SORT_COLUMNS: Record<string, string> = {
    id: "p.id", name: "p.name", store: "p.store", price: "p.price",
    type: "p.country_id", countryName: "c.name", valas: "p.valas",
    gram: "p.gram", kurs: "p.kurs", cargoPerKg: "p.cargo_per_kg",
    profitPct: "p.profit_pct", operationalFee: "p.operational_fee",
    packingFee: "p.packing_fee", cost: "p.cost", profitFixed: "p.profit_fixed",
    createdAt: "p.created_at", updatedAt: "p.updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "p.id"
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC"

  const dataQuery = sql.unsafe(
    `SELECT p.id, p.name, p.store, p.price, p.gram,
            p.country_id, COALESCE(c.name, '') AS country_name,
            p.valas, p.kurs, p.cargo_per_kg, p.profit_pct,
            p.operational_fee, p.packing_fee, p.cost, p.profit_fixed,
            p.is_active, p.created_at, p.updated_at
     FROM products p
     LEFT JOIN countries c ON c.id = p.country_id
     ${where}
     ORDER BY ${sortCol} ${sortDir}, p.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  if (skipCount) {
    const dataRows = await dataQuery
    return {
      rows: dataRows.map(mapProductRow),
      totalCount: PRODUCTS_TOTAL_COUNT_UNCHANGED,
      page,
      pageSize,
      totalPages: PRODUCTS_TOTAL_COUNT_UNCHANGED,
    }
  }

  // The countries join stays in the count query because the search/country
  // filters reference c.name (a LEFT JOIN can't change the product row count).
  const countQuery = sql.unsafe(
    `SELECT COUNT(*)::int AS c
     FROM products p
     LEFT JOIN countries c ON c.id = p.country_id
     ${where}`,
    params,
  )

  const [dataRows, countRows] = await Promise.all([dataQuery, countQuery])
  const totalCount = Number(countRows[0]?.c ?? 0)
  return {
    rows: dataRows.map(mapProductRow),
    totalCount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

export async function addProduct(data: {
  name: string
  store: string
  price: number
  gram: number
  countryId: number | null
  valas: number
  kurs: number
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
  cost: number
  profitFixed: number
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO products (name, store, price, gram, country_id, valas, kurs,
      cargo_per_kg, profit_pct, operational_fee, packing_fee, cost, profit_fixed)
    VALUES (${data.name}, ${data.store}, ${data.price}, ${data.gram},
      ${data.countryId}, ${data.valas}, ${data.kurs}, ${data.cargoPerKg},
      ${data.profitPct}, ${data.operationalFee}, ${data.packingFee},
      ${data.cost}, ${data.profitFixed})
    RETURNING id
  `
  return { id: row.id }
}

export async function updateProduct(
  id: number,
  data: {
    name: string
    store: string
    price: number
    gram: number
    countryId: number | null
    valas: number
    kurs: number
    cargoPerKg: number
    profitPct: number
    operationalFee: number
    packingFee: number
    cost: number
    profitFixed: number
  },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE products
    SET name = ${data.name}, store = ${data.store}, price = ${data.price},
        gram = ${data.gram}, country_id = ${data.countryId},
        valas = ${data.valas}, kurs = ${data.kurs}, cargo_per_kg = ${data.cargoPerKg},
        profit_pct = ${data.profitPct}, operational_fee = ${data.operationalFee},
        packing_fee = ${data.packingFee}, cost = ${data.cost},
        profit_fixed = ${data.profitFixed}, updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteProduct(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM products WHERE id = ${id}`
}

// ─── Countries ─────────────────────────────────────────────────────────────

export async function getCountries(): Promise<CountryRow[]> {
  const rows = await sql`
    SELECT id, name, currency, kurs, cargo_per_kg, created_at, updated_at
    FROM countries ORDER BY name
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency ?? "",
    // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce.
    kurs: Number(r.kurs) || 0,
    cargoPerKg: r.cargo_per_kg ?? 0,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addCountry(data: {
  name: string
  currency: string
  kurs: number
  cargoPerKg: number
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO countries (name, currency, kurs, cargo_per_kg)
    VALUES (${data.name}, ${data.currency}, ${data.kurs}, ${data.cargoPerKg})
    RETURNING id
  `
  return { id: row.id }
}

export async function updateCountry(
  id: number,
  data: { name: string; currency: string; kurs: number; cargoPerKg: number },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE countries
    SET name = ${data.name}, currency = ${data.currency},
        kurs = ${data.kurs}, cargo_per_kg = ${data.cargoPerKg},
        updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteCountry(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM countries WHERE id = ${id}`
}

// ─── Warehouses ─────────────────────────────────────────────────────────────

/** Shipping origins, default first. Used for event/customer ongkir UIs. */
export async function getWarehouses(): Promise<WarehouseRow[]> {
  const rows = await sql`
    SELECT id, code, name, is_default
    FROM warehouses
    ORDER BY is_default DESC, code ASC
  `
  return rows.map((r) => ({
    id: r.id as number,
    code: r.code as string,
    name: r.name as string,
    isDefault: Boolean(r.is_default),
  }))
}

// ─── Events ───────────────────────────────────────────────────────────────

export interface EventRow {
  id: number
  name: string
  eta: string
  warehouseId: number
  // The event's country (1 event = 1 country). Drives the operational-expense
  // currency/kurs. Null until set on the Events page. currency/kurs are joined
  // from countries for convenience ("" / 0 when no country).
  countryId: number | null
  countryName: string
  currency: string
  kurs: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export async function getEvents(): Promise<EventRow[]> {
  const rows = await sql`
    SELECT e.id, e.name, e.eta, e.warehouse_id, e.country_id,
           COALESCE(c.name, '') AS country_name,
           COALESCE(c.currency, '') AS currency, c.kurs,
           e.is_active, e.created_at, e.updated_at
    FROM events e
    LEFT JOIN countries c ON c.id = e.country_id
    ORDER BY e.id DESC
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    eta: r.eta ?? "",
    warehouseId: r.warehouse_id as number,
    countryId: (r.country_id as number | null) ?? null,
    countryName: (r.country_name as string) ?? "",
    currency: (r.currency as string) ?? "",
    // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce.
    kurs: Number(r.kurs) || 0,
    isActive: r.is_active as boolean,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function setEventActive(id: number, isActive: boolean, db: DBExecutor = sql): Promise<void> {
  await db`UPDATE events SET is_active = ${isActive}, updated_at = NOW() WHERE id = ${id}`
}

export async function setProductActive(id: number, isActive: boolean, db: DBExecutor = sql): Promise<void> {
  await db`UPDATE products SET is_active = ${isActive}, updated_at = NOW() WHERE id = ${id}`
}

export async function addEvent(data: {
  name: string
  eta: string
  warehouseId?: number | null
  countryId?: number | null
}, db: DBExecutor = sql): Promise<{ id: number }> {
  // Fall back to the default warehouse when the caller omits one (keeps older
  // callers/tests working and satisfies the events.warehouse_id NOT NULL column).
  const [row] = await db`
    INSERT INTO events (name, eta, warehouse_id, country_id)
    VALUES (
      ${data.name}, ${data.eta},
      COALESCE(${data.warehouseId ?? null}, (SELECT id FROM warehouses WHERE is_default)),
      ${data.countryId ?? null}
    )
    RETURNING id
  `
  return { id: row.id }
}

export async function updateEvent(
  id: number,
  data: { name: string; eta: string; warehouseId?: number | null; countryId?: number | null },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE events
    SET name = ${data.name}, eta = ${data.eta},
        warehouse_id = COALESCE(${data.warehouseId ?? null}, warehouse_id),
        country_id = ${data.countryId ?? null},
        updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteEvent(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM events WHERE id = ${id}`
}

