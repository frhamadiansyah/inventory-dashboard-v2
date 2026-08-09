/**
 * One-off backfill: fill customers.kota/kecamatan/kode_pos AND per-warehouse
 * ongkir (customer_warehouse_ongkir) from the registration-response export.
 *
 * Context: migration 032 made ongkir per-warehouse, and migration 034 added the
 * destination columns. Existing customers have no stored destination, so a newly
 * added warehouse (e.g. DEPOK) has no rate for them. This script recovers each
 * customer's destination by matching their Instagram handle in the registration
 * export, resolves it to a canonical jne_rates destination, stores it, and fills
 * the ongkir for every warehouse that doesn't already have a row.
 *
 * Matching (per customer, trying every submission, first hit wins):
 *   1. exact   — (kab_kota_nama, kecamatan_nama) equals a jne_rates pair
 *   2. postal  — kode_pos appears in jne_rates.village_postal_codes (only when
 *                that postal maps to a single destination)
 *   3. fuzzy   — prefix-stripped kota ("KOTA BEKASI" -> "BEKASI") + kecamatan
 *                matches a single jne_rates destination
 * The resolved CANONICAL jne_rates names are stored, so future warehouses are a
 * clean re-lookup. Ongkir rows are written with ON CONFLICT DO NOTHING, so an
 * existing warehouse's rates (CIMAHI) are never overwritten.
 *
 * SAFE BY DEFAULT: dry-run unless --commit is passed.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/backfill-customer-destination.ts \
 *     [scripts/data/Yubisayu-registration-response.csv] [--commit]
 */

import { readFileSync } from "node:fs"
import postgres from "postgres"

const argv = process.argv.slice(2)
const commit = argv.includes("--commit")
const csvPath = argv.find((a) => !a.startsWith("--")) ?? "scripts/data/Yubisayu-registration-response.csv"

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: "require", prepare: false })

const norm = (s?: string) => (s || "").toUpperCase().replace(/\s+/g, " ").trim()
const normHandle = (s?: string) => (s || "").toLowerCase().replace(/@/g, "").trim()
const stripKota = (s?: string) =>
  norm(s)
    .replace(/^KOTA ADM(\.|INISTRASI)?\s+/, "")
    .replace(/^KOTA\s+/, "")
    .replace(/^KAB(\.|UPATEN)?\s+/, "")
    .trim()

// Minimal RFC-4180 parser (quoted fields, embedded commas/newlines, "" escapes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ",") { row.push(field); field = "" }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = "" }
    else if (c !== "\r") field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

type Canonical = { kota: string; kec: string }
type Submission = { kota: string; kec: string; pos: string }

