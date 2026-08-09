/**
 * One-time data migration: Google Sheets → Supabase (Postgres) — ALL STEPS
 *
 * Combines the previously-separate scripts into a single ordered run:
 *   1. Base tables (TRUNCATE + insert): customers, products, orders   [main spreadsheet]
 *      NOTE: events, excess_purchase, shipments, and products_indo are intentionally
 *      NOT migrated or truncated here. Events must already exist (orders/payments/
 *      adjustments reference events.name via FK). Customers: "gantialamat" rows are
 *      skipped, and duplicate usernames keep the LAST occurrence.
 *   2. Product weights — products.gram                        [Product tab]
 *   3. Product pricing — valas/gram/kurs/cargo/%/country_id   [Product_Percentage tab]
 *   4. Payments                                               [Payment tab]
 *   5. Adjustments (biaya lainnya)        [Order_JanganDisort_DifilterAja tab]
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/migrate-sheets-to-supabase.ts
 *   # add --dry-run to preview the pricing step (3) without writing
 *
 * Required env vars:
 *   DATABASE_URL                        — Supabase pooler connection string
 *   GOOGLE_SPREADSHEET_ID               — Main spreadsheet ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL        — Service account email
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY  — Service account private key
 *   GOOGLE_PRODUCT_INDO_SPREADSHEET_ID  — Product_Indo / Product_Percentage spreadsheet
 *
 * Notes:
 *   - Step 1 TRUNCATEs the base tables (safe to re-run, but destructive).
 *   - The `countries` table must already be seeded before step 3 — it is not
 *     imported from Sheets.
 *   - Steps that need GOOGLE_PRODUCT_INDO_SPREADSHEET_ID are skipped with a
 *     warning if it is not set.
 */

import { google } from "googleapis"
import postgres from "postgres"
import { writeFileSync } from "fs"

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!
const PRODUCT_INDO_SPREADSHEET_ID = process.env.GOOGLE_PRODUCT_INDO_SPREADSHEET_ID
const dryRun = process.argv.includes("--dry-run")

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}
if (!SPREADSHEET_ID) {
  console.error("❌ GOOGLE_SPREADSHEET_ID is not set")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

// ─── Shared helpers ──────────────────────────────────────────────────────────

type Sheets = ReturnType<typeof google.sheets>

function getSheetsClient(): Sheets {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  return google.sheets({ version: "v4", auth })
}

async function readSheet(sheets: Sheets, spreadsheetId: string, range: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
  return (res.data.values ?? []) as string[][]
}

// Parse "DD/MM/YYYY, HH.MM.SS" → ISO timestamp string (Asia/Jakarta = UTC+7)
function parseTimestamp(s: string | undefined): string | null {
  if (!s || !s.trim()) return null
  const match = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2})\.(\d{1,2})\.(\d{1,2})/)
  if (!match) return null
  const [, d, m, y, h, min, sec] = match
  const pad = (n: string) => n.padStart(2, "0")
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(sec)}+07:00`
}

function parseNum(v: string | undefined): number {
  if (!v || !v.trim()) return 0
  return Number(String(v).replace(/[^0-9.-]/g, "")) || 0
}

function optionalNum(v: string | undefined): number | null {
  if (!v || !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeCustomer(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return lower.startsWith("@") ? lower : `@${lower}`
}

// Junk/placeholder customers to skip entirely (e.g. "gantialamat" = change-address rows).
function isIgnoredCustomer(handle: string): boolean {
  return handle.toLowerCase().includes("gantialamat")
}

// ─── Trace report ────────────────────────────────────────────────────────────
// Records every row we couldn't import (skipped) or changed (renamed / auto-created),
// with the originating sheet row so it's easy to trace back in Google Sheets.
type ReportEntry = { step: string; sheetRow: number | string; action: string; detail: string }
const report: ReportEntry[] = []
function note(step: string, sheetRow: number | string, action: string, detail: string) {
  report.push({ step, sheetRow, action, detail })
}
function writeReport() {
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const lines = [
    "step,sheet_row,action,detail",
    ...report.map((r) => [r.step, String(r.sheetRow), r.action, esc(r.detail)].join(",")),
  ]
  const file = `migration-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`
  writeFileSync(file, lines.join("\n"))
  console.log(`\n📝 Trace report: ${file} (${report.length} entries)`)
  const counts = new Map<string, number>()
  for (const r of report) {
    const k = `${r.step} / ${r.action}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...counts.entries()].sort()) console.log(`   ${k}: ${n}`)
}

