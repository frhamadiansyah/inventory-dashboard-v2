# Bulk "Not Received" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bulk **Not Received** action to the Receiving List selection bar — a 4-tab modal (Wrong · Broken · Missing · Cancelled) that records a delivery problem against every selected item, with a per-item editable quantity and priority-allocated partial refunds.

**Architecture:** Frontend `NotReceivedPanel` (mirrors `ConfirmReceivePanel`) fires one `POST /api/sheets/arrival-list` per selected item. A new server action `not_received` calls `recordNotReceived`, which allocates `qty` units across the item's waiting orders by existing priority, partial-cancels them refund-only, and logs inventory per mode. The per-item `ArriveModal` flow and the whole-order `record*` functions are untouched.

**Tech Stack:** Next.js 16 App Router, React, postgres.js (raw SQL, `prepare:false`), TypeScript, jsPDF (unrelated here). No test framework — runtime tsx scripts against the **local** DB.

## Global Constraints

- **Local DB only for tests.** Run tests with `node --env-file=.env.development.local --import=tsx scratchpad/<file>`. Each test must guard the host: refuse to run unless `DATABASE_URL` points at `127.0.0.1`/`localhost`. Seed → assert → clean up every row/customer created. **Never** run `supabase db reset`.
- **Semantics = Option Y:** `qty` = units affected; allocate exactly `qty` across the item's orders by `compareOrderPriority` (paid → partial → unpaid, then id), partial-order cancel allowed; leftover (`pending − qty`) stays pending.
- **Inventory reasons:** missing/broken → unassignable; customer_cancelled/wrong_product → assignable. `excess_purchase.reason` is free TEXT — no migration, no CHECK constraint (verified `000_init.sql:102`).
- **Refunds** are the existing auto-materialization: reducing `unit`/`unit_buy` drops the invoice → overpaid customers' refunds appear automatically. Never create refund rows directly.
- **Owner-gated:** the route already calls `requireOwner`; keep it.
- **amber** UI matches `ArriveModal`'s yellow problem-mode styling.
- Partial-order cancel must never reduce a line below already-committed units (`unit_buy ≥ unit_ship`, `unit_dispatch ≥ unit_arrive`).

---

## File Structure

- `lib/db/types.ts` — add `"missing"` to `ExcessReason` (Task 1).
- `app/api/sheets/excess-purchase/route.ts` — skip `missing` in apply-to-orders (Task 1).
- `lib/db/orders.ts` — add `reduceOrderRefundOnly` (Task 2).
- `lib/db/fulfillment.ts` — add `recordNotReceived` (Task 3).
- `app/api/sheets/arrival-list/route.ts` — add `not_received` action (Task 4).
- `components/SelectionActionBar.tsx` — add `amber` color (Task 5).
- `app/dashboard/arrival-list/ArrivalListClient.tsx` — `NotReceivedPanel` + selection-bar action (Task 5).

---

### Task 1: `missing` inventory reason (unassignable)

**Files:**
- Modify: `lib/db/types.ts:62`
- Modify: `app/api/sheets/excess-purchase/route.ts:32`
- Test: `scratchpad/test-missing-reason.ts`

**Interfaces:**
- Produces: `ExcessReason` now includes `"missing"`; apply-to-orders excludes both `broken` and `missing`.

- [ ] **Step 1: Extend the union**

`lib/db/types.ts:62` — add `"missing"`:

```ts
export type ExcessReason = "overbuy" | "overship" | "wrong_product" | "broken" | "missing" | "customer_cancelled" | "manual"
```

- [ ] **Step 2: Exclude `missing` from apply-to-orders**

`app/api/sheets/excess-purchase/route.ts:32` — change:

```ts
const excessRows = (await getExcessPurchaseRows()).filter((r) => r.reason !== "broken")
```
to:
```ts
const excessRows = (await getExcessPurchaseRows()).filter((r) => r.reason !== "broken" && r.reason !== "missing")
```

- [ ] **Step 3: Write the test**

`scratchpad/test-missing-reason.ts`:

