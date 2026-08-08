import sql from "../db-pool"
import { tsToString } from "./helpers"
import type { DBExecutor } from "./actor"
import type {
  ProductRow, ProductIndoRow, CountryRow, WarehouseRow, KursTierRow, TierFeeBracketRow,
} from "./types"
import { toFlatFeeMode, toPricingMethod, type FlatFeeMode, type PricingMethod } from "@/lib/pricing"
import type { KursTierInput } from "@/lib/kurs-tiers"
import type { TierFeeBracketInput } from "@/lib/tier-fee"
import {
  toTierFeeMode, toTierFeeScope, type TierFeeMode, type TierFeeScope,
} from "@/lib/tier-fee"

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

// ─── Products ─────────────────────────────────────────────────────────────

export async function getProducts(): Promise<ProductRow[]> {
  const rows = await sql`
    SELECT p.id, p.name, p.store, p.price, p.gram,
           p.country_id, COALESCE(c.name, '') AS country_name,
           COALESCE(c.currency, '') AS country_currency,
           p.valas, p.kurs, p.tiered_kurs, p.cargo_per_kg, p.profit_pct,
           p.pricing_method, p.flat_fee_mode,
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
    countryCurrency: r.country_currency ?? "",
    valas: Number(r.valas) || 0,
    // NOT `|| 0`: null means "not priced on a tiered rate", which a 0 could not be
    // told apart from.
    tieredKurs: r.tiered_kurs != null ? Number(r.tiered_kurs) : null,
    pricingMethod: toPricingMethod(r.pricing_method),
    flatFeeMode: toFlatFeeMode(r.flat_fee_mode),
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
    countryCurrency: (r.country_currency as string) ?? "",
    valas: Number(r.valas) || 0,
    // NOT `|| 0`: null means "not priced on a tiered rate", which a 0 could not be
    // told apart from.
    tieredKurs: r.tiered_kurs != null ? Number(r.tiered_kurs) : null,
    pricingMethod: toPricingMethod(r.pricing_method),
    flatFeeMode: toFlatFeeMode(r.flat_fee_mode),
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
    // Keys on pricing_method, not country_id: a Tier Kurs product HAS a country,
    // so the old `country_id IS NOT NULL` test would file it under Overseas.
    // Ordered most-distinctive first, because the labels overlap. Since flat_kurs (migration
    // 053) there is no keyword left that names exactly one method except "mark", so the
    // ordering carries more weight than it used to: "flat", "kurs", "rate" and "tier" each
    // span two, and each resolves to the pair it honestly names rather than to whichever
    // method claimed the word first.
    //
    // Anything matching more than one method narrows to those rather than falling through:
    // an unmatched filter adds no condition at all and returns EVERY row, which reads as
    // "the filter did nothing" — worse than an imprecise answer.
    //
    // "markup" is tier_fee's label since it was renamed from "Tier Fee"; "mark" is enough to
    // match it and cannot be confused with "margin", which has no "k".
    if (t.includes("mark")) conditions.push("p.pricing_method = 'tier_fee'")
    // "rate" is the user-facing label for the family, "kurs" the stored vocabulary. Same set.
    else if (t.includes("rate") || t.includes("kurs")) {
      conditions.push("p.pricing_method IN ('tier_kurs', 'flat_kurs')")
    }
    // Both flat methods. "flat" meant flat_fee alone only while it was the only one.
    else if (t.includes("flat")) {
      conditions.push("p.pricing_method IN ('flat_fee', 'flat_kurs')")
    }
    else if (t.includes("over") || t.includes("abroad") || t.includes("margin")) {
      conditions.push("p.pricing_method = 'overseas'")
    }
    // "fee" describes both fee-based methods — Flat Fee still carries it in its label,
    // and tier_fee is the method the Fee toggle sits inside.
    else if (t.includes("fee")) {
      conditions.push("p.pricing_method IN ('tier_fee', 'flat_fee')")
    }
    // "tier" is ambiguous between the two bracketed methods, and means both.
    else if (t.includes("tier")) {
      conditions.push("p.pricing_method IN ('tier_fee', 'tier_kurs')")
    }
  }
  // valas / gram default to 0 (never null in practice), so "blank" = 0.
  if (valas === "filled") conditions.push("COALESCE(p.valas, 0) <> 0")
  else if (valas === "blank") conditions.push("COALESCE(p.valas, 0) = 0")
  if (gram === "filled") conditions.push("COALESCE(p.gram, 0) <> 0")
  else if (gram === "blank") conditions.push("COALESCE(p.gram, 0) = 0")

  const where = `WHERE ${conditions.join(" AND ")}`

  const SORT_COLUMNS: Record<string, string> = {
    id: "p.id", name: "p.name", store: "p.store", price: "p.price",
    type: "p.pricing_method", countryName: "c.name", valas: "p.valas",
    gram: "p.gram", kurs: "p.kurs", tieredKurs: "p.tiered_kurs",
    cargoPerKg: "p.cargo_per_kg",
    profitPct: "p.profit_pct", operationalFee: "p.operational_fee",
    packingFee: "p.packing_fee", cost: "p.cost", profitFixed: "p.profit_fixed",
    createdAt: "p.created_at", updatedAt: "p.updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "p.id"
  const sortDir = opts.sortDir === "asc" ? "ASC" : "DESC"

  const dataQuery = sql.unsafe(
    `SELECT p.id, p.name, p.store, p.price, p.gram,
            p.country_id, COALESCE(c.name, '') AS country_name,
            COALESCE(c.currency, '') AS country_currency,
            p.valas, p.kurs, p.tiered_kurs, p.cargo_per_kg, p.profit_pct,
            p.pricing_method, p.flat_fee_mode,
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
  tieredKurs: number | null
  cargoPerKg: number
  pricingMethod: PricingMethod
  flatFeeMode: FlatFeeMode
  profitPct: number
  operationalFee: number
  packingFee: number
  cost: number
  profitFixed: number
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO products (name, store, price, gram, country_id, valas, kurs,
      tiered_kurs, cargo_per_kg, profit_pct, operational_fee, packing_fee, cost,
      profit_fixed, pricing_method, flat_fee_mode)
    VALUES (${data.name}, ${data.store}, ${data.price}, ${data.gram},
      ${data.countryId}, ${data.valas}, ${data.kurs}, ${data.tieredKurs},
      ${data.cargoPerKg}, ${data.profitPct}, ${data.operationalFee},
      ${data.packingFee}, ${data.cost}, ${data.profitFixed}, ${data.pricingMethod},
      ${data.flatFeeMode})
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
    tieredKurs: number | null
    cargoPerKg: number
    pricingMethod: PricingMethod
    flatFeeMode: FlatFeeMode
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
        valas = ${data.valas}, kurs = ${data.kurs},
        tiered_kurs = ${data.tieredKurs},
        cargo_per_kg = ${data.cargoPerKg},
        profit_pct = ${data.profitPct}, operational_fee = ${data.operationalFee},
        packing_fee = ${data.packingFee}, cost = ${data.cost},
        profit_fixed = ${data.profitFixed},
        pricing_method = ${data.pricingMethod},
        flat_fee_mode = ${data.flatFeeMode}, updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteProduct(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM products WHERE id = ${id}`
}

// ─── Kurs tiers (Tier Kurs) ────────────────────────────────────────────────
//
// Per-country brackets mapping a product's valas to the exchange rate charged.
// The resolution itself lives in lib/kurs-tiers.ts, so the browser's form preview
// and the server-side authority share one implementation.

function mapKursTierRow(r: Record<string, unknown>): KursTierRow {
  return {
    id: r.id as number,
    countryId: r.country_id as number,
    // min_valas is NUMERIC(12,2) and kurs NUMERIC(12,4) — postgres-js returns both
    // as strings, so coerce, same as products.kurs above.
    minValas: Number(r.min_valas) || 0,
    kurs: Number(r.kurs) || 0,
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }
}

export async function getKursTiers(): Promise<KursTierRow[]> {
  const rows = await sql`
    SELECT id, country_id, min_valas, kurs, created_at, updated_at
    FROM country_kurs_tiers
    ORDER BY country_id, min_valas
  `
  return rows.map(mapKursTierRow)
}

/**
 * Everything the server needs to price a Tier Kurs product, in one round trip:
 * the country's brackets and the configured rounding step.
 *
 * Brackets come back as KursTierInput, deliberately NOT KursTierRow: json_agg
 * would hand back ISO date strings where tsToString() expects a Date, and the
 * resolver only ever needs minValas and kurs.
 *
 * Takes a DBExecutor so it runs inside the same transaction as the write.
 */
export async function getTierKursInputs(
  countryId: number | null,
  db: DBExecutor = sql,
): Promise<{ kursTiers: KursTierInput[]; roundTo: number }> {
  const [row] = await db`
    SELECT COALESCE((
             SELECT json_agg(json_build_object('minValas', t.min_valas, 'kurs', t.kurs)
                             ORDER BY t.min_valas)
               FROM country_kurs_tiers t
              WHERE t.country_id = ${countryId}
           ), '[]'::json) AS tiers,
           (SELECT tier_kurs_round_to FROM product_defaults WHERE id = 1) AS round_to
  `
  return {
    kursTiers: (row?.tiers as KursTierInput[]) ?? [],
    roundTo: Number(row?.round_to) || 5000,
  }
}

/**
 * Everything the server needs to price a Flat Kurs product, in one round trip: the
 * country's one configured rate and the shared rounding step.
 *
 * The rounding step is deliberately the SAME product_defaults.tier_kurs_round_to the
 * bracketed method uses. Both Rate methods round the same way; a second setting would be
 * two answers to one question.
 *
 * No countries.kurs here, on purpose: the fallback for an unset rate is the rate the row
 * books as COST, which comes off the request body — see resolveFlatKurs().
 *
 * Takes a DBExecutor so it runs inside the same transaction as the write.
 */
export async function getFlatKursInputs(
  countryId: number | null,
  db: DBExecutor = sql,
): Promise<{ flatKurs: number; roundTo: number }> {
  const [row] = await db`
    SELECT (SELECT flat_kurs FROM countries WHERE id = ${countryId}) AS flat_kurs,
           (SELECT tier_kurs_round_to FROM product_defaults WHERE id = 1) AS round_to
  `
  return {
    // NUMERIC as a string, and `|| 0` is right rather than `??`: 0 IS the unset value.
    flatKurs: Number(row?.flat_kurs) || 0,
    roundTo: Number(row?.round_to) || 5000,
  }
}


/**
 * Every Flat Fee setting in one round trip: the fixed amount, the percentage, and the floor
 * under the percentage — whichever mode the row being saved is in (migrations 054, 055).
 *
 * Takes a DBExecutor and is read inside the write transaction rather than from the cached
 * settings route, for the same reason the brackets are: these are the numbers the stored
 * price is built from, so a stale read would persist a wrong price rather than merely
 * show one.
 *
 * NOT `|| 10000` etc. on the coercions: 0 is legal for all three, and means price at cost /
 * no percentage / no floor.
 */
export async function getFlatFeeSettings(
  db: DBExecutor = sql,
): Promise<{ flatFee: number; flatFeePct: number; flatFeeMin: number }> {
  const [row] = await db`
    SELECT flat_fee, flat_fee_pct, flat_fee_min FROM product_defaults WHERE id = 1
  `
  const fee = Number(row?.flat_fee)
  const pct = Number(row?.flat_fee_pct)
  const min = Number(row?.flat_fee_min)
  return {
    flatFee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
    flatFeePct: Number.isFinite(pct) && pct >= 0 ? pct : 0,
    flatFeeMin: Number.isFinite(min) && min >= 0 ? min : 0,
  }
}

/**
 * A product's stored pricing state, needed by the PUT handler: the method and
 * country so an update that omits them keeps them rather than clearing them, the
 * price so a formula that computes 0 can't wipe an imported one, and the tiered
 * rate and valas fee so they survive the same early-return paths.
 */
export async function getProductPricingContext(
  id: number,
  db: DBExecutor = sql,
): Promise<{
  pricingMethod: PricingMethod
  flatFeeMode: FlatFeeMode
  price: number
  tieredKurs: number | null
  /** The fee the stored price was built from. Needed so that a save which KEEPS the price
   *  (the Sheets-import guard in computeProductPrice) keeps the fee that goes with it,
   *  rather than storing one resolved from a base cost of zero. */
  profitFixed: number
  countryId: number | null
}> {
  const [row] = await db`
    SELECT pricing_method, flat_fee_mode, price, tiered_kurs, profit_fixed, country_id
    FROM products WHERE id = ${id}
  `
  return {
    pricingMethod: toPricingMethod(row?.pricing_method),
    flatFeeMode: toFlatFeeMode(row?.flat_fee_mode),
    price: (row?.price as number | undefined) ?? 0,
    tieredKurs: row?.tiered_kurs != null ? Number(row.tiered_kurs) : null,
    profitFixed: (row?.profit_fixed as number | undefined) ?? 0,
    countryId: (row?.country_id as number | null) ?? null,
  }
}

/**
 * Replace one country's whole bracket set.
 *
 * Upsert-then-prune rather than delete-then-insert: ids and created_at survive an
 * edit, updated_at stays meaningful, and the audit log shows a readable per-band
 * diff instead of N DELETEs plus M INSERTs on every save.
 *
 * An empty `bands` clears the country, with no special case needed: unnest of an
 * empty array inserts nothing, and `min_valas <> ALL('{}')` is vacuously true so
 * the prune removes every row.
 */
export async function replaceKursTiers(
  countryId: number,
  bands: { minValas: number; kurs: number }[],
  flatKurs: number,
  db: DBExecutor = sql,
): Promise<void> {
  const mins = bands.map((b) => b.minValas)
  const rates = bands.map((b) => b.kurs)

  // First, because it is the statement that fails on an unknown country: failing before
  // any bracket row is touched keeps the error about the country rather than about a
  // foreign key on a table the caller was not thinking about.
  await db`
    UPDATE countries SET flat_kurs = ${flatKurs}, updated_at = NOW()
     WHERE id = ${countryId}
  `

  if (bands.length > 0) {
    await db`
      INSERT INTO country_kurs_tiers (country_id, min_valas, kurs, updated_at)
      SELECT ${countryId}, data.min_valas, data.kurs, NOW()
        FROM unnest(${mins}::numeric[], ${rates}::numeric[])
          AS data(min_valas, kurs)
      ON CONFLICT (country_id, min_valas)
      DO UPDATE SET kurs = EXCLUDED.kurs, updated_at = NOW()
    `
  }
  await db`
    DELETE FROM country_kurs_tiers
     WHERE country_id = ${countryId}
       AND min_valas <> ALL(${mins}::numeric[])
  `
}

// ─── Tier Fee brackets ─────────────────────────────────────────────────────
//
// Brackets mapping a Markup Tier product's base cost to its fee. Resolution lives in
// lib/tier-fee.ts. Two scopes, both in RUPIAH (migrations 056/057):
//
//   'rupiah' — matched against the typed base cost. A FORM DEFAULT only; the user can
//              type over the suggested fee and nothing recomputes it.
//   'valas'  — matched against the DERIVED base cost (valas × kurs + freight), and shared
//              by every country. Authoritative: re-resolved inside the write transaction
//              by getTierFeeValasInputs() below.
//
// One set for all countries rather than one per country, because the floors and the fee
// are rupiah: a shared `fee = 20` could not mean anything sensible for CNY and JPY at once.

function mapTierFeeBracketRow(r: Record<string, unknown>): TierFeeBracketRow {
  return {
    id: r.id as number,
    scope: toTierFeeScope(r.scope),
    minBase: Number(r.min_base) || 0,
    feeMode: toTierFeeMode(r.fee_mode),
    // fee_value is NUMERIC(12,2), which postgres-js returns as a string.
    feeValue: Number(r.fee_value) || 0,
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
  }
}

/** Both scopes' brackets. One fetch serves the Settings editor and both product forms,
 *  which filter with bracketsForScope(). */
export async function getTierFeeBrackets(): Promise<TierFeeBracketRow[]> {
  const rows = await sql`
    SELECT id, scope, min_base, fee_mode, fee_value, created_at, updated_at
    FROM tier_fee_brackets
    ORDER BY scope, min_base
  `
  return rows.map(mapTierFeeBracketRow)
}

/**
 * Everything the server needs to price a valas-mode Markup Tier product, in one round
 * trip: the shared valas brackets and the rounding step.
 *
 * No country parameter since migrations 056/057 — every country uses the same set.
 *
 * Brackets come back as TierFeeBracketInput, deliberately NOT TierFeeBracketRow:
 * json_agg would hand back ISO date strings where tsToString() expects a Date, and
 * the resolver only ever needs minBase, feeMode and feeValue. Same shape as
 * getTierKursInputs.
 *
 * Takes a DBExecutor so it runs inside the same transaction as the write.
 */
export async function getTierFeeValasInputs(
  db: DBExecutor = sql,
): Promise<{ brackets: TierFeeBracketInput[]; roundTo: number }> {
  const [row] = await db`
    SELECT COALESCE((
             SELECT json_agg(json_build_object(
                      'minBase', b.min_base, 'feeMode', b.fee_mode, 'feeValue', b.fee_value)
                    ORDER BY b.min_base)
               FROM tier_fee_brackets b
              WHERE b.scope = 'valas'
           ), '[]'::json) AS brackets,
           (SELECT tier_kurs_round_to FROM product_defaults WHERE id = 1) AS round_to
  `
  return {
    brackets: (row?.brackets as TierFeeBracketInput[]) ?? [],
    roundTo: Number(row?.round_to) || 5000,
  }
}

/**
 * Replace one scope's whole bracket set.
 *
 * Upsert-then-prune for the same reasons as replaceKursTiers: ids and created_at
 * survive an edit, and the audit log shows a per-bracket diff rather than N DELETEs
 * plus M INSERTs on every save.
 *
 * An empty `brackets` clears that scope, which is legitimate: for rupiah it means
 * "stop suggesting a fee", for valas it means "price at cost".
 */
export async function replaceTierFeeBrackets(
  scope: TierFeeScope,
  brackets: { minBase: number; feeMode: TierFeeMode; feeValue: number }[],
  db: DBExecutor = sql,
): Promise<void> {
  const mins = brackets.map((b) => b.minBase)
  const modes = brackets.map((b) => b.feeMode)
  const values = brackets.map((b) => b.feeValue)

  if (brackets.length > 0) {
    await db`
      INSERT INTO tier_fee_brackets (scope, min_base, fee_mode, fee_value, updated_at)
      SELECT ${scope}, data.min_base, data.fee_mode, data.fee_value, NOW()
        FROM unnest(${mins}::numeric[], ${modes}::text[], ${values}::numeric[])
          AS data(min_base, fee_mode, fee_value)
      ON CONFLICT (scope, min_base)
      DO UPDATE SET fee_mode  = EXCLUDED.fee_mode,
                    fee_value = EXCLUDED.fee_value,
                    updated_at = NOW()
    `
  }
  // A plain `=` is right now that the scope is a non-null TEXT: the NULL-safe comparison
  // the country version needed is gone with country_id.
  await db`
    DELETE FROM tier_fee_brackets
     WHERE scope = ${scope}
       AND min_base <> ALL(${mins}::numeric[])
  `
}

// ─── Countries ─────────────────────────────────────────────────────────────

export async function getCountries(): Promise<CountryRow[]> {
  const rows = await sql`
    SELECT id, name, currency, kurs, flat_kurs, cargo_per_kg, created_at, updated_at
    FROM countries ORDER BY name
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency ?? "",
    // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce.
    kurs: Number(r.kurs) || 0,
    // Same column type, same coercion.
    flatKurs: Number(r.flat_kurs) || 0,
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