// ─── Step 1: Base tables (events, customers, products, orders, …) ─────────────

async function migrateBase(sheets: Sheets) {
  console.log("═══ Step 1: Base tables ═══")
  console.log("📖 Reading from Google Sheets...")

  const [productsData, customersData, ordersData] =
    await Promise.all([
      readSheet(sheets, SPREADSHEET_ID, "Product!A2:C"),
      readSheet(sheets, SPREADSHEET_ID, "Customer!A2:E"),
      readSheet(sheets, SPREADSHEET_ID, "Duplicate_Form!A2:L"),
    ])

  console.log(`  Products: ${productsData.length} rows`)
  console.log(`  Customers: ${customersData.length} rows`)
  console.log(`  Orders (Duplicate_Form): ${ordersData.length} rows`)

  console.log("\n🗑️  Truncating existing tables (events, excess_purchase, shipments preserved)...")
  await sql`TRUNCATE customers, products, orders RESTART IDENTITY CASCADE`

  // ─── Customers ──────────────────────────────────────────────────────────
  // Skip "gantialamat" (change-address) rows. On duplicate username, keep the
  // LAST occurrence (later rows overwrite earlier ones).
  console.log("\n📥 Inserting customers...")
  type CustomerData = { instagram_id: string; whatsapp: string; data_diri: string; ekspedisi: string; ongkos_kirim: number }
  const customerMap = new Map<string, { row: number; data: CustomerData }>()
  let customerIgnored = 0
  customersData.forEach((row, i) => {
    const sheetRow = i + 2 // sheet data starts at row 2 (A2:E)
    const rawId = String(row[0] ?? "").trim()
    if (!rawId) return
    if (isIgnoredCustomer(rawId)) {
      customerIgnored++
      note("customers", sheetRow, "skipped", `gantialamat username: ${rawId}`)
      return
    }
    const key = rawId.toLowerCase()
    const prev = customerMap.get(key)
    if (prev) note("customers", prev.row, "dropped-duplicate", `${rawId} superseded by later row ${sheetRow}`)
    customerMap.set(key, {
      row: sheetRow,
      data: {
        instagram_id: rawId,
        whatsapp: String(row[1] ?? "").trim(),
        data_diri: String(row[2] ?? "").trim(),
        ekspedisi: String(row[3] ?? "").trim(),
        ongkos_kirim: parseNum(row[4]),
      },
    })
  })
  const customers = [...customerMap.values()].map((v) => v.data)
  if (customers.length > 0) {
    await sql`INSERT INTO customers ${sql(customers)}`
  }
  console.log(`  ✓ ${customers.length} customers (${customerIgnored} gantialamat skipped)`)

  // ─── Products ───────────────────────────────────────────────────────────
  // Append a numeric suffix to duplicate (name, store) pairs so they satisfy the
  // UNIQUE(name, store) constraint. First occurrence keeps its name; the Nth
  // duplicate becomes "name_00N".
  console.log("\n📥 Inserting products...")
  const productSeen = new Map<string, number>()
  let productDupsRenamed = 0
  const products: { name: string; store: string; price: number }[] = []
  productsData.forEach((row, i) => {
    const name = String(row[0] ?? "").trim()
    if (!name) return
    const store = String(row[1] ?? "").trim()
    const price = parseNum(row[2])
    const key = `${name.toLowerCase()}|${store.toLowerCase()}`
    const seen = productSeen.get(key) ?? 0
    productSeen.set(key, seen + 1)
    if (seen === 0) {
      products.push({ name, store, price })
      return
    }
    const finalName = `${name}_${String(seen).padStart(3, "0")}`
    productDupsRenamed++
    note("products", i + 2, "renamed", `"${name}" (store="${store}") → "${finalName}" — duplicate name+store`)
    products.push({ name: finalName, store, price })
  })
  if (products.length > 0) {
    await sql`INSERT INTO products ${sql(products)}`
  }
  console.log(`  ✓ ${products.length} products (${productDupsRenamed} duplicates renamed)`)

  // ─── Orders (Duplicate_Form) ────────────────────────────────────────────
  // The schema uses orders.product_id (FK) + unit_price, not the old `items`
  // text column (former migration 004). So: ensure referenced events/customers
  // exist, ensure a product exists for every order item, then map each item
  // name → product_id (lowest id when a name spans stores) + snapshot price.
  console.log("\n📥 Inserting orders...")
  const rawOrders: {
    _row: number; event: string; customer: string; items: string; unit: number; note: string
    created_at: string; updated_at: string | null; unit_buy: number | null; receipt: string
    unit_arrive: number | null; unit_ship: number | null; unit_hold: number | null
  }[] = []
  ordersData.forEach((row, i) => {
    if (!(row[0]?.trim() || row[1]?.trim() || row[2]?.trim())) return
    rawOrders.push({
      _row: i + 2, // sheet data starts at row 2 (A2:L)
      event: String(row[0] ?? "").trim(),
      customer: String(row[1] ?? "").trim(),
      items: String(row[2] ?? "").trim(),
      unit: parseNum(row[3]) || 0,
      note: String(row[4] ?? "").trim(),
      created_at: parseTimestamp(row[5]) ?? new Date().toISOString(),
      updated_at: parseTimestamp(row[6]),
      unit_buy: optionalNum(row[7]),
      receipt: String(row[8] ?? "").trim(),
      unit_arrive: optionalNum(row[9]),
      unit_ship: optionalNum(row[10]),
      unit_hold: optionalNum(row[11]),
    })
  })

  // Ensure referenced events exist (events sheet is skipped; this only adds
  // names referenced by orders and never overwrites existing events).
  const orderEvents = [...new Set(rawOrders.map((o) => o.event).filter(Boolean))]
  if (orderEvents.length > 0) {
    await sql`INSERT INTO events (name) VALUES ${sql(orderEvents.map((e) => [e]))} ON CONFLICT (name) DO NOTHING`
  }
  // Ensure referenced customers exist.
  const orderCustomers = [...new Set(rawOrders.map((o) => o.customer).filter((c) => c && !isIgnoredCustomer(c)))]
  if (orderCustomers.length > 0) {
    await sql`INSERT INTO customers (instagram_id) VALUES ${sql(orderCustomers.map((c) => [c]))} ON CONFLICT (instagram_id) DO NOTHING`
  }

  // Build item-name → { id, price }; lowest id wins (matches former migration 004).
  const productByName = new Map<string, { id: number; price: number }>()
  const existingProducts = await sql`SELECT DISTINCT ON (name) id, name, price FROM products ORDER BY name, id`
  for (const p of existingProducts) productByName.set(p.name as string, { id: p.id as number, price: p.price as number })

  // Create a bare product for any order item that has no product by that name.
  const missingItems = [...new Set(rawOrders.map((o) => o.items).filter(Boolean))].filter((n) => !productByName.has(n))
  if (missingItems.length > 0) {
    await sql`INSERT INTO products (name, store, price) VALUES ${sql(missingItems.map((n) => [n, "", 0]))} ON CONFLICT (name, store) DO NOTHING`
    const created = await sql`SELECT id, name, price FROM products WHERE name = ANY(${missingItems}) AND store = ''`
    for (const p of created) if (!productByName.has(p.name as string)) productByName.set(p.name as string, { id: p.id as number, price: p.price as number })
    for (const n of missingItems) note("products", "—", "auto-created", `bare product (store="", price=0) for order item: "${n}"`)
  }

  let ordersSkipped = 0
  const orders = rawOrders.flatMap((o) => {
    // event, customer, and product_id are all NOT NULL FKs — skip incomplete rows.
    if (!o.event || !o.customer || isIgnoredCustomer(o.customer)) {
      ordersSkipped++
      const why = !o.event ? "missing event" : !o.customer ? "missing customer" : "gantialamat customer"
      note("orders", o._row, "skipped", `${why} (event="${o.event}" customer="${o.customer}" item="${o.items}")`)
      return []
    }
    const match = o.items ? productByName.get(o.items) : undefined
    if (!match) {
      ordersSkipped++
      note("orders", o._row, "skipped", `no product match for item "${o.items}" (event="${o.event}" customer="${o.customer}")`)
      return []
    }
    return [{
      event: o.event,
      customer: o.customer,
      product_id: match.id,
      unit_price: match.price,
      unit: o.unit,
      note: o.note,
      created_at: o.created_at,
      updated_at: o.updated_at,
      unit_buy: o.unit_buy,
      receipt: o.receipt,
      unit_arrive: o.unit_arrive,
      unit_ship: o.unit_ship,
      unit_hold: o.unit_hold,
    }]
  })

  if (orders.length > 0) {
    // Insert in batches of 500 to avoid query size limits
    for (let i = 0; i < orders.length; i += 500) {
      const batch = orders.slice(i, i + 500)
      await sql`INSERT INTO orders ${sql(batch)}`
      if (orders.length > 500) {
        console.log(`  ... ${Math.min(i + 500, orders.length)}/${orders.length}`)
      }
    }
  }
  console.log(`  ✓ ${orders.length} orders${ordersSkipped > 0 ? ` (${ordersSkipped} skipped — missing product/event/customer)` : ""}`)

  console.log("\nSummary (base):")
  console.log(`  customers:       ${customers.length}`)
  console.log(`  products:        ${products.length}`)
  console.log(`  orders:          ${orders.length}`)
}