```ts
import sql from "@/lib/db-pool"
import { appendExcessPurchase, getExcessPurchaseRows } from "@/lib/db"

const EV = "__test_missing__"
function assert(c: boolean, m: string) { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) process.exitCode = 1 }

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)\//)?.[1] ?? ""
  if (!/(localhost|127\.0\.0\.1)/.test(host)) throw new Error(`Refusing non-local host: ${host}`)
  await appendExcessPurchase([{ event: EV, items: "Zzz Test Widget", unitBuy: 3, receipt: "", reason: "missing" }])
  const rows = await getExcessPurchaseRows()
  const mine = rows.filter((r) => r.event === EV)
  assert(mine.length === 1 && mine[0].reason === "missing", "missing row is stored with reason=missing")
}

main().catch((e) => { console.error("ERR:", e.message); process.exitCode = 1 })
  .finally(async () => { await sql`DELETE FROM excess_purchase WHERE event = ${EV}`; await sql.end() })
```

- [ ] **Step 4: Run test + typecheck**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-missing-reason.ts`
Expected: `PASS: missing row is stored with reason=missing`
Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 5: Commit** (production files only, not the scratchpad test)

```bash
git add lib/db/types.ts app/api/sheets/excess-purchase/route.ts
git commit -m "feat(inventory): add unassignable 'missing' excess reason"
```

---

### Task 2: Refund-only partial-cancel reducer

**Files:**
- Modify: `lib/db/orders.ts` (add exported function near `cancelOrderUnits`, ~line 948)
- Test: `scratchpad/test-reduce-refund-only.ts`

**Interfaces:**
- Consumes: `DBExecutor` (already imported in `orders.ts`), `sql`.
- Produces: `reduceOrderRefundOnly(data: { orderId: number; qty: number }, db?: DBExecutor): Promise<void>` — used by `recordNotReceived` (Task 3).

**Note:** This is a NEW standalone primitive. Do **not** refactor `cancelOrderUnits` to use it — `cancelOrderUnits` clamps `unit_dispatch` with `LEAST(unit_dispatch, remainingUnitBuy)` (invoice-cancel semantics), whereas not-received subtracts `qty` from the dispatched pool. They are intentionally different; leave `cancelOrderUnits` unchanged.

- [ ] **Step 1: Write the failing test**

`scratchpad/test-reduce-refund-only.ts`:

```ts
import sql from "@/lib/db-pool"
import { reduceOrderRefundOnly } from "@/lib/db"

const CUST = "__test_reduce__"
let orderId = 0
function assert(c: boolean, m: string) { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) process.exitCode = 1 }

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)\//)?.[1] ?? ""
  if (!/(localhost|127\.0\.0\.1)/.test(host)) throw new Error(`Refusing non-local host: ${host}`)
  const [ev] = await sql`SELECT name FROM events LIMIT 1`
  const [p] = await sql`SELECT id FROM products LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${CUST}) ON CONFLICT DO NOTHING`
  const [o] = await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${ev.name}, ${CUST}, ${p.id}, 0, 5, 5, 5, 0) RETURNING id`
  orderId = o.id as number

  // Baseline excess rows for this event (reducer must not add any).
  const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM excess_purchase WHERE event = ${ev.name}`

  // Reduce 2 of 5 refund-only.
  await reduceOrderRefundOnly({ orderId, qty: 2 })
  const [row] = await sql`SELECT unit, unit_buy, unit_dispatch, unit_arrive FROM orders WHERE id = ${orderId}`
  assert(row.unit === 3, "unit 5 -> 3")
  assert(row.unit_buy === 3, "unit_buy 5 -> 3")
  assert(row.unit_dispatch === 3, "unit_dispatch 5 -> 3")
  assert(row.unit_arrive === 0, "unit_arrive unchanged (0)")

  // Reducer logs no inventory itself.
  const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM excess_purchase WHERE event = ${ev.name}`
  assert(after === before, "reduceOrderRefundOnly logs no excess row")
}

main().catch((e) => { console.error("ERR:", e.message); process.exitCode = 1 })
  .finally(async () => {
    if (orderId) await sql`DELETE FROM orders WHERE id = ${orderId}`
    await sql`DELETE FROM customers WHERE instagram_id = ${CUST}`
    await sql.end()
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-reduce-refund-only.ts`
Expected: fails to import `reduceOrderRefundOnly` (not defined).

