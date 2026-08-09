/**
 * One-off sync: pull delivered tracking numbers from the Google Sheet
 * "Invoice_WA" into the DB shipments table for ready-to-ship orders.
 *
 * For every ready-to-ship (event, customer) group on the Packing List
 * (arrived units not yet shipped), build its order id "{event} {instagram_id}"
 * and look it up in Invoice_WA:
 *   - Col A  = "Order ID"
 *   - Col W  = "Resi (Cat. Kirim di COMMENT ya)"  (the tracking number)
 *
 * When the Resi is non-empty AND the group has no shipment row yet, the group is
 * shipped exactly like the Packing List "Ship" action — order units marked
 * shipped, a shipment row created with computed weight/ongkir — and its
 * tracking_number is set to the Resi.
 *
 * Matching is case-insensitive and ignores "@". Groups that already have a
 * shipment row are skipped.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/sync-tracking-from-wa.ts [--dry-run]
 *
 * Env: DATABASE_URL, GOOGLE_SPREADSHEET_ID,
 *      GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 */

import { google } from "googleapis"
import postgres from "postgres"

const dryRun = process.argv.includes("--dry-run")

for (const k of [
  "DATABASE_URL",
  "GOOGLE_SPREADSHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
]) {
  if (!process.env[k]) {
    console.error(`❌ ${k} is not set`)
    process.exit(1)
  }
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: "require", prepare: false })

const ORDER_ID_COL = 0 // Column A
const RESI_COL = 22 // Column W (A=0 … W=22)
const SHEET_RANGE = "Invoice_WA!A2:W"

/** Lowercase, drop "@", collapse whitespace — for order-id matching. */
function normKey(s: string): string {
  return (s ?? "").trim().toLowerCase().replace(/@/g, "").replace(/\s+/g, " ")
}

/**
 * Clean a Resi cell: cells may hold several tracking numbers (split on "/" or
 * newlines) and some have a stray leading apostrophe (a Sheets text artifact).
 * Trim each part, drop the apostrophe, and re-join with " / ".
 */
function cleanResi(raw: string): string {
  return (raw ?? "")
    .split(/[\n/]+/)
    .map((p) => p.trim().replace(/^'+/, ""))
    .filter(Boolean)
    .join(" / ")
}

type OrderRow = {
  id: number
  event: string
  customer: string
  product_name: string
  gram: number
  unit_arrive: number
  unit_ship: number
  ongkos_kirim: number
}

type Group = {
  event: string
  customer: string
  ongkirPerKg: number
  orders: { id: number; productName: string; gram: number; toShip: number }[]
}

async function main() {
  // ── 1. Read Invoice_WA → map normalized order id → Resi ──────────────────
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  const sheets = google.sheets({ version: "v4", auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID!,
    range: SHEET_RANGE,
  })
  const sheetRows = (res.data.values ?? []) as string[][]

  const resiByOrderId = new Map<string, string>()
  for (const r of sheetRows) {
    const orderId = String(r[ORDER_ID_COL] ?? "").trim()
    const resi = cleanResi(String(r[RESI_COL] ?? ""))
    if (orderId && resi) resiByOrderId.set(normKey(orderId), resi)
  }
  console.log(`Invoice_WA: ${sheetRows.length} rows read, ${resiByOrderId.size} with a Resi.`)

  // ── 2. Ready-to-ship order lines (arrived but not fully shipped) ──────────
  const orderRows = await sql<OrderRow[]>`
    SELECT o.id, o.event, o.customer, p.name AS product_name,
           COALESCE(p.gram, 0)        AS gram,
           COALESCE(o.unit_arrive, 0) AS unit_arrive,
           COALESCE(o.unit_ship, 0)   AS unit_ship,
           COALESCE(ck.ongkos_kirim, 0) AS ongkos_kirim
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN (
      SELECT lower(replace(instagram_id, '@', '')) AS k,
             MAX(COALESCE(ongkos_kirim, 0)) AS ongkos_kirim
      FROM customers GROUP BY 1
    ) ck ON ck.k = lower(replace(o.customer, '@', ''))
    WHERE COALESCE(o.unit_arrive, 0) > COALESCE(o.unit_ship, 0)
    ORDER BY o.event, o.customer, o.id
  `

  // Group by (event, normalized customer)
  const groups = new Map<string, Group>()
  for (const r of orderRows) {
    const toShip = Math.max(0, r.unit_arrive - r.unit_ship)
    if (toShip <= 0) continue
    const key = `${r.event}|${normKey(r.customer)}`
    if (!groups.has(key)) {
      groups.set(key, { event: r.event, customer: r.customer, ongkirPerKg: r.ongkos_kirim, orders: [] })
    }
    groups.get(key)!.orders.push({ id: r.id, productName: r.product_name, gram: r.gram, toShip })
  }
  console.log(`Ready-to-ship groups: ${groups.size}.\n`)

  // ── 3. For each ready group with a Resi and no existing shipment → ship ───
  let created = 0
  let skippedExisting = 0
  let noResi = 0

  for (const g of groups.values()) {
    const tracking = resiByOrderId.get(normKey(`${g.event} ${g.customer}`))
    if (!tracking) { noResi++; continue }

    const [existing] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM shipments
      WHERE event = ${g.event} AND lower(replace(customer, '@', '')) = ${normKey(g.customer)}
    `
    if (existing.n > 0) { skippedExisting++; continue }

    const totalGram = g.orders.reduce((s, o) => s + o.gram * o.toShip, 0)
    // Bill ongkir per kg, rounded up to the next whole kg (matches invoices).
    const weightKg = Math.ceil(totalGram / 1000)
    const ongkirTotal = g.ongkirPerKg * weightKg
    const invoicing = g.orders.map((o) => `${o.productName} x ${o.toShip}`).join("\n")

    console.log(`${dryRun ? "[would ship] " : "[shipping]   "}${g.event} ${g.customer} → resi ${tracking} (${g.orders.length} items, ${weightKg.toFixed(2)}kg)`)

    if (!dryRun) {
      await sql.begin(async (tx) => {
        const [maxRow] = await tx<{ max_id: number }[]>`
          SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id FROM shipments
        `
        const shippingId = String((maxRow.max_id ?? 0) + 1).padStart(4, "0")
        await tx`
          INSERT INTO shipments
            (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment, tracking_number)
          VALUES
            (${g.event}, ${g.customer}, ${shippingId}, ${invoicing}, ${weightKg}, ${g.ongkirPerKg}, ${ongkirTotal}, true, ${tracking})
        `
        for (const o of g.orders) {
          await tx`UPDATE orders SET unit_ship = COALESCE(unit_ship, 0) + ${o.toShip}, updated_at = NOW() WHERE id = ${o.id}`
        }
      })
    }
    created++
  }

  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}Done. ` +
    `${dryRun ? "Would create" : "Created"}: ${created} | ` +
    `Skipped (shipment already exists): ${skippedExisting} | ` +
    `Ready groups with no Resi in sheet: ${noResi}`,
  )

  await sql.end()
}

main().catch(async (err) => {
  console.error("Sync failed:", err)
  await sql.end()
  process.exit(1)
})
