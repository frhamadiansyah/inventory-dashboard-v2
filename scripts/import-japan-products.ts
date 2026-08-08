/**
 * Import Japan product master: CSV → Supabase `products`.
 *
 * Insert-only: existing (name, store) rows are NEVER modified
 * (ON CONFLICT (name, store) DO NOTHING). Junk rows are skipped:
 *   - blank PRODUCT name
 *   - spreadsheet error tokens (#N/A, #VALUE!, #REF!, …) in any numeric cell
 *   - placeholder / unpriced stubs (IDR price <= 5000)
 * Duplicate (name, store) pairs WITHIN the CSV: the first occurrence wins. A
 * later row with the SAME name+store is reported as skip-dup ONLY when its
 * mapped values are identical (a true repeat). If the values differ (same name,
 * genuinely different product), it is inserted under a numeric suffix
 * (name_002, name_003, …) so both survive UNIQUE(name, store).
 *
 * Prices are NOT taken from the CSV. They are recomputed with the app's own
 * pricing (lib/pricing.calcAbroadPrice), so the imported rows are identical to
 * what the product form would have produced. This mirrors how overseas products
 * are actually stored (see app/api/sheets/products POST): cost and profit_fixed
 * are left 0 — COGS/profit are derived on display, never persisted.
 *
 * Column mapping (CSV header → products column):
 *   PRODUCT        → name
 *   STORE          → store
 *   GRAM           → gram
 *   JPY            → valas
 *   %              → profit_pct
 *   COUNTRY (code) → country_id      (looked up in countries.name)
 * Taken from the matched country row, NOT the CSV (source of truth = countries):
 *   kurs, cargo_per_kg
 * Computed / fixed:
 *   price          = calcAbroadPrice(valas, kurs, gram, cargoPerKg, profitPct, 5000, 5000)
 *   operational_fee = 5000, packing_fee = 5000
 *   cost           = 0, profit_fixed = 0   (derived on display, like the app)
 * The CSV's IDR / COGS / GROSS PROFIT / KURS / CARGO / CODE columns are ignored
 * for storage; IDR is used only as a junk signal (placeholder rows have IDR ≤ 5000).
 *
 * Usage (DRY-RUN, inserts nothing, prints the full report):
 *   node --import=tsx --env-file=.env.local scripts/import-japan-products.ts \
 *     scripts/data/japan-products.csv
 *
 * Usage (COMMIT — actually inserts into whatever DATABASE_URL points to):
 *   node --import=tsx --env-file=.env.local scripts/import-japan-products.ts \
 *     scripts/data/japan-products.csv --commit
 *
 * Required env var:
 *   DATABASE_URL — Supabase pooler connection string
 */

import { readFileSync, writeFileSync } from "node:fs"
import postgres from "postgres"
import { calcAbroadPrice } from "../lib/pricing"

const OP_FEE = 5000
const PACK_FEE = 5000