- [ ] **Step 3: Implement**

In `lib/db/orders.ts`, after `cancelOrderUnits` (before `appendExcessPurchase`, ~line 949), add:

```ts
/**
 * Reduce an order line by `qty` units without logging anything to Inventory —
 * the refund-only primitive behind not-received partial cancellation. Drops
 * unit, unit_buy and unit_dispatch by qty (the cancelled units come off the
 * dispatched-but-unarrived pool), each floored so nothing falls below what's
 * already committed downstream (unit_buy ≥ unit_ship, unit_dispatch ≥
 * unit_arrive). Reducing `unit` drops the invoice, so an overpaid customer's
 * refund auto-materializes. Callers that must also return stock log Inventory
 * themselves. Unlike cancelOrderUnits (invoice-cancel: clamps unit_dispatch to
 * the shrunk unit_buy), this subtracts qty from unit_dispatch directly.
 */
export async function reduceOrderRefundOnly(
  data: { orderId: number; qty: number },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE orders
    SET unit = unit - ${data.qty},
        unit_buy = GREATEST(COALESCE(unit_ship, 0), COALESCE(unit_buy, 0) - ${data.qty}),
        unit_dispatch = GREATEST(COALESCE(unit_arrive, 0), COALESCE(unit_dispatch, 0) - ${data.qty}),
        updated_at = NOW()
    WHERE id = ${data.orderId}
  `
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-reduce-refund-only.ts`
Expected: all `PASS`.
Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 5: Commit**

```bash
git add lib/db/orders.ts
git commit -m "feat(orders): add reduceOrderRefundOnly (refund-only partial cancel)"
```

---

### Task 3: `recordNotReceived` (allocator + per-mode inventory)

**Files:**
- Modify: `lib/db/fulfillment.ts` (imports at top; new function after `markProductArrived`, ~line 752)
- Test: `scratchpad/test-not-received.ts`

**Interfaces:**
- Consumes: `reduceOrderRefundOnly`, `appendExcessPurchase` (from `./orders`); `allocateFifo` (`../fifo-fill`, already imported); `fetchPaidStatusMap`, `compareOrderPriority` (`./shopping-list`, already imported).
- Produces: `recordNotReceived(data, actor?): Promise<{ cancelledUnits: number; excessUnits: number }>` — called by the route (Task 4).

- [ ] **Step 1: Add imports**

At the top of `lib/db/fulfillment.ts`, add (orders.ts does not import fulfillment.ts, so no cycle):

```ts
import { appendExcessPurchase, reduceOrderRefundOnly } from "./orders"
```

- [ ] **Step 2: Write the failing test**

`scratchpad/test-not-received.ts` (covers all 4 modes + partial allocation + leftover-stays-pending):

```ts
import sql from "@/lib/db-pool"
import { recordNotReceived, getArrivalList } from "@/lib/db"

const CUST = "__test_nr__"
const created: number[] = []
let event = ""
let productId = 0
let productName = ""
let receivedSku = ""
function assert(c: boolean, m: string) { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) process.exitCode = 1 }

