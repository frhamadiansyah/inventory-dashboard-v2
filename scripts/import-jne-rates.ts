/**
 * Import JNE shipping rates for ONE origin warehouse: CSV → Supabase `jne_rates`.
 *
 * Each warehouse ships from a different origin city, so it has its own rate sheet.
 * Rows are tagged with --origin <code> (must match a warehouses.code) and this
 * script replaces ONLY that origin's rows — other origins' rates are untouched.
 * The CSV is bulky, re-importable reference data and is gitignored (scripts/data/).
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/import-jne-rates.ts \
 *     scripts/data/database_jne_cimahi.csv --origin CIMAHI
 *
 * Required env var:
 *   DATABASE_URL — Supabase pooler connection string
 *
 * The CSV is mapped BY HEADER NAME, so extra exported columns (COUNTIF,
 * kecamatan_nama_code, destination_village_code, postal_code_used, …) are
 * ignored. Expected headers:
 *   provinsi_nama, kab_kota_nama, kecamatan_nama,
 *   village_postal_codes, bs_jne_reg_duration,
 *   and a price column named `final_price` OR `bs_jne_reg_price`
 *   (raw JNE export uses bs_jne_reg_price; the post-processed sheet uses final_price).
 */

import { readFileSync } from "node:fs"
import postgres from "postgres"

// Parse args: <path-to-csv> --origin <code>  (order-independent).
const argv = process.argv.slice(2)
let csvPath: string | undefined
let originCode: string | undefined
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--origin") originCode = argv[++i]
  else if (a.startsWith("--origin=")) originCode = a.slice("--origin=".length)
  else if (!csvPath) csvPath = a
}
originCode = originCode?.trim()

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}
if (!csvPath) {
  console.error("❌ Usage: import-jne-rates.ts <path-to-csv> --origin <warehouse-code>")
  process.exit(1)
}
if (!originCode) {
  console.error("❌ --origin <warehouse-code> is required (must match a warehouses.code)")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

// final_price is quoted with a thousands comma in the export (e.g. "76,000").
function parseNum(v: string | undefined): number {
  if (!v || !v.trim()) return 0
  return Number(String(v).replace(/[^0-9.-]/g, "")) || 0
}

// Minimal RFC-4180 parser: handles quoted fields, embedded commas, and "" escapes.
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
      console.error(`❌ CSV is missing required column "${name}". Headers: ${header.join(", ")}`)
      process.exit(1)
    }
    return idx
  }
  // Accept any of the given header names (first match wins). Lets the script take
  // both the raw JNE export (price = bs_jne_reg_price) and the post-processed
  // sheet format (price = final_price).
  const colAny = (...names: string[]) => {
    for (const n of names) {
      const idx = header.indexOf(n)
      if (idx !== -1) return idx
    }
    console.error(`❌ CSV is missing a price column (one of: ${names.join(", ")}). Headers: ${header.join(", ")}`)
    process.exit(1)
  }
  const iProv = col("provinsi_nama")
  const iKab = col("kab_kota_nama")
  const iKec = col("kecamatan_nama")
  const iPostal = col("village_postal_codes")
  const iDur = col("bs_jne_reg_duration")
  const iPrice = colAny("final_price", "bs_jne_reg_price")

  // Guard: the origin must exist (the FK would also reject, but fail early and
  // with a clearer message).
  const wh = await sql`SELECT 1 FROM warehouses WHERE code = ${originCode!} LIMIT 1`
  if (wh.length === 0) {
    console.error(`❌ No warehouse with code "${originCode}". Create it first (warehouses.code).`)
    process.exit(1)
  }

  const records = rows.slice(1)
    .filter((r) => r.length > 1 && r[iKab]?.trim() && r[iKec]?.trim())
    .map((r) => ({
      origin_code: originCode!,
      provinsi_nama: (r[iProv] ?? "").trim(),
      kab_kota_nama: (r[iKab] ?? "").trim(),
      kecamatan_nama: (r[iKec] ?? "").trim(),
      village_postal_codes: (r[iPostal] ?? "").trim(),
      reg_duration: (r[iDur] ?? "").trim(),
      final_price: parseNum(r[iPrice]),
    }))

  console.log(`Parsed ${records.length} rate rows from ${csvPath} for origin "${originCode}"`)

  // Replace ONLY this origin's rows; other origins' rates are left intact.
  await sql`DELETE FROM jne_rates WHERE origin_code = ${originCode!}`

  const BATCH = 1000
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)
    await sql`INSERT INTO jne_rates ${sql(batch)}`
    console.log(`  inserted ${Math.min(i + BATCH, records.length)} / ${records.length}`)
  }

  const [{ count }] = await sql`SELECT count(*)::int AS count FROM jne_rates WHERE origin_code = ${originCode!}`
  console.log(`✅ Done. jne_rates now has ${count} rows for origin "${originCode}".`)
  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