// ─── Step 2: Product weights (gram) ──────────────────────────────────────────

async function importProductGram(sheets: Sheets) {
  console.log("\n═══ Step 2: Product weights (gram) ═══")
  // Read Product tab — columns: PRODUCT, STORE, IDR, GRAM
  const rows = await readSheet(sheets, SPREADSHEET_ID, "Product!A:D")
  console.log(`Read ${rows.length - 1} products from Google Sheets`)

  let updated = 0
  let skipped = 0

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const sheetRow = i + 1 // header is row 1
    const name = row[0]?.trim() ?? ""
    if (!name) continue
    const store = row[1]?.trim() ?? ""
    const gram = parseInt(row[3] ?? "0", 10) || 0

    const result = await sql`
      UPDATE products SET gram = ${gram}
      WHERE name = ${name} AND store = ${store}
    `
    if (result.count > 0) {
      updated++
    } else {
      skipped++
      note("gram", sheetRow, "not-found", `no product "${name}" | store "${store}" to set gram=${gram}`)
    }
  }

  console.log(`  Updated: ${updated}`)
  console.log(`  Not found in DB: ${skipped} (see report)`)
}

// ─── Step 3: Product pricing (valas / kurs / cargo / % / country) ─────────────

async function importProductPricing(sheets: Sheets) {
  console.log("\n═══ Step 3: Product pricing ═══")
  if (!PRODUCT_INDO_SPREADSHEET_ID) {
    console.warn("  ⚠ GOOGLE_PRODUCT_INDO_SPREADSHEET_ID not set — skipping pricing import")
    return
  }

  const rows = await readSheet(sheets, PRODUCT_INDO_SPREADSHEET_ID, "Product_Percentage!A:K")
  if (rows.length < 2) {
    console.log("  No data found in Product_Percentage sheet")
    return
  }

  // Parse header to find column indices
  const header = rows[0].map((h) => String(h).trim().toUpperCase())
  const colMap: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) colMap[header[i]] = i

  const COL_ITEMS = colMap["ITEMS"] ?? colMap["ITEM"] ?? 0
  const COL_PRICE = colMap["IDR"] ?? colMap["PRICE"] ?? 1
  const COL_STORE = colMap["STORE"] ?? 2
  const COL_VLS = colMap["VLS"] ?? colMap["VALAS"] ?? 3
  const COL_GRAM = colMap["GRAM"] ?? colMap["GRAMS"] ?? 4
  const COL_PCT = colMap["%"] ?? colMap["# %"] ?? 5
  const COL_CN = colMap["CN"] ?? colMap["COUNTRY"] ?? 8
  const COL_KURS = colMap["KURS"] ?? 9
  const COL_CARGO = colMap["CARGO"] ?? 10

  console.log("Column mapping:", { ITEMS: COL_ITEMS, IDR: COL_PRICE, STORE: COL_STORE, VLS: COL_VLS, GRAM: COL_GRAM, "%": COL_PCT, CN: COL_CN, KURS: COL_KURS, CARGO: COL_CARGO })

  // Map country names → IDs (countries must already be seeded)
  const countriesDb = await sql`SELECT id, name FROM countries`
  const countryMap = new Map<string, number>()
  for (const c of countriesDb) countryMap.set(String(c.name).toUpperCase(), c.id as number)
  console.log("Countries in DB:", [...countryMap.entries()].map(([k, v]) => `${k}=${v}`).join(", "))

  // Build product lookup: lowercase "name|store|price"
  const productsDb = await sql`SELECT id, name, store, price FROM products`
  const productLookup = new Map<string, number>()
  for (const p of productsDb) {
    productLookup.set(`${String(p.name).toLowerCase()}|${String(p.store).toLowerCase()}|${p.price}`, p.id as number)
  }
  console.log(`Loaded ${productsDb.length} products from DB`)

  const cell = (row: string[], col: number): string => String(row[col] ?? "").trim()
  const cellNum = (row: string[], col: number): number => Number(cell(row, col).replace(/,/g, "")) || 0

  let matched = 0
  let skipped = 0
  let notFound = 0
  const updates: { id: number; valas: number; gram: number; kurs: number; cargoPerKg: number; profitPct: number; countryId: number | null }[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const name = cell(row, COL_ITEMS)
    const store = cell(row, COL_STORE)
    const price = cellNum(row, COL_PRICE)
    if (!name) { skipped++; continue }

    const productId = productLookup.get(`${name.toLowerCase()}|${store.toLowerCase()}|${price}`)
    if (productId === undefined) {
      notFound++
      note("pricing", i + 1, "not-found", `no product "${name}" | store "${store}" | price ${price} — pricing not applied`)
      continue
    }

    const countryCode = cell(row, COL_CN).toUpperCase()
    const countryId = countryCode ? (countryMap.get(countryCode) ?? null) : null
    if (countryCode && countryId === null) {
      note("pricing", i + 1, "unknown-country", `country code "${countryCode}" not in countries table (product "${name}") — country_id left null`)
    }

    updates.push({
      id: productId,
      valas: cellNum(row, COL_VLS),
      gram: cellNum(row, COL_GRAM),
      kurs: cellNum(row, COL_KURS),
      cargoPerKg: cellNum(row, COL_CARGO),
      profitPct: cellNum(row, COL_PCT),
      countryId,
    })
    matched++
  }

  console.log(`Parsed ${rows.length - 1} rows: ${matched} matched, ${notFound} not found, ${skipped} skipped (empty)`)

  if (dryRun) {
    console.log("--- DRY RUN — no pricing changes written ---")
    for (const u of updates.slice(0, 10)) {
      console.log(`  Product #${u.id}: valas=${u.valas} gram=${u.gram} kurs=${u.kurs} cargo=${u.cargoPerKg} pct=${u.profitPct} country=${u.countryId}`)
    }
    if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more`)
    return
  }

  console.log(`Updating ${updates.length} products...`)
  await sql.begin(async (tx) => {
    for (const u of updates) {
      await tx`
        UPDATE products
        SET valas = ${u.valas}, gram = ${u.gram}, kurs = ${u.kurs},
            cargo_per_kg = ${u.cargoPerKg}, profit_pct = ${u.profitPct}, country_id = ${u.countryId}
        WHERE id = ${u.id}
      `
    }
  })
  console.log(`  ✓ Updated ${updates.length} products`)
}

// ─── Step 4: Payments ────────────────────────────────────────────────────────

async function importPayments(sheets: Sheets) {
  console.log("\n═══ Step 4: Payments ═══")
  // Payment tab — A=Event, B=Customer, C=Payment, D=Account, E=Check, F=Date, G=Remarks
  const rows = await readSheet(sheets, SPREADSHEET_ID, "Payment!A:G")
  console.log(`Read ${rows.length - 1} payment rows from Google Sheets`)

  type Pay = { event: string; customer: string; amount: number; account: string; isChecked: boolean; payDate: string | null; remarks: string }
  const valid: Pay[] = []
  let skipped = 0
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const sheetRow = i + 1 // header is row 1
    const event = row[0]?.trim() ?? ""
    const customerRaw = row[1]?.trim() ?? ""
    if (!event && !customerRaw) continue // blank row
    if (!event || !customerRaw) {
      skipped++
      note("payments", sheetRow, "skipped", `missing ${!event ? "event" : "customer"}`)
      continue
    }
    const customer = normalizeCustomer(customerRaw)
    if (isIgnoredCustomer(customer)) {
      skipped++
      note("payments", sheetRow, "skipped", `gantialamat customer: ${customer}`)
      continue
    }
    const rawDate = row[5]?.trim() ?? ""
    // Convert "20-Jan" → "2026-01-20" for DATE column; leave empty as null
    let payDate: string | null = null
    if (rawDate) {
      const parsed = new Date(`${rawDate}-2026`)
      if (!isNaN(parsed.getTime())) payDate = parsed.toISOString().slice(0, 10)
    }
    valid.push({
      event,
      customer,
      amount: parseInt((row[2] ?? "0").replace(/,/g, ""), 10) || 0,
      account: row[3]?.trim() ?? "",
      isChecked: (row[4] ?? "").toUpperCase() === "TRUE",
      payDate,
      remarks: row[6]?.trim() ?? "",
    })
  }

  // Auto-create customers / events referenced by the valid payments
  const uniqueCustomers = [...new Set(valid.map((p) => p.customer))]
  if (uniqueCustomers.length > 0) {
    await sql`INSERT INTO customers (instagram_id) VALUES ${sql(uniqueCustomers.map((c) => [c]))} ON CONFLICT (instagram_id) DO NOTHING`
  }
  const uniqueEvents = [...new Set(valid.map((p) => p.event))]
  if (uniqueEvents.length > 0) {
    await sql`INSERT INTO events (name) VALUES ${sql(uniqueEvents.map((e) => [e]))} ON CONFLICT (name) DO NOTHING`
  }

  let inserted = 0
  for (const p of valid) {
    await sql`
      INSERT INTO payments (event, customer, amount, account, is_checked, pay_date, remarks)
      VALUES (${p.event}, ${p.customer}, ${p.amount}, ${p.account}, ${p.isChecked}, ${p.payDate}, ${p.remarks})
    `
    inserted++
  }

  console.log(`  Inserted: ${inserted}`)
  console.log(`  Skipped: ${skipped} (see report)`)
}

// ─── Step 5: Adjustments (biaya lainnya) ─────────────────────────────────────

async function importAdjustments(sheets: Sheets) {
  console.log("\n═══ Step 5: Adjustments ═══")
  const allRows = await readSheet(sheets, SPREADSHEET_ID, "Order_JanganDisort_DifilterAja")
  if (allRows.length < 2) {
    console.warn("  ⚠ Adjustments sheet is empty or has no data rows — skipping")
    return
  }

  const headers = allRows[0].map((h) => h.trim())
  const dataRows = allRows.slice(1)

  const eventCol = headers.findIndex((h) => /^event$/i.test(h))
  const customerCol = headers.findIndex((h) => /^customer$/i.test(h))
  const lainnyaCol = headers.findIndex((h) => /lainnya/i.test(h))

  if (eventCol === -1 || customerCol === -1 || lainnyaCol === -1) {
    console.error("  Could not find required columns (Event / Customer / Lainnya) — skipping adjustments")
    console.error(`  Headers found: ${headers.join(", ")}`)
    return
  }
  console.log(`Found columns — Event: ${eventCol}, Customer: ${customerCol}, Lainnya: ${lainnyaCol}`)

  // Group by (event, customer) → one adjustment per unique pair where amount != 0
  const adjustments = new Map<string, { event: string; customer: string; amount: number }>()
  for (const row of dataRows) {
    const event = (row[eventCol] ?? "").trim()
    const customer = normalizeCustomer(row[customerCol] ?? "")
    const amount = parseInt((row[lainnyaCol] ?? "").toString().replace(/,/g, "").trim(), 10) || 0
    if (!event || !customer || amount === 0 || isIgnoredCustomer(customer)) continue
    const key = `${event}|||${customer}`
    if (!adjustments.has(key)) adjustments.set(key, { event, customer, amount })
  }
  console.log(`Found ${adjustments.size} unique (event, customer) adjustments`)

  let inserted = 0
  let skipped = 0
  for (const { event, customer, amount } of adjustments.values()) {
    try {
      await sql`INSERT INTO customers (instagram_id) VALUES (${customer}) ON CONFLICT (instagram_id) DO NOTHING`
      await sql`
        INSERT INTO adjustments (event, customer, description, amount)
        VALUES (${event}, ${customer}, ${"Biaya Lainnya"}, ${amount})
      `
      inserted++
    } catch (err) {
      skipped++
      note("adjustments", "—", "error", `(${event}, ${customer}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`  Inserted: ${inserted}`)
  if (skipped > 0) console.log(`  Skipped: ${skipped}`)
}

// ─── Run all steps in order ──────────────────────────────────────────────────

async function main() {
  const sheets = getSheetsClient()
  if (dryRun) console.log("⚠ --dry-run: step 3 (pricing) will not write; steps 1/2/4/5 still run.\n")

  try {
    await migrateBase(sheets)
    await importProductGram(sheets)
    await importProductPricing(sheets)
    await importPayments(sheets)
    await importAdjustments(sheets)
    console.log("\n✅ All migration steps complete!")
  } finally {
    // Always write the trace report — even if a step failed partway.
    writeReport()
    await sql.end()
  }
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err)
  process.exit(1)
})