async function seedOrder(unit: number) {
  const [o] = await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${event}, ${CUST}, ${productId}, 0, ${unit}, ${unit}, ${unit}, 0) RETURNING id`
  created.push(o.id as number); return o.id as number
}
async function excessCount(reason: string, items: string) {
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM excess_purchase WHERE event = ${event} AND items = ${items} AND reason = ${reason}`
  return n as number
}

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)\//)?.[1] ?? ""
  if (!/(localhost|127\.0\.0\.1)/.test(host)) throw new Error(`Refusing non-local host: ${host}`)
  const [ev] = await sql`SELECT name FROM events LIMIT 1`; event = ev.name as string
  const prods = await sql`SELECT id, name FROM products WHERE id NOT IN (SELECT DISTINCT product_id FROM orders) LIMIT 2`
  productId = prods[0].id as number; productName = prods[0].name as string; receivedSku = prods[1].name as string
  await sql`INSERT INTO customers (instagram_id) VALUES (${CUST}) ON CONFLICT DO NOTHING`

  // BROKEN, partial: two orders (2 + 1 = 3 pending), qty 1 → cancel 1, leave 2.
  const a = await seedOrder(2), b = await seedOrder(1)
  await recordNotReceived({ event, productId, productName, qty: 1, mode: "broken" }, "tester@test")
  const rowsBrokenA = await sql`SELECT unit FROM orders WHERE id = ${a}`
  const rowsBrokenB = await sql`SELECT unit FROM orders WHERE id = ${b}`
  const stillPending = (rowsBrokenA[0].unit as number) + (rowsBrokenB[0].unit as number)
  assert(stillPending === 2, "broken qty1 of 3 → 2 units remain across orders")
  assert(await excessCount("broken", productName) === 1, "broken: 1 excess row reason=broken")
  const arr = await getArrivalList(event)
  assert(arr.some((i) => i.productId === productId), "leftover units keep the item on the arrival list")

  // MISSING: remaining 2 pending, qty 2 → cancel all, log missing.
  await recordNotReceived({ event, productId, productName, qty: 2, mode: "missing" }, "tester@test")
  assert(await excessCount("missing", productName) === 1, "missing: 1 excess row reason=missing")
  const arr2 = await getArrivalList(event)
  assert(!arr2.some((i) => i.productId === productId), "fully cancelled → item off the arrival list")

  // CANCELLED: fresh order, qty 3 → customer_cancelled stock of in-hand units.
  const c = await seedOrder(3)
  await recordNotReceived({ event, productId, productName, qty: 3, mode: "cancelled" }, "tester@test")
  assert(await excessCount("customer_cancelled", productName) === 1, "cancelled: 1 excess row reason=customer_cancelled")

  // WRONG: fresh order, qty 2, received a different SKU.
  const d = await seedOrder(2)
  await recordNotReceived({ event, productId, productName, qty: 2, mode: "wrong", receivedItem: receivedSku }, "tester@test")
  assert(await excessCount("wrong_product", receivedSku) === 1, "wrong: 1 excess row of received SKU reason=wrong_product")

  // Validation: qty over pending throws.
  const e = await seedOrder(1)
  let threw = false
  try { await recordNotReceived({ event, productId, productName, qty: 5, mode: "broken" }, "tester@test") } catch { threw = true }
  assert(threw, "qty over pending is rejected")

  // Validation: wrong needs a differing SKU.
  let threw2 = false
  try { await recordNotReceived({ event, productId, productName, qty: 1, mode: "wrong", receivedItem: productName }, "tester@test") } catch { threw2 = true }
  assert(threw2, "wrong with same SKU is rejected")
}

main().catch((e) => { console.error("ERR:", e.message); process.exitCode = 1 })
  .finally(async () => {
    if (created.length) await sql`DELETE FROM orders WHERE id = ANY(${created})`
    await sql`DELETE FROM excess_purchase WHERE event = ${event} AND (items = ${productName} OR items = ${receivedSku})`
    await sql`DELETE FROM customers WHERE instagram_id = ${CUST}`
    await sql.end()
  })
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-not-received.ts`
Expected: fails importing `recordNotReceived`.

- [ ] **Step 4: Implement**

In `lib/db/fulfillment.ts`, after `markProductArrived` (~line 752), add:

```ts
export interface NotReceivedResult {
  cancelledUnits: number
  excessUnits: number
}

/**
 * Bulk "Not Received": record a delivery problem against `qty` units of one
 * event+product. Allocates those units across the waiting orders by priority
 * (paid → partial → unpaid, then id) with partial-order cancellation; leftover
 * (pending − qty) units stay pending. Refunds auto-materialize as invoices drop.
 * Inventory logging depends on mode:
 *   - broken / missing → log qty units flagged that reason (unassignable)
 *   - cancelled        → log the reclaimed in-hand units as customer_cancelled (assignable)
 *   - wrong            → log qty units of the received SKU as wrong_product (assignable)
 * Manages its own transaction + actor, mirroring markProductArrived.
 */
