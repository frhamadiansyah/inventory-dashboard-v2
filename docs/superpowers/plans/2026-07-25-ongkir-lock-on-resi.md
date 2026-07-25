# Lock ongkir on resi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Once a shipment has a resi (`tracking_number`), the invoice uses that shipment's ship-time `ongkir` (frozen); while no resi, ongkir stays live from `customer_warehouse_ongkir`.

**Architecture:** Read-side only. Change the ongkir expression in both invoice recap queries (`getInvoiceForCustomer` and `getPublicInvoiceForCustomer`) to prefer a resi'd shipment's stored ongkir, else the live rate. No migration, no write-path change.

**Tech Stack:** postgres.js raw SQL, TypeScript.

## Global Constraints

- Tests run against the LOCAL DB only; run with `node --env-file=.env.development.local --import=tsx scratchpad/<file>`. Guard the host (refuse non-127.0.0.1). **Exact-match cleanup only** (`= value` / `= ANY([...])`) — NEVER `LIKE`, and always delete any `audit.audit_log` rows the test creates by exact customer handle.
- No migration. `shipments.ongkir` (per-kg rate) + `shipments.tracking_number` already exist; `invoice_reader` has `GRANT SELECT ON shipments` (whole table), so the public query may read `s.ongkir`.
- Lock value = the ship-time snapshot in `shipments.ongkir` (decided in the spec). A resi'd shipment with `ongkir = 0` is a valid lock (0, not NULL).

---

### Task 1: Prefer a resi'd shipment's ongkir in both recaps

**Files:**
- Modify: `lib/db/invoice.ts` (two identical `ongkir` expressions: ~line 166 in `getInvoiceForCustomer`, ~line 329 in `getPublicInvoiceForCustomer`)
- Test: `scratchpad/test-ongkir-lock.ts`

**Interfaces:**
- Consumes: `shipments.ongkir`, `shipments.tracking_number`; the `${searchId}` param and `o.event` / `o` alias already bound in both queries.
- Produces: no signature change — `getInvoiceForCustomer(...).events[].ongkirPerKg` and the public equivalent now reflect the lock.

- [ ] **Step 1: Write the failing test**

`scratchpad/test-ongkir-lock.ts` (seeds a full scenario; asserts live → resi-fill locks → cwo change stays locked → clear resi returns live, on the internal recap; plus the locked case on the public recap):