const argv = process.argv.slice(2)
let csvPath: string | undefined
let commit = false
let limit = Infinity // cap on how many candidate rows to actually insert
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--commit") commit = true
  else if (a === "--limit") limit = Number(argv[++i])
  else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length))
  else if (!a.startsWith("--") && !csvPath) csvPath = a
}
if (!Number.isFinite(limit) && limit !== Infinity) { console.error("❌ --limit must be a number"); process.exit(1) }

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}
if (!csvPath) {
  console.error("❌ Usage: import-japan-products.ts <path-to-csv> [--commit]")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

// Values are quoted with thousands commas (e.g. "88,625"). Strip everything but
// digits/sign/dot. Error tokens like "#N/A" must be caught BEFORE this (they'd
// silently become 0 here).
function parseNum(v: string | undefined): number {
  if (!v || !v.trim()) return 0
  return Number(String(v).replace(/[^0-9.-]/g, "")) || 0
}

// A spreadsheet error leaks into the export as a cell starting with '#'.
function isErr(v: string | undefined): boolean {
  return !!v && v.trim().startsWith("#")
}

// Minimal RFC-4180 parser: quoted fields, embedded commas, "" escapes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field); field = ""
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = ""
    } else if (c !== "\r") {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

type Status = "insert" | "skip-junk" | "skip-existing" | "skip-dup"
type Values = {
  name: string; store: string; price: number; gram: number; country_id: number | null
  valas: number; kurs: number; cargo_per_kg: number; profit_pct: number
  operational_fee: number; packing_fee: number; cost: number; profit_fixed: number
}
type Classified = {
  line: number
  name: string
  store: string
  status: Status
  reason: string
  values?: Values
}

// Fingerprint over the CSV inputs that distinguish two products sharing a
// name+store (e.g. Lace differs by valas, Cloudway 2 differs by gram).
function fingerprint(v: Values): string {
  return [v.valas, v.gram, v.profit_pct].join("|")
}

async function main() {
  const rows = parseCsv(readFileSync(csvPath!, "utf8"))
  if (rows.length < 2) {
    console.error("❌ CSV has no data rows")
    process.exit(1)
  }

  const header = rows[0].map((h) => h.trim())
  const col = (name: string) => {
    const idx = header.indexOf(name)
    if (idx === -1) {
      console.error(`❌ CSV missing column "${name}". Headers: ${header.join(", ")}`)
      process.exit(1)
    }
    return idx
  }
  const iName = col("PRODUCT")
  const iStore = col("STORE")
  const iJpy = col("JPY")
  const iGram = col("GRAM")
  const iPct = col("%")
  const iCogs = col("COGS")
  const iIdr = col("IDR")
  const iGross = col("GROSS PROFIT")
  const iCountry = col("COUNTRY")
  const iKurs = col("KURS")
  const iCargo = col("CARGO")

  // country code → { id, kurs, cargo } (e.g. JP → 2). kurs/cargo are the source
  // of truth for pricing — the CSV's own KURS/CARGO columns are ignored.
  const countries = await sql`SELECT id, name, kurs, cargo_per_kg FROM countries`
  const countryByCode = new Map<string, { id: number; kurs: number; cargo: number }>()
  for (const c of countries) {
    countryByCode.set(String(c.name).trim().toUpperCase(), {
      id: c.id as number, kurs: Number(c.kurs), cargo: Number(c.cargo_per_kg),
    })
  }

  // Existing (name, store) pairs already in the DB — case-insensitive match.
  const existing = await sql`SELECT lower(name) name, lower(store) store FROM products`
  const existingKey = new Set<string>()
  for (const p of existing) existingKey.add(`${p.name}|${p.store}`)

  // in-CSV dedup: key → { fingerprints already inserted for this key, count }
  const seen = new Map<string, { prints: Set<string>; count: number }>()
  const classified: Classified[] = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.length === 1 && row[0].trim() === "") continue // blank trailing line
    const line = r + 1 // 1-based CSV line number (header = line 1)
    const name = String(row[iName] ?? "").trim()
    const store = String(row[iStore] ?? "").trim()

    if (!name) {
      classified.push({ line, name, store, status: "skip-junk", reason: "blank product name" })
      continue
    }
    // Any spreadsheet error token in a numeric cell → unusable row.
    const numeric = [row[iJpy], row[iGram], row[iPct], row[iCogs], row[iIdr], row[iGross], row[iKurs], row[iCargo]]
    if (numeric.some(isErr)) {
      classified.push({ line, name, store, status: "skip-junk", reason: "spreadsheet error token in numeric cell" })
      continue
    }
    const price = parseNum(row[iIdr])
    if (price <= 5000) {
      classified.push({ line, name, store, status: "skip-junk", reason: `placeholder / unpriced (IDR=${price})` })
      continue
    }

    const key = `${name.toLowerCase()}|${store.toLowerCase()}`
    if (existingKey.has(key)) {
      classified.push({ line, name, store, status: "skip-existing", reason: "already in products (name+store)" })
      continue
    }

    const countryCode = String(row[iCountry] ?? "").trim().toUpperCase()
    const country = countryByCode.get(countryCode)
    if (!country) {
      classified.push({ line, name, store, status: "skip-junk", reason: `unknown country code "${countryCode}"` })
      continue
    }
    const gram = parseNum(row[iGram])
    const valas = parseNum(row[iJpy])
    const profitPct = parseNum(row[iPct])
    // Price via the app's own pricing — identical to what the product form saves.
    const { price: computedPrice } = calcAbroadPrice({
      valas, kurs: country.kurs, gram, cargoPerKg: country.cargo,
      profitPct, operationalFee: OP_FEE, packingFee: PACK_FEE,
    })
    const values: Values = {
      name, store,
      price: computedPrice,
      gram,
      country_id: country.id,
      valas,
      kurs: country.kurs,
      cargo_per_kg: country.cargo,
      profit_pct: profitPct,
      operational_fee: OP_FEE,
      packing_fee: PACK_FEE,
      cost: 0,          // derived on display, like the app
      profit_fixed: 0,  // derived on display, like the app
    }
    const fp = fingerprint(values)
    const prior = seen.get(key)
    if (prior) {
      if (prior.prints.has(fp)) {
        // Identical values → a true repeat. Drop it.
        classified.push({ line, name, store, status: "skip-dup", reason: "identical repeat of an earlier CSV row" })
        continue
      }
      // Same name+store, different values → distinct product. Keep, suffixed.
      prior.count += 1
      prior.prints.add(fp)
      const finalName = `${name}_${String(prior.count).padStart(3, "0")}`
      values.name = finalName
      classified.push({
        line, name: finalName, store, status: "insert",
        reason: `renamed from "${name}" — same name+store as an earlier row but different values`,
        values,
      })
      continue
    }
    seen.set(key, { prints: new Set([fp]), count: 1 })
    classified.push({ line, name, store, status: "insert", reason: "", values })
  }

  const by = (s: Status) => classified.filter((c) => c.status === s)
  const toInsert = by("insert")
  const junk = by("skip-junk")
  const existingSkipped = by("skip-existing")
  const dup = by("skip-dup")

  // ── Report ────────────────────────────────────────────────────────────────
  const printGroup = (title: string, items: Classified[]) => {
    console.log(`\n── ${title} (${items.length}) ──`)
    for (const c of items) {
      console.log(`  line ${c.line}: "${c.name}"${c.store ? ` [${c.store}]` : ""}${c.reason ? ` — ${c.reason}` : ""}`)
    }
  }

  console.log(`\nMode: ${commit ? "COMMIT (will INSERT)" : "DRY-RUN (no writes)"}`)
  console.log(`Target DB host: ${new URL(process.env.DATABASE_URL!.replace(/^postgres/, "http")).host}`)
  console.log(`\nData rows: ${classified.length}`)
  console.log(`  insert        : ${toInsert.length}`)
  console.log(`  skip-existing : ${existingSkipped.length}`)
  console.log(`  skip-junk     : ${junk.length}`)
  console.log(`  skip-dup      : ${dup.length}`)

  printGroup("SKIP-JUNK", junk)
  printGroup("SKIP-DUP (in-CSV duplicate)", dup)
  printGroup("SKIP-EXISTING", existingSkipped)
  printGroup("TO INSERT", toInsert)

  // Full machine-readable report next to the CSV.
  const reportPath = csvPath!.replace(/\.csv$/, "") + `-import-report-${commit ? "commit" : "dryrun"}.csv`
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
  const reportLines = ["line,status,reason,name,store"]
  for (const c of classified) reportLines.push([c.line, c.status, esc(c.reason), esc(c.name), esc(c.store)].join(","))
  writeFileSync(reportPath, reportLines.join("\n"))
  console.log(`\nFull row-by-row report: ${reportPath}`)

  if (!commit) {
    console.log(`\nDRY-RUN complete — nothing written. Re-run with --commit to insert ${toInsert.length} rows.`)
    await sql.end()
    return
  }

  const capped = Number.isFinite(limit) ? toInsert.slice(0, limit) : toInsert
  if (capped.length < toInsert.length) {
    console.log(`\n--limit ${limit}: inserting only the first ${capped.length} of ${toInsert.length} candidates.`)
  }
  if (capped.length === 0) {
    console.log("\nNothing to insert.")
    await sql.end()
    return
  }

  const payload = capped.map((c) => c.values!)
  const inserted = await sql`
    INSERT INTO products ${sql(payload, "name", "store", "price", "gram", "country_id", "valas", "kurs", "cargo_per_kg", "profit_pct", "operational_fee", "packing_fee", "cost", "profit_fixed")}
    ON CONFLICT (name, store) DO NOTHING
    RETURNING id, name, store
  `
  console.log(`\n✓ Inserted ${inserted.length} of ${capped.length} attempted rows.`)
  if (inserted.length !== capped.length) {
    console.log(`  (${capped.length - inserted.length} hit ON CONFLICT — inserted by a concurrent run or a case-variant already present.)`)
  }
  for (const r of inserted) console.log(`  #${r.id} "${r.name}"${r.store ? ` [${r.store}]` : ""}`)
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