export async function recordNotReceived(
  data: {
    event: string
    productId: number
    productName: string
    qty: number
    mode: "wrong" | "broken" | "missing" | "cancelled"
    receivedItem?: string
  },
  actor?: string | null,
): Promise<NotReceivedResult> {
  if (!(data.qty >= 1)) throw new Error("qty must be at least 1")
  if (data.mode === "wrong") {
    if (!data.receivedItem?.trim()) throw new Error("receivedItem is required for a wrong delivery")
    if (data.receivedItem === data.productName) throw new Error("Received item must differ from the expected item")
  }

  type Row = { id: number; customer: string; unitBuy: number; unitShip: number; pending: number }
  const orders = (await sql`
    SELECT id, customer,
           COALESCE(unit_buy, 0)::int  AS "unitBuy",
           COALESCE(unit_ship, 0)::int AS "unitShip",
           (unit_dispatch - COALESCE(unit_arrive, 0))::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND unit_dispatch IS NOT NULL
      AND (unit_arrive IS NULL OR unit_arrive < unit_dispatch)
    ORDER BY id ASC
  `) as unknown as Row[]

  const statusMap = await fetchPaidStatusMap([data.event])
  orders.sort(compareOrderPriority(data.event, statusMap))

  const { allocations, excess } = allocateFifo(orders, (o) => o.pending, data.qty)
  if (excess > 0) throw new Error(`Only ${data.qty - excess} units are pending; cannot record ${data.qty}`)

  let cancelledUnits = 0
  let inHandUnits = 0
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    for (const { item: o, allocated } of allocations) {
      cancelledUnits += allocated
      inHandUnits += Math.min(allocated, Math.max(0, o.unitBuy - o.unitShip))
      await reduceOrderRefundOnly({ orderId: o.id, qty: allocated }, tx)
    }
    if (data.mode === "broken" || data.mode === "missing") {
      await appendExcessPurchase(
        [{ event: data.event, items: data.productName, unitBuy: data.qty, receipt: "", reason: data.mode }],
        tx,
      )
    } else if (data.mode === "cancelled") {
      if (inHandUnits > 0) {
        await appendExcessPurchase(
          [{ event: data.event, items: data.productName, unitBuy: inHandUnits, receipt: "", reason: "customer_cancelled" }],
          tx,
        )
      }
    } else {
      await appendExcessPurchase(
        [{ event: data.event, items: data.receivedItem!, unitBuy: data.qty, receipt: "", reason: "wrong_product", expectedItem: data.productName }],
        tx,
      )
    }
  })

  const excessUnits = data.mode === "cancelled" ? inHandUnits : data.qty
  return { cancelledUnits, excessUnits }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --env-file=.env.development.local --import=tsx scratchpad/test-not-received.ts`
Expected: all `PASS`.
Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add lib/db/fulfillment.ts
git commit -m "feat(fulfillment): recordNotReceived — priority-allocated bulk not-received"
```

---

### Task 4: API action `not_received`

**Files:**
- Modify: `app/api/sheets/arrival-list/route.ts` (import + new action branch before the final default)

**Interfaces:**
- Consumes: `recordNotReceived` (from `@/lib/db`).
- Produces: `POST /api/sheets/arrival-list` accepts `{ action: "not_received", event, productId, productName, qty, mode, receivedItem? }`.

- [ ] **Step 1: Add the import**

In `app/api/sheets/arrival-list/route.ts:3`, add `recordNotReceived` to the existing import from `@/lib/db`.

- [ ] **Step 2: Add the action branch**

Immediately before the final fallback (`const { event, productId, quantityArrived } = body`, ~line 118) add:

```ts
    // Bulk "Not Received": record a delivery problem against `qty` units of one
    // product, allocated across its waiting orders by priority (recordNotReceived
    // runs its own transaction + actor).
    if (body.action === "not_received") {
      const { event, productId, productName, qty, mode, receivedItem } = body
      const validModes = ["wrong", "broken", "missing", "cancelled"]
      if (!event || !productId || !productName || typeof qty !== "number" || qty < 1 || !validModes.includes(mode)) {
        return NextResponse.json(
          { error: "event, productId, productName, qty (>=1) and a valid mode are required" },
          { status: 400 },
        )
      }
      if (mode === "wrong" && (!receivedItem || receivedItem === productName)) {
        return NextResponse.json(
          { error: "A wrong delivery needs a received item different from the expected one" },
          { status: 400 },
        )
      }
      const result = await recordNotReceived(
        { event, productId: Number(productId), productName, qty, mode, receivedItem },
        session.user.email,
      )
      return NextResponse.json({ success: true, ...result })
    }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/sheets/arrival-list/route.ts
git commit -m "feat(api): not_received action on arrival-list route"
```

