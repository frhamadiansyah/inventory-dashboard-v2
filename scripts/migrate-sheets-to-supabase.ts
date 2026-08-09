/**
 * One-time data migration: Google Sheets → Supabase (Postgres) — ALL STEPS
 *
 * Combines the previously-separate scripts into a single ordered run:
 *   1. Base tables (TRUNCATE + insert): events, customers, products,
 *      products_indo, orders, excess_purchase, shipments      [main spreadsheet]
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

// ─── Step 1: Base tables (events, customers, products, orders, …) ─────────────

async function migrateBase(sheets: Sheets) {
  console.log("═══ Step 1: Base tables ═══")
  console.log("📖 Reading from Google Sheets...")

  const [eventsData, productsData, customersData, ordersData, excessData, shippingData, productIndoData] =
    await Promise.all([
      readSheet(sheets, SPREADSHEET_ID, "Events!A2:A"),
      readSheet(sheets, SPREADSHEET_ID, "Product!A2:C"),
      readSheet(sheets, SPREADSHEET_ID, "Customer!A2:E"),
      readSheet(sheets, SPREADSHEET_ID, "Duplicate_Form!A2:L"),
      readSheet(sheets, SPREADSHEET_ID, "Excess_Purchase!A2:F"),
      readSheet(sheets, SPREADSHEET_ID, "Shipping_table!A2:K"),
      PRODUCT_INDO_SPREADSHEET_ID
        ? readSheet(sheets, PRODUCT_INDO_SPREADSHEET_ID, "Product_Indo!A2:C")
        : Promise.resolve([]),
    ])

  console.log(`  Events: ${eventsData.length} rows`)
  console.log(`  Products: ${productsData.length} rows`)
  console.log(`  Customers: ${customersData.length} rows`)
  console.log(`  Orders (Duplicate_Form): ${ordersData.length} rows`)
  console.log(`  Excess Purchase: ${excessData.length} rows`)
  console.log(`  Shipments: ${shippingData.length} rows`)
  console.log(`  Products Indo: ${productIndoData.length} rows`)

  console.log("\n🗑️  Truncating existing tables...")
  await sql`TRUNCATE events, customers, products, products_indo, orders, excess_purchase, shipments RESTART IDENTITY CASCADE`

  // ─── Events ─────────────────────────────────────────────────────────────
  console.log("\n📥 Inserting events...")
  const events = eventsData
    .map((row) => row[0]?.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // dedupe
  if (events.length > 0) {
    await sql`INSERT INTO events ${sql(events.map((name) => ({ name })))}`
  }
  console.log(`  ✓ ${events.length} events`)

  // ─── Customers ──────────────────────────────────────────────────────────
  console.log("\n📥 Inserting customers...")
  const customers = customersData
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      instagram_id: String(row[0] ?? "").trim(),
      whatsapp: String(row[1] ?? "").trim(),
      data_diri: String(row[2] ?? "").trim(),
      ekspedisi: String(row[3] ?? "").trim(),
      ongkos_kirim: parseNum(row[4]),
    }))
  if (customers.length > 0) {
    // Some customers may have duplicate instagram_ids — take the first
    const seen = new Set<string>()
    const unique = customers.filter((c) => {
      const key = c.instagram_id.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    await sql`INSERT INTO customers ${sql(unique)}`
    console.log(`  ✓ ${unique.length} customers (${customers.length - unique.length} duplicates skipped)`)
  }

  // ─── Products ───────────────────────────────────────────────────────────
  console.log("\n📥 Inserting products...")
  const products = productsData
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      name: String(row[0] ?? "").trim(),
      store: String(row[1] ?? "").trim(),
      price: parseNum(row[2]),
    }))
  if (products.length > 0) {
    await sql`INSERT INTO products ${sql(products)}`
  }
  console.log(`  ✓ ${products.length} products`)

  // ─── Products Indo ──────────────────────────────────────────────────────
  console.log("\n📥 Inserting products_indo...")
  const productsIndo = productIndoData
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      product: String(row[0] ?? "").trim(),
      store: String(row[1] ?? "").trim(),
      price: parseNum(row[2]),
    }))
  if (productsIndo.length > 0) {
    await sql`INSERT INTO products_indo ${sql(productsIndo)}`
  }
  console.log(`  ✓ ${productsIndo.length} products_indo`)

  // ─── Orders (Duplicate_Form) ────────────────────────────────────────────
  console.log("\n📥 Inserting orders...")
  const orders = ordersData
    .filter((row) => row[0]?.trim() || row[1]?.trim() || row[2]?.trim())
    .map((row) => ({
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
    }))
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
  console.log(`  ✓ ${orders.length} orders`)

  // ─── Excess Purchase ────────────────────────────────────────────────────
  console.log("\n📥 Inserting excess_purchase...")
  const excess = excessData
    .filter((row) => row[0]?.trim() || row[1]?.trim())
    .map((row) => ({
      event: String(row[0] ?? "").trim(),
      items: String(row[1] ?? "").trim(),
      unit_buy: parseNum(row[2]) || 0,
      receipt: String(row[3] ?? "").trim(),
      created_at: parseTimestamp(row[4]) ?? new Date().toISOString(),
      updated_at: parseTimestamp(row[5]),
    }))
  if (excess.length > 0) {
    await sql`INSERT INTO excess_purchase ${sql(excess)}`
  }
  console.log(`  ✓ ${excess.length} excess_purchase`)

  // ─── Shipments ──────────────────────────────────────────────────────────
  console.log("\n📥 Inserting shipments...")
  const shipments = shippingData
    .filter((row) => row[2]?.trim()) // must have a shipping_id
    .map((row) => ({
      event: String(row[0] ?? "").trim(),
      customer: String(row[1] ?? "").trim(),
      shipping_id: String(row[2] ?? "").trim().padStart(4, "0"),
      invoicing: String(row[3] ?? "").trim(),
      weight_estimation: parseNum(row[4]),
      ongkir: parseNum(row[5]),
      ongkir_total: parseNum(row[6]),
      is_last_shipment: String(row[7] ?? "").toUpperCase() === "TRUE",
      created_at: parseTimestamp(row[8]) ?? new Date().toISOString(),
      updated_at: parseTimestamp(row[9]),
      tracking_number: String(row[10] ?? "").trim(),
    }))
  if (shipments.length > 0) {
    await sql`INSERT INTO shipments ${sql(shipments)}`
  }
  console.log(`  ✓ ${shipments.length} shipments`)

  console.log("\nSummary (base):")
  console.log(`  events:          ${events.length}`)
  console.log(`  customers:       ${customers.length}`)
  console.log(`  products:        ${products.length}`)
  console.log(`  products_indo:   ${productsIndo.length}`)
  console.log(`  orders:          ${orders.length}`)
  console.log(`  excess_purchase: ${excess.length}`)
  console.log(`  shipments:       ${shipments.length}`)
}

// ─── Step 2: Product weights (gram) ──────────────────────────────────────────

async function importProductGram(sheets: Sheets) {
  console.log("\n═══ Step 2: Product weights (gram) ═══")
  // Read Product tab — columns: PRODUCT, STORE, IDR, GRAM
  const rows = await readSheet(sheets, SPREADSHEET_ID, "Product!A:D")
  const dataRows = rows.slice(1).filter((r) => r[0]?.trim())
  console.log(`Read ${dataRows.length} products from Google Sheets`)

  let updated = 0
  let skipped = 0
  const notFound: string[] = []

  for (const row of dataRows) {
    const name = row[0]?.trim() ?? ""
    const store = row[1]?.trim() ?? ""
    const gram = parseInt(row[3] ?? "0", 10) || 0
    if (!name) continue

    const result = await sql`
      UPDATE products SET gram = ${gram}
      WHERE name = ${name} AND store = ${store}
    `
    if (result.count > 0) {
      updated++
    } else {
      skipped++
      notFound.push(`${name} | ${store}`)
    }
  }

  console.log(`  Updated: ${updated}`)
  console.log(`  Not found in DB: ${skipped}`)
  if (notFound.length > 0) {
    console.log(`  Products not found (no match by name+store):`)
    for (const p of notFound) console.log(`    - ${p}`)
  }
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
      console.warn(`  NOT FOUND: "${name}" | "${store}" | ${price}`)
      notFound++
      continue
    }

    const countryCode = cell(row, COL_CN).toUpperCase()
    const countryId = countryCode ? (countryMap.get(countryCode) ?? null) : null
    if (countryCode && countryId === null) {
      console.warn(`  UNKNOWN COUNTRY "${countryCode}" for product "${name}" (row ${i + 1})`)
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
  const dataRows = rows.slice(1).filter((r) => r[0]?.trim() && r[1]?.trim())
  console.log(`Read ${dataRows.length} payment rows from Google Sheets`)

  // Auto-create customers / events referenced by payments
  const uniqueCustomers = [...new Set(dataRows.map((r) => normalizeCustomer(r[1])))]
  if (uniqueCustomers.length > 0) {
    await sql`INSERT INTO customers (instagram_id) VALUES ${sql(uniqueCustomers.map((c) => [c]))} ON CONFLICT (instagram_id) DO NOTHING`
  }
  const uniqueEvents = [...new Set(dataRows.map((r) => r[0].trim()).filter(Boolean))]
  if (uniqueEvents.length > 0) {
    await sql`INSERT INTO events (name) VALUES ${sql(uniqueEvents.map((e) => [e]))} ON CONFLICT (name) DO NOTHING`
  }

  let inserted = 0
  let skipped = 0
  for (const row of dataRows) {
    const event = row[0]?.trim() ?? ""
    const customer = normalizeCustomer(row[1])
    const amount = parseInt((row[2] ?? "0").replace(/,/g, ""), 10) || 0
    const account = row[3]?.trim() ?? ""
    const isChecked = (row[4] ?? "").toUpperCase() === "TRUE"
    const rawDate = row[5]?.trim() ?? ""
    // Convert "20-Jan" → "2026-01-20" for DATE column; leave empty as null
    let payDate: string | null = null
    if (rawDate) {
      const parsed = new Date(`${rawDate}-2026`)
      if (!isNaN(parsed.getTime())) payDate = parsed.toISOString().slice(0, 10)
    }
    const remarks = row[6]?.trim() ?? ""

    if (!event || !customer) { skipped++; continue }

    await sql`
      INSERT INTO payments (event, customer, amount, account, is_checked, pay_date, remarks)
      VALUES (${event}, ${customer}, ${amount}, ${account}, ${isChecked}, ${payDate}, ${remarks})
    `
    inserted++
  }

  console.log(`  Inserted: ${inserted}`)
  console.log(`  Skipped (missing event/customer): ${skipped}`)
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
    if (!event || !customer || amount === 0) continue
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
      console.warn(`  ⚠ Skipped (${event}, ${customer}): ${err instanceof Error ? err.message : err}`)
      skipped++
    }
  }
  console.log(`  Inserted: ${inserted}`)
  if (skipped > 0) console.log(`  Skipped: ${skipped}`)
}

// ─── Run all steps in order ──────────────────────────────────────────────────

async function main() {
  const sheets = getSheetsClient()
  if (dryRun) console.log("⚠ --dry-run: step 3 (pricing) will not write; steps 1/2/4/5 still run.\n")

  await migrateBase(sheets)
  await importProductGram(sheets)
  await importProductPricing(sheets)
  await importPayments(sheets)
  await importAdjustments(sheets)

  await sql.end()
  console.log("\n✅ All migration steps complete!")
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err)
  process.exit(1)
})