async function main() {
  // ── 1. Registration export -> per-handle submissions ───────────────────────
  const rows = parseCsv(readFileSync(csvPath, "utf8"))
  if (rows.length < 2) { console.error("❌ CSV has no data rows"); process.exit(1) }
  const header = rows[0].map((h) => h.trim())
  const col = (name: string) => {
    const i = header.indexOf(name)
    if (i === -1) { console.error(`❌ CSV missing column "${name}". Headers: ${header.join(", ")}`); process.exit(1) }
    return i
  }
  const iIg = col("User Instagram"), iKab = col("Kabupaten/Kota"), iKec = col("Kecamatan"), iPos = col("Kode Pos")
  const subs = new Map<string, Submission[]>()
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const h = normHandle(r[iIg])
    if (!h) continue
    if (!subs.has(h)) subs.set(h, [])
    subs.get(h)!.push({ kota: (r[iKab] || "").trim(), kec: (r[iKec] || "").trim(), pos: (r[iPos] || "").trim() })
  }
  console.log(`Parsed ${rows.length - 1} rows, ${subs.size} distinct handles from ${csvPath}`)

  // ── 2. jne_rates -> resolvers (exact / postal / fuzzy) + per-origin rate map ─
  const rates = await sql<{ origin_code: string; kab_kota_nama: string; kecamatan_nama: string; village_postal_codes: string; final_price: number }[]>`
    SELECT origin_code, kab_kota_nama, kecamatan_nama, village_postal_codes, final_price FROM jne_rates`
  const exactMap = new Map<string, Canonical>()           // norm(kab)|norm(kec) -> canonical
  const fuzzyCount = new Map<string, Set<string>>()        // strip(kab)|norm(kec) -> set of canonical keys
  const fuzzyMap = new Map<string, Canonical>()
  const postalCount = new Map<string, Set<string>>()       // postal -> set of canonical keys
  const postalMap = new Map<string, Canonical>()
  const rateMap = new Map<string, number>()                // origin|norm(kab)|norm(kec) -> price (>0)
  for (const r of rates) {
    const canon: Canonical = { kota: r.kab_kota_nama, kec: r.kecamatan_nama }
    const ckey = norm(r.kab_kota_nama) + "|" + norm(r.kecamatan_nama)
    exactMap.set(ckey, canon)
    if (r.final_price > 0) rateMap.set(r.origin_code + "|" + ckey, r.final_price)
    const fk = stripKota(r.kab_kota_nama) + "|" + norm(r.kecamatan_nama)
    if (!fuzzyCount.has(fk)) fuzzyCount.set(fk, new Set())
    fuzzyCount.get(fk)!.add(ckey); fuzzyMap.set(fk, canon)
    for (const p of (r.village_postal_codes || "").split(";")) {
      const pp = p.trim()
      if (!pp) continue
      if (!postalCount.has(pp)) postalCount.set(pp, new Set())
      postalCount.get(pp)!.add(ckey); postalMap.set(pp, canon)
    }
  }

  function resolve(sub: Submission): Canonical | null {
    const ck = norm(sub.kota) + "|" + norm(sub.kec)
    if (exactMap.has(ck)) return exactMap.get(ck)!
    if (sub.pos && postalCount.get(sub.pos)?.size === 1) return postalMap.get(sub.pos)!
    const fk = stripKota(sub.kota) + "|" + norm(sub.kec)
    if (fuzzyCount.get(fk)?.size === 1) return fuzzyMap.get(fk)!
    return null
  }

  // ── 3. customers + warehouses + existing ongkir rows ───────────────────────
  const customers = await sql<{ id: number; instagram_id: string }[]>`SELECT id, instagram_id FROM customers`
  const warehouses = await sql<{ id: number; code: string }[]>`SELECT id, code FROM warehouses ORDER BY id`
  const existing = await sql<{ customer_id: number; warehouse_id: number }[]>`
    SELECT customer_id, warehouse_id FROM customer_warehouse_ongkir`
  const hasRow = new Set(existing.map((e) => `${e.customer_id}|${e.warehouse_id}`))

  // ── 4. plan writes ─────────────────────────────────────────────────────────
  const destUpdates: { id: number; kota: string; kec: string; pos: string }[] = []
  const ongkirInserts: { customer_id: number; warehouse_id: number; ongkos_kirim: number }[] = []
  let noCsv = 0, resolved = 0, unresolvedStored = 0
  const perWh = new Map<number, number>()
  for (const c of customers) {
    const arr = subs.get(normHandle(c.instagram_id))
    if (!arr || arr.length === 0) { noCsv++; continue }
    // Find a submission that resolves; remember its postal for storage.
    let canon: Canonical | null = null
    let pos = ""
    for (const s of arr) { const r = resolve(s); if (r) { canon = r; pos = s.pos; break } }
    if (canon) {
      resolved++
      destUpdates.push({ id: c.id, kota: canon.kota, kec: canon.kec, pos })
      for (const w of warehouses) {
        if (hasRow.has(`${c.id}|${w.id}`)) continue   // never overwrite existing (protects CIMAHI)
        const price = rateMap.get(`${w.code}|${norm(canon.kota)}|${norm(canon.kec)}`) ?? 0
        if (price > 0) {
          ongkirInserts.push({ customer_id: c.id, warehouse_id: w.id, ongkos_kirim: price })
          perWh.set(w.id, (perWh.get(w.id) ?? 0) + 1)
        }
      }
    } else {
      // Store the latest raw destination so an admin has something to correct.
      const last = arr[arr.length - 1]
      destUpdates.push({ id: c.id, kota: last.kota, kec: last.kec, pos: last.pos })
      unresolvedStored++
    }
  }

  console.log("\n── Plan ──────────────────────────────────────────")
  console.log(`customers:                 ${customers.length}`)
  console.log(`  no handle in export:     ${noCsv}`)
  console.log(`  destination resolved:    ${resolved}`)
  console.log(`  stored but unresolved:   ${unresolvedStored}`)
  console.log(`destination column writes: ${destUpdates.length}`)
  console.log(`ongkir rows to insert:     ${ongkirInserts.length}`)
  for (const w of warehouses) console.log(`  - ${w.code} (id ${w.id}): ${perWh.get(w.id) ?? 0}`)

  if (!commit) {
    console.log("\nDRY RUN — no writes. Re-run with --commit to apply.")
    await sql.end(); return
  }

  // ── 5. apply ───────────────────────────────────────────────────────────────
  console.log("\nApplying…")
  const B = 500
  for (let i = 0; i < destUpdates.length; i += B) {
    const batch = destUpdates.slice(i, i + B)
    await sql.begin((tx) => batch.map((d) =>
      tx`UPDATE customers SET kota = ${d.kota}, kecamatan = ${d.kec}, kode_pos = ${d.pos}, updated_at = NOW() WHERE id = ${d.id}`))
    console.log(`  destinations ${Math.min(i + B, destUpdates.length)} / ${destUpdates.length}`)
  }
  for (let i = 0; i < ongkirInserts.length; i += B) {
    const batch = ongkirInserts.slice(i, i + B)
    await sql`
      INSERT INTO customer_warehouse_ongkir ${sql(batch, "customer_id", "warehouse_id", "ongkos_kirim")}
      ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
    console.log(`  ongkir ${Math.min(i + B, ongkirInserts.length)} / ${ongkirInserts.length}`)
  }
  console.log("✅ Done.")
  await sql.end()
}

main().catch(async (err) => { console.error(err); await sql.end(); process.exit(1) })