---

### Task 5: Selection-bar action + `NotReceivedPanel`

**Files:**
- Modify: `components/SelectionActionBar.tsx` (add `amber`)
- Modify: `app/dashboard/arrival-list/ArrivalListClient.tsx` (state, action, render, new component)
- Test: none (no UI test harness) — verify via `npx tsc --noEmit` and `npx next build` if fast enough; the flow's logic is covered by Task 3.

**Interfaces:**
- Consumes: `recordNotReceived` via `POST /api/sheets/arrival-list` (Task 4); `selKey`, `ArrivalListItem`, `SearchableSelect`, `SelectionActionBar` (all already in the file/imported); `options?.items` for the SKU picker.

- [ ] **Step 1: Add `amber` to SelectionActionBar**

`components/SelectionActionBar.tsx` — extend the union (line 10) and the map (after line 18):

```ts
  color: "brand" | "green" | "blue" | "red" | "amber"
```
```ts
  amber: { bg: "bg-amber-100", text: "text-amber-700" },
```

- [ ] **Step 2: Add panel state**

In `ArrivalListClient` (near `const [receiveOpen, setReceiveOpen] = useState(false)`), add:

```ts
  const [notReceivedOpen, setNotReceivedOpen] = useState(false)
```

- [ ] **Step 3: Add the selection-bar action**

In the `SelectionActionBar` `actions` array (after the `Received` action object, ~line 643), add:

```tsx
            {
              label: "Not Received",
              color: "amber",
              onClick: () => setNotReceivedOpen(true),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              ),
            },
```

- [ ] **Step 4: Render the panel**

After the `receiveOpen` block (~line 662, before the closing `</>`), add:

```tsx
      {notReceivedOpen && (
        <NotReceivedPanel
          items={selectedItems}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
          onClose={() => setNotReceivedOpen(false)}
          onSuccess={() => { clearSelection(); setNotReceivedOpen(false); handleArrivedSuccess() }}
          onPartial={(succeededKeys) => {
            setSelected((prev) => {
              const next = new Set(prev)
              for (const k of succeededKeys) next.delete(k)
              return next
            })
            handleArrivedSuccess()
          }}
        />
      )}
```

- [ ] **Step 5: Add the `NotReceivedPanel` component**

At the end of `ArrivalListClient.tsx`, add the component below. It mirrors `ConfirmReceivePanel` (per-item qty rows grouped by event, `Promise.allSettled`, partial-failure list) and adds the 4-tab selector plus a per-row SKU picker for the Wrong tab.