```ts
import sql from "@/lib/db-pool"
import { getInvoiceForCustomer, getPublicInvoiceForCustomer } from "@/lib/db"

const CUST = "zz_ongkir_lock_test"
let event = "", warehouseId = 0, productId = 0, customerId = 0, orderId = 0, shipmentId = 0
function assert(c: boolean, m: string) { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) process.exitCode = 1 }
const RATE_A = 15000, RATE_B = 22000, RATE_C = 30000

async function ongkir() {
  const inv = await getInvoiceForCustomer(CUST)
  return inv.events.find((e) => e.event === event)?.ongkirPerKg ?? -1
}
async function cleanup() {
  if (shipmentId) await sql`DELETE FROM shipments WHERE id = ${shipmentId}`
  if (orderId) await sql`DELETE FROM orders WHERE id = ${orderId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM audit.audit_log WHERE (new_row->>'customer') = ${CUST} OR (old_row->>'customer') = ${CUST}`
  await sql`DELETE FROM customers WHERE instagram_id = ${CUST}`
}

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)\//)?.[1] ?? ""
  if (!/(localhost|127\.0\.0\.1)/.test(host)) throw new Error(`non-local: ${host}`)

  const [ev] = await sql`SELECT name, warehouse_id FROM events WHERE warehouse_id IS NOT NULL LIMIT 1`
  event = ev.name as string; warehouseId = ev.warehouse_id as number
  const [p] = await sql`SELECT id FROM products WHERE COALESCE(gram,0) > 0 LIMIT 1`
  productId = p.id as number
  const [c] = await sql`INSERT INTO customers (instagram_id) VALUES (${CUST}) RETURNING id`
  customerId = c.id as number
  await sql`INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim) VALUES (${customerId}, ${warehouseId}, ${RATE_A})`
  const [o] = await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit) VALUES (${event}, ${CUST}, ${productId}, 1000, 2) RETURNING id`
  orderId = o.id as number

  assert((await ongkir()) === RATE_A, "no resi'd shipment → live cwo rate A")

  // Shipment created at a DIFFERENT ship-time ongkir (B), resi still empty.
  const [s] = await sql`
    INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment, tracking_number)
    VALUES (${event}, ${CUST}, ${'SHIP-' + CUST}, '', 1, ${RATE_B}, ${RATE_B}, true, '') RETURNING id`
  shipmentId = s.id as number
  assert((await ongkir()) === RATE_A, "shipment exists but resi empty → still live cwo rate A")

  await sql`UPDATE shipments SET tracking_number = 'RESI123' WHERE id = ${shipmentId}`
  assert((await ongkir()) === RATE_B, "resi filled → locked to shipment ongkir B")

  await sql`UPDATE customer_warehouse_ongkir SET ongkos_kirim = ${RATE_C} WHERE customer_id = ${customerId}`
  assert((await ongkir()) === RATE_B, "cwo changed to C but resi filled → stays locked at B")

  // Public recap reflects the lock too.
  const pub = await getPublicInvoiceForCustomer(CUST)
  const pubEvt = pub.events.find((e) => e.event === event)
  assert(!!pubEvt && (pubEvt.ongkirPerKg === RATE_B), "public recap locked to B")

  await sql`UPDATE shipments SET tracking_number = '' WHERE id = ${shipmentId}`
  assert((await ongkir()) === RATE_C, "resi cleared → live cwo rate C again")
}

main().catch((e) => { console.error("ERR:", e.message); process.exitCode = 1 })
  .finally(async () => { await cleanup(); await sql.end() })
```

Note for the implementer: confirm the public event's ongkir field name (`ongkirPerKg`); if the `PublicInvoiceEvent` exposes it differently (e.g. `estimasiOngkir` / a rate), adjust that one assertion to read the equivalent rate. Also confirm the `shipments` INSERT columns match the table (add any NOT NULL column the DB rejects, e.g. `temp_address` — use `''`).

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-ongkir-lock.ts`
Expected: the resi-fill / stays-locked assertions FAIL (ongkir still live = C/A, not B), because the query hasn't changed yet.

- [ ] **Step 3: Implement — change the ongkir expression in both queries**

In `lib/db/invoice.ts`, replace **both** occurrences of:

```sql
             COALESCE(cwo.ongkos_kirim, 0) AS ongkir
```

with:

```sql
             COALESCE(
               (SELECT s.ongkir
                  FROM shipments s
                 WHERE s.event = o.event
                   AND lower(replace(s.customer, '@', '')) = ${searchId}
                   AND s.tracking_number <> ''
                 ORDER BY s.id DESC
                 LIMIT 1),
               cwo.ongkos_kirim, 0
             ) AS ongkir
```

Both queries already bind `${searchId}` and select from `orders o`, so `o.event` and `${searchId}` resolve in each. (The two SQL template literals are separate, so edit each occurrence — the text is identical.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-ongkir-lock.ts`
Expected: all `PASS`.
Run: `npx tsc --noEmit` → clean (ignore the unrelated untracked `scripts/import-japan-products.ts` error if present).

- [ ] **Step 5: Commit** (production file only, not the scratchpad test)

```bash
git add lib/db/invoice.ts
git commit -m "feat(invoice): lock ongkir to a resi'd shipment's rate, else live"
```

---

## Self-Review

- Spec coverage: both recaps (internal + public) get the same COALESCE-with-shipment-subquery; lock = ship-time `shipments.ongkir`; no migration/write-path change. ✓
- Types: no signature change; only the SQL expression differs. The subquery returns `int` (matches `cwo.ongkos_kirim`). ✓
- No placeholders; the edit's exact old/new text and a complete test are given. ✓