```tsx
// ─── Not Received panel (bulk delivery problems) ─────────────────────────────

type NotReceivedMode = "wrong" | "broken" | "missing" | "cancelled"

function NotReceivedPanel({
  items,
  itemOptions,
  onClose,
  onSuccess,
  onPartial,
}: {
  items: ArrivalListItem[]
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onSuccess: () => void
  onPartial: (succeededKeys: string[]) => void
}) {
  const [mode, setMode] = useState<NotReceivedMode>("broken")
  // qty per item (default = pending). received SKU per item (Wrong tab only).
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalPending)
    return m
  })
  const [received, setReceived] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const byEvent = useMemo(() => {
    const m = new Map<string, ArrivalListItem[]>()
    for (const it of items) {
      const arr = m.get(it.event) ?? []
      arr.push(it)
      m.set(it.event, arr)
    }
    return m
  }, [items])

  const qtyOf = (it: ArrivalListItem) => Math.min(Number(qtys[selKey(it)]) || 0, it.totalPending)
  const activeItems = items.filter((it) => qtyOf(it) > 0)
  const totalQty = activeItems.reduce((s, it) => s + qtyOf(it), 0)
  // Wrong needs a valid received SKU (present, differs from expected) on every active row.
  const wrongMissingSku =
    mode === "wrong" &&
    activeItems.some((it) => {
      const sku = received[selKey(it)]
      return !sku || sku === it.productName
    })
  const canSubmit = totalQty > 0 && !wrongMissingSku

  async function handleSubmit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setErrors([])

    const targets = activeItems.map((it) => ({
      key: selKey(it),
      event: it.event,
      productId: it.productId,
      productName: it.productName,
      qty: qtyOf(it),
      receivedItem: received[selKey(it)],
    }))

    const settled = await Promise.allSettled(
      targets.map((t) =>
        fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "not_received",
            mode,
            event: t.event,
            productId: t.productId,
            productName: t.productName,
            qty: t.qty,
            ...(mode === "wrong" ? { receivedItem: t.receivedItem } : {}),
          }),
        }).then(async (res) => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? `Failed for ${t.productName}`)
          return t.key
        }),
      ),
    )

    const succeeded: string[] = []
    const failed: string[] = []
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(targets[i].key)
      else failed.push(`${targets[i].productName}: ${r.reason instanceof Error ? r.reason.message : "failed"}`)
    })

    setSubmitting(false)
    if (failed.length === 0) onSuccess()
    else { setErrors(failed); if (succeeded.length > 0) onPartial(succeeded) }
  }

  const TABS: [NotReceivedMode, string][] = [
    ["wrong", "Wrong"],
    ["broken", "Broken"],
    ["missing", "Missing"],
    ["cancelled", "Cancelled"],
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">
            Not received — {items.length} item{items.length === 1 ? "" : "s"}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Records the chosen quantity as not received, refunding the highest-priority orders first. Leftover units stay pending.
          </p>
        </div>

        <div className="px-5 pt-4 shrink-0">
          <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
            {TABS.map(([m, label]) => {
              const active = mode === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 px-2 py-1.5 font-medium transition-colors ${active ? "bg-amber-500 text-white" : "text-gray-500 hover:bg-cream"}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto min-h-0 flex flex-col gap-4">
          {[...byEvent.entries()].map(([event, evItems]) => (
            <div key={event} className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-gray-500">{event}</div>
              {evItems.map((it) => {
                const k = selKey(it)
                const sku = received[k]
                const skuInvalid = mode === "wrong" && qtyOf(it) > 0 && (!sku || sku === it.productName)
                return (
                  <div key={k} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground break-words">{it.productName}</div>
                        {it.store && <div className="text-[11px] text-gray-400">{it.store}</div>}
                      </div>
                      <input
                        type="number"
                        min="0"
                        max={it.totalPending}
                        value={qtys[k] ?? ""}
                        onChange={(e) => setQtys((p) => ({ ...p, [k]: e.target.value }))}
                        className="w-20 shrink-0 border border-cream-border rounded-lg px-2 py-1.5 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-500 transition-colors"
                      />
                      <span className="text-[11px] text-gray-400 w-16 shrink-0">/ {it.totalPending} pending</span>
                    </div>
                    {mode === "wrong" && (
                      <div className="flex flex-col gap-1">
                        <SearchableSelect
                          value={sku ?? ""}
                          onChange={(v) => setReceived((p) => ({ ...p, [k]: v }))}
                          options={itemOptions}
                          placeholder="Received item (what supplier sent)…"
                        />
                        {skuInvalid && <span className="text-[11px] text-red-600">Pick a received item different from the expected one.</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          {errors.length > 0 && (
            <div className="text-xs text-red-600">
              <div className="font-medium">Some items failed (others were recorded):</div>
              <ul className="list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !canSubmit}
              className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit` → EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add components/SelectionActionBar.tsx app/dashboard/arrival-list/ArrivalListClient.tsx
git commit -m "feat(arrival): bulk Not Received panel + selection-bar action"
```

---

## Final: whole-branch review

After all tasks, run the final whole-branch review on the most capable model (money + inventory + partial cancellation). Focus areas:
- Allocation correctness: `qty` mid-order partial cancel; leftover stays pending; priority order matches receive path.
- Inventory reasons + assignability (missing/broken excluded from apply-to-orders; cancelled/wrong assignable).
- No regression to `cancelOrderUnits` / `ArriveModal` / whole-order `record*`.
- Refund-only reducer never drops a line below committed units.
- Route validation (qty bounds, wrong SKU) and per-item partial-failure handling.

Then use superpowers:finishing-a-development-branch.
