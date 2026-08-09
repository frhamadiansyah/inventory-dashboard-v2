# Overbuy Transit Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stock that's been overbought but isn't physically in hand yet (still in transit) currently vanishes into `excess_purchase` — a table with no dispatch/arrival tracking, labeled "Ready stock" everywhere it's read — so it never shows up in the Dispatch List or Receiving List and gets silently treated as available. This plan gives `excess_purchase` the same buy → dispatch → arrive lifecycle `orders` already has, surfaces pending rows in a new "Overbuy in transit" section on both list pages, and fixes the "Apply Excess" flow so in-transit stock reassigned to a customer order doesn't get falsely marked as already arrived.

**Architecture:** Mirror the existing `orders` table's three-stage lifecycle (`unit_buy` → `unit_dispatch` → `unit_arrive`) onto `excess_purchase` via two new nullable columns + one tracking-ref column. New query functions (`getExcessDispatchPending`, `getExcessArrivalPending`) and mutation functions (`bulkUpdateExcessDispatch`, `bulkUpdateExcessArrive`) parallel the existing `orders`-side ones. Because excess rows have no customer, they get a separate UI section (not merged into the customer-order table) with a single-row "mark dispatched/arrived" action — no FIFO allocation needed, it's just advancing that one row's own stage.

**Tech Stack:** Next.js (App Router), TypeScript, Postgres via `postgres` (`postgres-js`), Tailwind. No test framework is configured in this repo (`package.json` has no test script, no `*.test.*` files exist) — verification is `npx tsc --noEmit` plus manual checks against the local dev DB, matching how the rest of this codebase is validated. Do not introduce a test framework as part of this plan.

## Global Constraints

- Migrations are plain SQL files under `supabase/migrations/`, applied manually in the Supabase SQL editor as the `postgres` owner in production. For local dev, apply via `supabase migration up` — **never** `supabase db reset` (it wipes local seed data).
- `lib/db.ts` is a barrel (`export * from "./db/<file>"`) — any exported function/type from `lib/db/orders.ts`, `lib/db/dispatch.ts`, `lib/db/fulfillment.ts`, or `lib/db/types.ts` is automatically available via `@/lib/db`. No manual re-export step.
- DB-executor pattern: every mutation function takes `db: DBExecutor = sql` as its last parameter so it composes inside `withActor`'s transaction. Follow this exactly for new functions.
- `supabase/schema.sql` is a stale bootstrap snapshot, not kept in sync with migrations after the fact (e.g. migrations 048/049 added `orders.unit_dispatch`/`dispatch_receipt`, neither appears in `schema.sql`). Do not update `schema.sql` in this plan — matches existing repo practice.
- No code comments except where they explain a non-obvious WHY (this codebase's existing style — see e.g. `orders.ts:488-500`). Don't add comments that restate what the code does.

---

### Task 1: Migration — transit columns on `excess_purchase`

**Files:**
- Create: `supabase/migrations/056_excess_purchase_transit_tracking.sql`

**Interfaces:**
- Produces: three new columns on `excess_purchase` — `unit_dispatch INTEGER` (nullable), `unit_arrive INTEGER` (nullable), `dispatch_receipt TEXT NOT NULL DEFAULT ''`. Every later task in this plan depends on these existing.

- [ ] **Step 1: Write the migration**

```sql
-- Give excess_purchase (the overbuy/overship/etc "Ready stock" table) the same
-- buy -> dispatch -> arrive lifecycle orders has (migration 048/049), so stock
-- that's been bought but isn't physically in hand yet doesn't silently read as
-- "ready" just because it landed in this table.
ALTER TABLE excess_purchase ADD COLUMN unit_dispatch INTEGER;
ALTER TABLE excess_purchase ADD COLUMN unit_arrive INTEGER;
ALTER TABLE excess_purchase ADD COLUMN dispatch_receipt TEXT NOT NULL DEFAULT '';

-- Backfill: every existing row was always treated as ready stock (this table
-- had no other concept), so mark it fully dispatched+arrived to match current
-- behavior with zero regression -- EXCEPT the LSJP202608 overbuy rows, which
-- are known to still be in transit right now. Leave those NULL so they show up
-- in the new "Overbuy in transit" sections (Task 5/6/10-12) for reconciliation.
UPDATE excess_purchase
SET unit_dispatch = unit_buy, unit_arrive = unit_buy
WHERE NOT (event = 'LSJP202608' AND reason = 'overbuy');
```

- [ ] **Step 2: Apply to local dev DB**

Run: `supabase migration up`
(Per project convention: never `supabase db reset` — it destroys local seed data. `migration up` applies new migrations in place.)

- [ ] **Step 3: Verify the backfill**

Run this against the local dev DB (`psql` or Supabase SQL editor pointed at the dev project):

```sql
SELECT event, reason, count(*) AS rows, sum(unit_buy) AS units
FROM excess_purchase
WHERE unit_dispatch IS NULL
GROUP BY event, reason;
```

Expected: only `event = 'LSJP202608', reason = 'overbuy'` rows appear (if any exist in the dev DB — zero rows is also a valid pass if that event has no overbuy rows locally). Every other row must have `unit_dispatch` and `unit_arrive` both non-null and equal to `unit_buy`:

```sql
SELECT count(*) FROM excess_purchase
WHERE unit_dispatch IS NOT NULL AND (unit_dispatch <> unit_buy OR unit_arrive <> unit_buy);
```

Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/056_excess_purchase_transit_tracking.sql
git commit -m "feat(db): add dispatch/arrive tracking to excess_purchase"
```

---

### Task 2: Types — `ExcessRow` fields + new interfaces

**Files:**
- Modify: `lib/db/types.ts:69-99`

**Interfaces:**
- Consumes: nothing (pure type additions).
- Produces: `ExcessRow.unitDispatch: number | null`, `ExcessRow.unitArrive: number | null`, `ExcessRow.dispatchReceipt: string`; new `ExcessDispatchUpdate`, `ExcessArriveUpdate`, `ExcessTransitItem` interfaces. Every later task's function signatures reference these exact names.

- [ ] **Step 1: Extend `ExcessRow` and add the new interfaces**

In `lib/db/types.ts`, change:

```ts
export interface ExcessRow {
  rowNumber: number
  event: string
  items: string
  unitBuy: number
  receipt: string
  reason: ExcessReason
  expectedItem: string
  createdAt: string
  updatedAt: string
  /** Item's sell price, joined by name from products — only populated by the
   *  paginated fetch (for display); undefined elsewhere. */
  price?: number | null
}
```

to:

```ts
export interface ExcessRow {
  rowNumber: number
  event: string
  items: string
  unitBuy: number
  receipt: string
  reason: ExcessReason
  expectedItem: string
  createdAt: string
  updatedAt: string
  // Null means "not yet at this stage" — same convention as orders.unit_dispatch
  // / orders.unit_arrive. Set on every insert path (Task 3/4); never left
  // ambiguous by omission.
  unitDispatch: number | null
  unitArrive: number | null
  dispatchReceipt: string
  /** Item's sell price, joined by name from products — only populated by the
   *  paginated fetch (for display); undefined elsewhere. */
  price?: number | null
}
```

Immediately after `DispatchUpdate` (currently `types.ts:95-99`), add:

```ts
export interface ExcessDispatchUpdate {
  rowNumber: number
  unitDispatch: number
  dispatchReceipt: string
}

export interface ExcessArriveUpdate {
  rowNumber: number
  unitArrive: number
}

/** One excess_purchase row still moving through buy -> dispatch -> arrive, for
 *  the "Overbuy in transit" section on the Dispatch List / Receiving List
 *  pages. `pending` is stage-specific: unitBuy - unitDispatch when sourced from
 *  getExcessDispatchPending, unitDispatch - unitArrive from getExcessArrivalPending. */
export interface ExcessTransitItem {
  rowNumber: number
  event: string
  items: string
  reason: ExcessReason
  unitBuy: number
  unitDispatch: number
  unitArrive: number
  pending: number
  receipt: string
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: new errors at every call site that constructs an `ExcessRow` without the three new fields (in `lib/db/orders.ts`) — that's expected; Task 3 fixes them. If you see errors anywhere else, stop and investigate before continuing.

- [ ] **Step 3: Commit**

```bash
git add lib/db/types.ts
git commit -m "feat(types): add excess_purchase transit fields"
```

---

### Task 3: Row mapping + insert defaults (`lib/db/orders.ts`)

**Files:**
- Modify: `lib/db/orders.ts:623-654` (`getExcessPurchaseRows`, `mapExcessRow`)
- Modify: `lib/db/orders.ts:1009-1035` (`appendExcessPurchase`)

**Interfaces:**
- Consumes: `ExcessRow.unitDispatch/unitArrive/dispatchReceipt` (Task 2).
- Produces: every `ExcessRow` returned by this file now carries real transit state; `appendExcessPurchase` inserts are always fully-arrived (matches every current caller's semantics — see Step 3 rationale).

- [ ] **Step 1: Select and map the new columns**

In `getExcessPurchaseRows` (`orders.ts:623-639`), change:

```ts
export async function getExcessPurchaseRows(): Promise<ExcessRow[]> {
  const rows = await sql`
    SELECT id, event, items, unit_buy, receipt, reason, expected_item, created_at, updated_at
    FROM excess_purchase ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    items: r.items,
    unitBuy: r.unit_buy,
    receipt: r.receipt ?? "",
    reason: (r.reason ?? "overbuy") as ExcessReason,
    expectedItem: r.expected_item ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}
```

to:

```ts
export async function getExcessPurchaseRows(): Promise<ExcessRow[]> {
  const rows = await sql`
    SELECT id, event, items, unit_buy, receipt, reason, expected_item,
           unit_dispatch, unit_arrive, dispatch_receipt, created_at, updated_at
    FROM excess_purchase ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    items: r.items,
    unitBuy: r.unit_buy,
    receipt: r.receipt ?? "",
    reason: (r.reason ?? "overbuy") as ExcessReason,
    expectedItem: r.expected_item ?? "",
    unitDispatch: r.unit_dispatch,
    unitArrive: r.unit_arrive,
    dispatchReceipt: r.dispatch_receipt ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}
```

In `mapExcessRow` (`orders.ts:641-654`), change:

```ts
function mapExcessRow(r: Record<string, unknown>): ExcessRow {
  return {
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    unitBuy: r.unit_buy as number,
    receipt: (r.receipt as string) ?? "",
    reason: ((r.reason as string) ?? "overbuy") as ExcessReason,
    expectedItem: (r.expected_item as string) ?? "",
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
    price: r.price != null ? Number(r.price) : null,
  }
}
```

to:

```ts
function mapExcessRow(r: Record<string, unknown>): ExcessRow {
  return {
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    unitBuy: r.unit_buy as number,
    receipt: (r.receipt as string) ?? "",
    reason: ((r.reason as string) ?? "overbuy") as ExcessReason,
    expectedItem: (r.expected_item as string) ?? "",
    unitDispatch: r.unit_dispatch as number | null,
    unitArrive: r.unit_arrive as number | null,
    dispatchReceipt: (r.dispatch_receipt as string) ?? "",
    createdAt: tsToString(r.created_at as Date | null),
    updatedAt: tsToString(r.updated_at as Date | null),
    price: r.price != null ? Number(r.price) : null,
  }
}
```

`mapExcessRow` is fed by `getExcessPurchasePaginated`'s query (`orders.ts:726-736`), which also needs the new columns selected — update its `SELECT`:

```ts
     SELECT e.id, e.event, e.items, e.unit_buy, e.receipt, e.reason, e.expected_item, e.created_at, e.updated_at, pp.price
     FROM excess_purchase e
```

to:

```ts
     SELECT e.id, e.event, e.items, e.unit_buy, e.receipt, e.reason, e.expected_item,
            e.unit_dispatch, e.unit_arrive, e.dispatch_receipt, e.created_at, e.updated_at, pp.price
     FROM excess_purchase e
```

- [ ] **Step 2: Default `appendExcessPurchase` inserts to fully-arrived**

`appendExcessPurchase` (`orders.ts:1009-1035`) is called from three places, and in every one of them the stock is already physically in hand at the moment of insert:
- `recordWrongProduct` — wrong SKU physically received, just mismatched.
- `recordBrokenArrival` — damaged item physically received.
- The `arrive` route's overship path (`app/api/sheets/arrive/route.ts:144-153`) — unmatched leftover after a real arrival.
- The manual "Add Inventory" form (`PUT /api/sheets/excess-purchase`) — user is recording stock they say they currently have.

None of these are the in-transit case (that's `returnOrderUnitsToExcess`, fixed in Task 4). So default every `appendExcessPurchase` insert to fully dispatched+arrived, matching current behavior exactly (these rows were always treated as ready stock, with zero regression):

Change:

```ts
export async function appendExcessPurchase(
  rows: {
    event: string
    items: string
    unitBuy: number
    receipt: string
    reason?: ExcessReason
    expectedItem?: string
  }[],
  db: DBExecutor = sql,
): Promise<void> {
  if (rows.length === 0) return
  await db`
    INSERT INTO excess_purchase ${db(
      rows.map((r) => ({
        // Blank event → NULL: manual "Add Inventory" rows may have no event.
        // Auto-spill callers always pass a real event, so this is a no-op there.
        event: r.event || null,
        items: r.items,
        unit_buy: r.unitBuy,
        receipt: r.receipt,
        reason: r.reason ?? "overbuy",
        expected_item: r.expectedItem ?? null,
      }))
    )}
  `
}
```

to:

```ts
export async function appendExcessPurchase(
  rows: {
    event: string
    items: string
    unitBuy: number
    receipt: string
    reason?: ExcessReason
    expectedItem?: string
  }[],
  db: DBExecutor = sql,
): Promise<void> {
  if (rows.length === 0) return
  await db`
    INSERT INTO excess_purchase ${db(
      rows.map((r) => ({
        // Blank event → NULL: manual "Add Inventory" rows may have no event.
        // Auto-spill callers always pass a real event, so this is a no-op there.
        event: r.event || null,
        items: r.items,
        unit_buy: r.unitBuy,
        receipt: r.receipt,
        reason: r.reason ?? "overbuy",
        expected_item: r.expectedItem ?? null,
        // Every current caller (wrong-product, broken, overship, manual "Add
        // Inventory") is stock already physically in hand at insert time — the
        // in-transit case goes through returnOrderUnitsToExcess instead, which
        // sets these explicitly. Defaulting to fully-arrived here matches this
        // table's pre-existing "ready stock" behavior for these paths exactly.
        unit_dispatch: r.unitBuy,
        unit_arrive: r.unitBuy,
      }))
    )}
  `
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors remaining in `lib/db/orders.ts`. (Task 4 still needs `returnOrderUnitsToExcess` fixed — if that shows an error too, that's expected and fixed next.)

- [ ] **Step 4: Commit**

```bash
git add lib/db/orders.ts
git commit -m "feat(db): map excess_purchase transit columns, default appendExcessPurchase to arrived"
```

---

### Task 4: `returnOrderUnitsToExcess` — carry real transit state

**Files:**
- Modify: `lib/db/orders.ts:502-571`

**Interfaces:**
- Consumes: nothing new.
- Produces: excess rows created by this function now correctly reflect whether the surplus units were already dispatched (in transit) — instead of silently discarding that state.

**Context:** This function's own doc comment (`orders.ts:488-490`) says it "bank[s] the bought-but-not-yet-arrived surplus into excess_purchase" — this is the one path that can legitimately create in-transit excess. Its invariant (line 538 comment) guarantees the surplus never includes arrived units, but it currently doesn't even `SELECT` `unit_dispatch`, so any dispatched-but-not-arrived portion of the surplus is silently dropped.

- [ ] **Step 1: Select `unit_dispatch` and compute the dispatched portion of the surplus**

Change (`orders.ts:511-518`):

```ts
  const rows = await db`
    SELECT o.event, o.unit, o.unit_buy, o.unit_arrive, o.unit_ship, o.unit_hold,
           o.receipt, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ${rowNumber}
    FOR UPDATE OF o
  `
```

to:

```ts
  const rows = await db`
    SELECT o.event, o.unit, o.unit_buy, o.unit_dispatch, o.unit_arrive, o.unit_ship, o.unit_hold,
           o.receipt, p.name AS product_name
    FROM orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.id = ${rowNumber}
    FOR UPDATE OF o
  `
```

Change (`orders.ts:522-526`):

```ts
  const unit = Number(r.unit) || 0
  const unitBuy = Number(r.unit_buy) || 0
  const unitArrive = Number(r.unit_arrive) || 0
  const unitShip = Number(r.unit_ship) || 0
  const unitHold = Number(r.unit_hold) || 0
```

to:

```ts
  const unit = Number(r.unit) || 0
  const unitBuy = Number(r.unit_buy) || 0
  const unitDispatch = Number(r.unit_dispatch) || 0
  const unitArrive = Number(r.unit_arrive) || 0
  const unitShip = Number(r.unit_ship) || 0
  const unitHold = Number(r.unit_hold) || 0
```

- [ ] **Step 2: Insert the excess row with real dispatch state**

Change (`orders.ts:537-547`):

```ts
  // Bought units the shrunk order no longer needs become excess. Because
  // newUnit >= committed >= unitArrive, this never moves arrived stock.
  const excessUnits = Math.max(0, unitBuy - newUnit)
  const receipt = (r.receipt as string) ?? ""

  if (excessUnits > 0) {
    await db`
      INSERT INTO excess_purchase (event, items, unit_buy, receipt)
      VALUES (${r.event as string}, ${r.product_name as string}, ${excessUnits}, ${receipt})
    `
  }
```

to:

```ts
  // Bought units the shrunk order no longer needs become excess. Because
  // newUnit >= committed >= unitArrive, this never moves arrived stock — but it
  // can still move already-dispatched (in-transit) stock, so carry forward
  // however much of the surplus was already dispatched instead of discarding
  // it (that's what left this stock untracked once it landed in excess_purchase).
  const excessUnits = Math.max(0, unitBuy - newUnit)
  const excessDispatch = Math.min(excessUnits, Math.max(0, unitDispatch - newUnit))
  const receipt = (r.receipt as string) ?? ""

  if (excessUnits > 0) {
    await db`
      INSERT INTO excess_purchase (event, items, unit_buy, receipt, unit_dispatch)
      VALUES (${r.event as string}, ${r.product_name as string}, ${excessUnits}, ${receipt}, ${excessDispatch > 0 ? excessDispatch : null})
    `
  }
```

`unit_arrive` is intentionally left `NULL` (the column's default) — the invariant above guarantees these units were never arrived.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `lib/db/orders.ts`.

- [ ] **Step 4: Manual verification against local dev DB**

Find (or create) an order row with `unit_buy` and `unit_dispatch` both set (e.g. `unit_buy = 10, unit_dispatch = 6`), then call `returnOrderUnitsToExcess` with `removeUnits` small enough to leave `newUnit` below 6 (e.g. `removeUnits = 6` on `unit = 10` → `newUnit = 4`). Confirm the resulting `excess_purchase` row has `unit_dispatch = 2` (the portion of the removed units that were already dispatched: `unitDispatch(6) - newUnit(4) = 2`, capped at `excessUnits = unitBuy(10) - newUnit(4) = 6`).

- [ ] **Step 5: Commit**

```bash
git add lib/db/orders.ts
git commit -m "fix(db): returnOrderUnitsToExcess carries dispatched state into excess_purchase"
```

---

### Task 5: Dispatch-side query + mutation + wiring

**Files:**
- Modify: `lib/db/orders.ts` (add `bulkUpdateExcessDispatch`, after `bulkUpdateDispatch` at `orders.ts:605-619`)
- Modify: `lib/db/dispatch.ts` (add `getExcessDispatchPending`, after `getDispatchList` at `dispatch.ts:163`)
- Modify: `app/api/sheets/dispatch/route.ts:74-93` (`GET` handler)

**Interfaces:**
- Consumes: `ExcessDispatchUpdate`, `ExcessTransitItem` (Task 2); `excess_purchase.unit_dispatch` (Task 1).
- Produces: `bulkUpdateExcessDispatch(updates: ExcessDispatchUpdate[], db?)`, `getExcessDispatchPending(event?: string): Promise<ExcessTransitItem[]>`. `GET /api/sheets/dispatch` response gains `excessPending: ExcessTransitItem[]`. Task 7 (mark-dispatched endpoint) and Task 11 (UI wiring) depend on both.

- [ ] **Step 1: Add `bulkUpdateExcessDispatch`**

In `lib/db/orders.ts`, immediately after `bulkUpdateDispatch` (ends at line 619), add:

```ts
export async function bulkUpdateExcessDispatch(updates: ExcessDispatchUpdate[], db: DBExecutor = sql): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const dispatches = updates.map((u) => u.unitDispatch)
  const receipts = updates.map((u) => u.dispatchReceipt)
  await db`
    UPDATE excess_purchase SET
      unit_dispatch = data.unit_dispatch,
      dispatch_receipt = data.dispatch_receipt,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${dispatches}::int[], ${receipts}::text[])
      AS data(id, unit_dispatch, dispatch_receipt)
    WHERE excess_purchase.id = data.id
  `
}
```

`ExcessDispatchUpdate` needs importing — check the top-of-file import from `./types` (`orders.ts:4`) already lists `DispatchUpdate`; add `ExcessDispatchUpdate` and `ExcessArriveUpdate` to that same import list now (Task 6 needs the latter).

- [ ] **Step 2: Add `getExcessDispatchPending`**

In `lib/db/dispatch.ts`, immediately after `getDispatchList` (ends at line 163), add:

```ts
// ─── Excess (overbuy) Dispatch Pending ─────────────────────────────────────
//
// excess_purchase rows that have been bought but not yet dispatched. Unlike
// getDispatchList these have no customer to allocate to — the row just
// advances its own buy -> dispatch stage (see the "Overbuy in transit"
// section on the Dispatch List page).

export async function getExcessDispatchPending(event?: string): Promise<import("./types").ExcessTransitItem[]> {
  const rows = event
    ? await sql`
        SELECT id, event, items, reason, unit_buy,
               COALESCE(unit_dispatch, 0) AS unit_dispatch,
               COALESCE(unit_arrive, 0) AS unit_arrive,
               receipt
        FROM excess_purchase
        WHERE unit_buy IS NOT NULL
          AND (unit_dispatch IS NULL OR unit_dispatch < unit_buy)
          AND event = ${event}
        ORDER BY id ASC
      `
    : await sql`
        SELECT id, event, items, reason, unit_buy,
               COALESCE(unit_dispatch, 0) AS unit_dispatch,
               COALESCE(unit_arrive, 0) AS unit_arrive,
               receipt
        FROM excess_purchase
        WHERE unit_buy IS NOT NULL
          AND (unit_dispatch IS NULL OR unit_dispatch < unit_buy)
        ORDER BY id ASC
      `
  return rows.map((r) => ({
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    reason: r.reason as import("./types").ExcessReason,
    unitBuy: r.unit_buy as number,
    unitDispatch: r.unit_dispatch as number,
    unitArrive: r.unit_arrive as number,
    pending: (r.unit_buy as number) - (r.unit_dispatch as number),
    receipt: (r.receipt as string) ?? "",
  }))
}
```

(Using the inline `import("./types").X` form here rather than a new named import keeps this a self-contained diff — if you prefer, add `ExcessTransitItem, ExcessReason` to `dispatch.ts`'s existing top-of-file imports instead and drop the inline form; both are equivalent.)

Rows with `reason = 'broken'`/`'missing'`/`'wrong_product'`/`'overship'`/`'manual'` don't need excluding here: Task 3 defaults every `appendExcessPurchase` insert to `unit_dispatch = unit_buy`, so the `unit_dispatch < unit_buy` filter already excludes them — only rows genuinely mid-transit (from Task 4's `returnOrderUnitsToExcess`, or a manually-entered in-transit row) appear.

- [ ] **Step 3: Wire into `GET /api/sheets/dispatch`**

In `app/api/sheets/dispatch/route.ts`, change the import (line 3) from:

```ts
import { getDispatchList, getDuplicateFormRowsForEvent, bulkUpdateDispatch, cancelUndispatchedRemainder, withActor, fetchPaidStatusMap, PAID_PRIORITY_RANK, type PaidStatus } from "@/lib/db"
```

to:

```ts
import { getDispatchList, getExcessDispatchPending, getDuplicateFormRowsForEvent, bulkUpdateDispatch, cancelUndispatchedRemainder, withActor, fetchPaidStatusMap, PAID_PRIORITY_RANK, type PaidStatus } from "@/lib/db"
```

Change the `GET` handler (lines 78-93) from:

```ts
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const items = await getDispatchList(event)
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch dispatch list:", err)
    return NextResponse.json({ error: "Failed to fetch dispatch list" }, { status: 500 })
  }
}
```

to:

```ts
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const [items, excessPending] = await Promise.all([
      getDispatchList(event),
      getExcessDispatchPending(event),
    ])
    return NextResponse.json({ items, excessPending }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch dispatch list:", err)
    return NextResponse.json({ error: "Failed to fetch dispatch list" }, { status: 500 })
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification**

With the local dev server running (`npm run dev`), and at least one `excess_purchase` row with `unit_dispatch IS NULL` (or `< unit_buy`) in the dev DB, hit `GET /api/sheets/dispatch` (via the browser while logged in, or `curl` with a session cookie) and confirm the response JSON has a non-empty `excessPending` array containing that row.

- [ ] **Step 6: Commit**

```bash
git add lib/db/orders.ts lib/db/dispatch.ts app/api/sheets/dispatch/route.ts
git commit -m "feat(dispatch): surface excess_purchase rows pending dispatch"
```

---

### Task 6: Arrival-side query + mutation + wiring

**Files:**
- Modify: `lib/db/orders.ts` (add `bulkUpdateExcessArrive`, after `bulkUpdateExcessDispatch` from Task 5)
- Modify: `lib/db/fulfillment.ts` (add `getExcessArrivalPending`, after `getArrivalList` at `fulfillment.ts:626`)
- Modify: `app/api/sheets/arrival-list/route.ts:5-20` (`GET` handler)

**Interfaces:**
- Consumes: `ExcessArriveUpdate`, `ExcessTransitItem` (Task 2); `excess_purchase.unit_arrive` (Task 1).
- Produces: `bulkUpdateExcessArrive(updates: ExcessArriveUpdate[], db?)`, `getExcessArrivalPending(event?: string): Promise<ExcessTransitItem[]>`. `GET /api/sheets/arrival-list` response gains `excessPending: ExcessTransitItem[]`. Task 7 and Task 12 depend on both.

- [ ] **Step 1: Add `bulkUpdateExcessArrive`**

In `lib/db/orders.ts`, immediately after `bulkUpdateExcessDispatch` (added in Task 5), add:

```ts
export async function bulkUpdateExcessArrive(updates: ExcessArriveUpdate[], db: DBExecutor = sql): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const arrives = updates.map((u) => u.unitArrive)
  await db`
    UPDATE excess_purchase SET
      unit_arrive = data.unit_arrive,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${arrives}::int[])
      AS data(id, unit_arrive)
    WHERE excess_purchase.id = data.id
  `
}
```

- [ ] **Step 2: Add `getExcessArrivalPending`**

In `lib/db/fulfillment.ts`, immediately after `getArrivalList` (ends at line 626), add:

```ts
// ─── Excess (overbuy) Arrival Pending ──────────────────────────────────────
//
// excess_purchase rows dispatched but not yet arrived. Mirrors
// getExcessDispatchPending one stage later — see lib/db/dispatch.ts.

export async function getExcessArrivalPending(event?: string): Promise<import("./types").ExcessTransitItem[]> {
  const rows = event
    ? await sql`
        SELECT id, event, items, reason, unit_buy,
               COALESCE(unit_dispatch, 0) AS unit_dispatch,
               COALESCE(unit_arrive, 0) AS unit_arrive,
               receipt
        FROM excess_purchase
        WHERE unit_dispatch IS NOT NULL
          AND (unit_arrive IS NULL OR unit_arrive < unit_dispatch)
          AND event = ${event}
        ORDER BY id ASC
      `
    : await sql`
        SELECT id, event, items, reason, unit_buy,
               COALESCE(unit_dispatch, 0) AS unit_dispatch,
               COALESCE(unit_arrive, 0) AS unit_arrive,
               receipt
        FROM excess_purchase
        WHERE unit_dispatch IS NOT NULL
          AND (unit_arrive IS NULL OR unit_arrive < unit_dispatch)
        ORDER BY id ASC
      `
  return rows.map((r) => ({
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    reason: r.reason as import("./types").ExcessReason,
    unitBuy: r.unit_buy as number,
    unitDispatch: r.unit_dispatch as number,
    unitArrive: r.unit_arrive as number,
    pending: (r.unit_dispatch as number) - (r.unit_arrive as number),
    receipt: (r.receipt as string) ?? "",
  }))
}
```

- [ ] **Step 3: Wire into `GET /api/sheets/arrival-list`**

In `app/api/sheets/arrival-list/route.ts`, change the import (line 3) from:

```ts
import { getArrivalList, markProductArrived, recordWrongProduct, recordBrokenArrival, recordMissingArrival, recordCustomerCancellation, recordNotReceived, withActor } from "@/lib/db"
```

to:

```ts
import { getArrivalList, getExcessArrivalPending, markProductArrived, recordWrongProduct, recordBrokenArrival, recordMissingArrival, recordCustomerCancellation, recordNotReceived, withActor } from "@/lib/db"
```

Change the `GET` handler (lines 5-20) from:

```ts
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const items = await getArrivalList(event)
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch arrival list:", err)
    return NextResponse.json({ error: "Failed to fetch arrival list" }, { status: 500 })
  }
}
```

to:

```ts
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const [items, excessPending] = await Promise.all([
      getArrivalList(event),
      getExcessArrivalPending(event),
    ])
    return NextResponse.json({ items, excessPending }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch arrival list:", err)
    return NextResponse.json({ error: "Failed to fetch arrival list" }, { status: 500 })
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Same approach as Task 5 Step 5, but against `GET /api/sheets/arrival-list` with a dev-DB row that has `unit_dispatch IS NOT NULL AND (unit_arrive IS NULL OR unit_arrive < unit_dispatch)`.

- [ ] **Step 6: Commit**

```bash
git add lib/db/orders.ts lib/db/fulfillment.ts app/api/sheets/arrival-list/route.ts
git commit -m "feat(arrival): surface excess_purchase rows pending arrival"
```

---

### Task 7: Mark-dispatched / mark-arrived endpoints for a single excess row

**Files:**
- Create: `app/api/sheets/excess-purchase/[row]/dispatch/route.ts`
- Create: `app/api/sheets/excess-purchase/[row]/arrive/route.ts`

**Interfaces:**
- Consumes: `getExcessPurchaseRows`, `bulkUpdateExcessDispatch` (Task 5), `bulkUpdateExcessArrive` (Task 6), `withActor`, `requireSession`, `requireRole` (existing, from `@/lib/api` and `@/lib/db`).
- Produces: `POST /api/sheets/excess-purchase/:row/dispatch` body `{ qty: number, receipt?: string }`; `POST /api/sheets/excess-purchase/:row/arrive` body `{ qty: number }`. Task 10's UI component calls both.

**Context:** No FIFO/customer allocation needed — each call just advances one row's own stage, capped at what's actually pending. Follows the same session/role/error-shape conventions as the sibling route `app/api/sheets/excess-purchase/[row]/route.ts`.

- [ ] **Step 1: Write the dispatch endpoint**

```ts
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getExcessPurchaseRows, bulkUpdateExcessDispatch, withActor } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

/** Mark units of a single excess-purchase row dispatched. No customer
 *  allocation involved — this just advances that row's own buy -> dispatch stage. */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json().catch(() => ({})) as { qty?: number; receipt?: string }
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "qty must be a positive number" }, { status: 400 })
    }

    const excessRow = (await getExcessPurchaseRows()).find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    const current = excessRow.unitDispatch ?? 0
    const cap = excessRow.unitBuy - current
    if (qty > cap) {
      return NextResponse.json({ error: `Only ${cap} unit(s) pending dispatch` }, { status: 400 })
    }

    const receipt = body.receipt ? String(body.receipt).trim() : ""
    const existingReceipt = excessRow.dispatchReceipt
    const combinedReceipt = receipt
      ? (existingReceipt ? `${existingReceipt}, ${receipt}` : receipt)
      : existingReceipt

    await withActor(session.user.email, (tx) => bulkUpdateExcessDispatch(
      [{ rowNumber, unitDispatch: current + qty, dispatchReceipt: combinedReceipt }],
      tx,
    ))

    return NextResponse.json({ success: true, unitDispatch: current + qty })
  } catch (err) {
    console.error("Failed to mark excess dispatched:", err)
    return NextResponse.json({ error: "Failed to mark dispatched" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the arrive endpoint**

```ts
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getExcessPurchaseRows, bulkUpdateExcessArrive, withActor } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

/** Mark units of a single excess-purchase row arrived. No customer allocation
 *  involved — this just advances that row's own dispatch -> arrive stage. */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json().catch(() => ({})) as { qty?: number }
    const qty = Number(body.qty)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "qty must be a positive number" }, { status: 400 })
    }

    const excessRow = (await getExcessPurchaseRows()).find((r) => r.rowNumber === rowNumber)
    if (!excessRow) {
      return NextResponse.json({ error: "Excess row not found" }, { status: 404 })
    }

    const current = excessRow.unitArrive ?? 0
    const cap = (excessRow.unitDispatch ?? 0) - current
    if (qty > cap) {
      return NextResponse.json({ error: `Only ${cap} unit(s) pending arrival` }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => bulkUpdateExcessArrive(
      [{ rowNumber, unitArrive: current + qty }],
      tx,
    ))

    return NextResponse.json({ success: true, unitArrive: current + qty })
  } catch (err) {
    console.error("Failed to mark excess arrived:", err)
    return NextResponse.json({ error: "Failed to mark arrived" }, { status: 500 })
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Against the local dev DB, pick an `excess_purchase` row with `unit_dispatch < unit_buy` and `curl -X POST` the dispatch endpoint with a `qty` at or under the pending amount while logged in (browser dev tools → copy session cookie, or test via the UI once Task 10-11 are done). Confirm `unit_dispatch` advances and, when `qty` exceeds pending, the endpoint returns `400`.

- [ ] **Step 5: Commit**

```bash
git add app/api/sheets/excess-purchase/[row]/dispatch/route.ts app/api/sheets/excess-purchase/[row]/arrive/route.ts
git commit -m "feat(api): mark-dispatched/arrived endpoints for excess_purchase rows"
```

---

### Task 8: Fix single-row Apply — cap arrive/dispatch by source pools

**Files:**
- Modify: `app/api/sheets/excess-purchase/[row]/route.ts:111-141`

**Interfaces:**
- Consumes: `ExcessRow.unitDispatch`/`unitArrive` (Task 3).
- Produces: no new exports — corrects a bug this plan's schema change exposes.

**Context:** This is a required correctness fix, not optional polish. Before this plan, every excess row was implicitly fully-arrived, so blanket-bumping the target order's `unitArrive`/`unitDispatch` by the full allocated amount was harmless. Now that an excess row can be genuinely in-transit (`unitDispatch`/`unitArrive` below `unitBuy`), the same blanket bump would falsely mark a customer's order as already arrived the moment in-transit excess is reassigned to it. Fix: cap what the target order inherits by how much of the *source* row is actually dispatched/arrived.

- [ ] **Step 1: Track remaining dispatch/arrive pools and cap the give per allocation**

Change (`orders.ts` route, lines 111-141 — note this file is `app/api/sheets/excess-purchase/[row]/route.ts`, not `lib/db/orders.ts`):

```ts
    let remaining = excessRow.unitBuy
    const updates: (UpdatedRow & { receipt: string; unitArrive: number; unitDispatch: number; dispatchReceipt: string })[] = []

    for (const { rowNumber: targetRow, allocate: requestedAllocate } of requested) {
      const r = eligibleById.get(targetRow)
      if (!r || !Number.isFinite(requestedAllocate) || requestedAllocate <= 0) continue
      const current = r.unitBuy ?? 0
      const allocate = Math.min(r.unit - current, requestedAllocate, remaining)
      if (allocate <= 0) continue
      const existingReceipt = r.receipt ?? ""
      const combinedReceipt = receipt
        ? existingReceipt
          ? `${existingReceipt}, ${receipt}`
          : receipt
        : existingReceipt
      updates.push({
        rowNumber: r.rowNumber,
        event: r.event,
        customer: r.customer,
        oldUnitBuy: current,
        unitBuy: current + allocate,
        // Applied excess is stock already in hand, so it counts as arrived AND
        // dispatched too — bump both by the same amount so it drops off the
        // dispatch list and the receiving list, not just the shopping list.
        unitArrive: (r.unitArrive ?? 0) + allocate,
        unitDispatch: (r.unitDispatch ?? 0) + allocate,
        dispatchReceipt: r.dispatchReceipt ?? "",
        receipt: combinedReceipt,
      })
      remaining -= allocate
    }
```

to:

```ts
    let remaining = excessRow.unitBuy
    // The excess row's own dispatch/arrive pools cap what a target order can
    // inherit — in-transit excess (unitDispatch/unitArrive below unitBuy) must
    // not make the target look arrived just because it was reassigned on paper.
    let remainingDispatch = excessRow.unitDispatch ?? 0
    let remainingArrive = excessRow.unitArrive ?? 0
    const updates: (UpdatedRow & { receipt: string; unitArrive: number; unitDispatch: number; dispatchReceipt: string })[] = []

    for (const { rowNumber: targetRow, allocate: requestedAllocate } of requested) {
      const r = eligibleById.get(targetRow)
      if (!r || !Number.isFinite(requestedAllocate) || requestedAllocate <= 0) continue
      const current = r.unitBuy ?? 0
      const allocate = Math.min(r.unit - current, requestedAllocate, remaining)
      if (allocate <= 0) continue
      const existingReceipt = r.receipt ?? ""
      const combinedReceipt = receipt
        ? existingReceipt
          ? `${existingReceipt}, ${receipt}`
          : receipt
        : existingReceipt
      const dispatchGive = Math.min(allocate, remainingDispatch)
      const arriveGive = Math.min(allocate, remainingArrive)
      remainingDispatch -= dispatchGive
      remainingArrive -= arriveGive
      updates.push({
        rowNumber: r.rowNumber,
        event: r.event,
        customer: r.customer,
        oldUnitBuy: current,
        unitBuy: current + allocate,
        unitArrive: (r.unitArrive ?? 0) + arriveGive,
        unitDispatch: (r.unitDispatch ?? 0) + dispatchGive,
        dispatchReceipt: r.dispatchReceipt ?? "",
        receipt: combinedReceipt,
      })
      remaining -= allocate
    }
```

The rest of the function (the `bulkUpdatePurchase`/`bulkUpdateArrive`/`bulkUpdateDispatch` calls at lines 147-160) is unchanged — it already reads `unitArrive`/`unitDispatch` off `updates`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

In the local dev DB: create an excess row with `unit_buy = 10, unit_dispatch = 4, unit_arrive = NULL` (in-transit, partially dispatched). Through the Excess page's "Apply Excess" modal (or a direct `POST` to `/api/sheets/excess-purchase/:row` with an allocation of `6` units to one eligible order), confirm the target order ends up with `unit_buy += 6`, `unit_dispatch += 4` (not 6), `unit_arrive += 0` (not 6).

- [ ] **Step 4: Commit**

```bash
git add "app/api/sheets/excess-purchase/[row]/route.ts"
git commit -m "fix(api): single-row excess apply caps arrive/dispatch by source pools"
```

---

### Task 9: Fix bulk Apply — same cap, accumulated across excess rows

**Files:**
- Modify: `app/api/sheets/excess-purchase/route.ts:44-152`

**Interfaces:**
- Consumes: `ExcessRow.unitDispatch`/`unitArrive` (Task 3).
- Produces: no new exports — same correctness fix as Task 8, for the "Apply All" bulk path, where a single target order can receive allocations from multiple excess rows in one pass, so the accumulation has to happen per target row across the whole outer loop rather than per excess row.

- [ ] **Step 1: Track per-excess-row remaining pools, accumulate deltas per target row**

Change (lines 44-119 — the `origUnitArrive`/`origUnitDispatch` maps and the `formUpdates` loop):

```ts
    // Each order's original unit_arrive, to bump alongside unit_buy on apply
    // (applied excess is already in hand, so it counts as arrived).
    const origUnitArrive = new Map<number, number>()
    for (const r of formRows) origUnitArrive.set(r.rowNumber, r.unitArrive ?? 0)

    // Each order's original unit_dispatch, to bump alongside unit_buy on apply
    // (applied excess is already in hand, so it counts as dispatched too).
    const origUnitDispatch = new Map<number, number>()
    for (const r of formRows) origUnitDispatch.set(r.rowNumber, r.unitDispatch ?? 0)

    // Each order's existing dispatch_receipt, preserved on apply — bulkUpdateDispatch
    // always writes the column, so without this a partially-dispatched order's
    // tracking ref would be silently clobbered with "".
    const origDispatchReceipt = new Map<number, string>()
    for (const r of formRows) origDispatchReceipt.set(r.rowNumber, r.dispatchReceipt ?? "")

    // Accumulate Duplicate_Form updates (keyed by rowNumber to merge multi-excess fills)
    const formUpdates = new Map<number, { customer: string; oldUnitBuy: number; unitBuy: number; receipt: string }>()

    const results: ItemResult[] = []
    const excessToDelete: number[] = []
    const excessToUpdate: { rowNumber: number; unitBuy: number }[] = []

    for (const excessRow of excessRows) {
      const eligible = formRows
        .filter(
          (r) =>
            r.items === excessRow.items &&
            (workingUnitBuy.get(r.rowNumber) ?? 0) < r.unit,
        )
        .sort(
          (a, b) =>
            (Number(b.event === excessRow.event) - Number(a.event === excessRow.event)) ||
            (a.rowNumber - b.rowNumber),
        )

      let remaining = excessRow.unitBuy
      const filled: UpdatedRow[] = []

      for (const r of eligible) {
        if (remaining <= 0) break
        const current = workingUnitBuy.get(r.rowNumber) ?? 0
        const allocate = Math.min(r.unit - current, remaining)
        const newUnitBuy = current + allocate

        // Accumulate receipt — chain if this row is touched by multiple excess rows
        const existingReceipt = formUpdates.has(r.rowNumber)
          ? formUpdates.get(r.rowNumber)!.receipt
          : (r.receipt ?? "")
        const combinedReceipt = receipt
          ? existingReceipt ? `${existingReceipt}, ${receipt}` : receipt
          : existingReceipt

        formUpdates.set(r.rowNumber, {
          customer: r.customer,
          // preserve the original unitBuy from before this whole batch
          oldUnitBuy: formUpdates.get(r.rowNumber)?.oldUnitBuy ?? current,
          unitBuy: newUnitBuy,
          receipt: combinedReceipt,
        })
        workingUnitBuy.set(r.rowNumber, newUnitBuy)
        filled.push({ rowNumber: r.rowNumber, event: r.event, customer: r.customer, oldUnitBuy: current, unitBuy: newUnitBuy })
        remaining -= allocate
      }

      results.push({ event: excessRow.event, items: excessRow.items, originalUnitBuy: excessRow.unitBuy, filled, remainder: remaining })

      if (remaining <= 0) {
        excessToDelete.push(excessRow.rowNumber)
      } else {
        excessToUpdate.push({ rowNumber: excessRow.rowNumber, unitBuy: remaining })
      }
    }
```

to:

```ts
    // Each order's original unit_arrive/unit_dispatch, so the final write can
    // add this batch's delta on top rather than overwrite.
    const origUnitArrive = new Map<number, number>()
    for (const r of formRows) origUnitArrive.set(r.rowNumber, r.unitArrive ?? 0)

    const origUnitDispatch = new Map<number, number>()
    for (const r of formRows) origUnitDispatch.set(r.rowNumber, r.unitDispatch ?? 0)

    // Each order's existing dispatch_receipt, preserved on apply — bulkUpdateDispatch
    // always writes the column, so without this a partially-dispatched order's
    // tracking ref would be silently clobbered with "".
    const origDispatchReceipt = new Map<number, string>()
    for (const r of formRows) origDispatchReceipt.set(r.rowNumber, r.dispatchReceipt ?? "")

    // Accumulate Duplicate_Form updates (keyed by rowNumber to merge multi-excess
    // fills). arriveDelta/dispatchDelta accumulate separately from unitBuy's
    // delta because — unlike before this table tracked transit state — an
    // excess row's own unitDispatch/unitArrive can be below its unitBuy, so the
    // target order must not inherit more arrived/dispatched units than the
    // source excess row actually has.
    const formUpdates = new Map<number, {
      customer: string
      oldUnitBuy: number
      unitBuy: number
      receipt: string
      arriveDelta: number
      dispatchDelta: number
    }>()

    const results: ItemResult[] = []
    const excessToDelete: number[] = []
    const excessToUpdate: { rowNumber: number; unitBuy: number }[] = []

    for (const excessRow of excessRows) {
      const eligible = formRows
        .filter(
          (r) =>
            r.items === excessRow.items &&
            (workingUnitBuy.get(r.rowNumber) ?? 0) < r.unit,
        )
        .sort(
          (a, b) =>
            (Number(b.event === excessRow.event) - Number(a.event === excessRow.event)) ||
            (a.rowNumber - b.rowNumber),
        )

      let remaining = excessRow.unitBuy
      let remainingDispatch = excessRow.unitDispatch ?? 0
      let remainingArrive = excessRow.unitArrive ?? 0
      const filled: UpdatedRow[] = []

      for (const r of eligible) {
        if (remaining <= 0) break
        const current = workingUnitBuy.get(r.rowNumber) ?? 0
        const allocate = Math.min(r.unit - current, remaining)
        const newUnitBuy = current + allocate
        const dispatchGive = Math.min(allocate, remainingDispatch)
        const arriveGive = Math.min(allocate, remainingArrive)
        remainingDispatch -= dispatchGive
        remainingArrive -= arriveGive

        // Accumulate receipt — chain if this row is touched by multiple excess rows
        const prevUpdate = formUpdates.get(r.rowNumber)
        const existingReceipt = prevUpdate ? prevUpdate.receipt : (r.receipt ?? "")
        const combinedReceipt = receipt
          ? existingReceipt ? `${existingReceipt}, ${receipt}` : receipt
          : existingReceipt

        formUpdates.set(r.rowNumber, {
          customer: r.customer,
          // preserve the original unitBuy from before this whole batch
          oldUnitBuy: prevUpdate?.oldUnitBuy ?? current,
          unitBuy: newUnitBuy,
          receipt: combinedReceipt,
          arriveDelta: (prevUpdate?.arriveDelta ?? 0) + arriveGive,
          dispatchDelta: (prevUpdate?.dispatchDelta ?? 0) + dispatchGive,
        })
        workingUnitBuy.set(r.rowNumber, newUnitBuy)
        filled.push({ rowNumber: r.rowNumber, event: r.event, customer: r.customer, oldUnitBuy: current, unitBuy: newUnitBuy })
        remaining -= allocate
      }

      results.push({ event: excessRow.event, items: excessRow.items, originalUnitBuy: excessRow.unitBuy, filled, remainder: remaining })

      if (remaining <= 0) {
        excessToDelete.push(excessRow.rowNumber)
      } else {
        excessToUpdate.push({ rowNumber: excessRow.rowNumber, unitBuy: remaining })
      }
    }
```

- [ ] **Step 2: Use the accumulated deltas in the final write**

Change (lines 122-152):

```ts
    // 1. Write all Duplicate_Form updates in one batch. unit_arrive and
    //    unit_dispatch are both bumped by the same amount applied
    //    (unitBuy - oldUnitBuy) so applied excess — stock already in hand —
    //    drops off the dispatch and receiving lists too, not just the
    //    shopping list.
    await withActor(session.user.email, async (tx) => {
      const entries = Array.from(formUpdates.entries())
      await bulkUpdatePurchase(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitBuy: d.unitBuy,
          receipt: d.receipt,
        })),
        tx,
      )
      await bulkUpdateArrive(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitArrive: (origUnitArrive.get(rowNumber) ?? 0) + (d.unitBuy - d.oldUnitBuy),
        })),
        tx,
      )
      await bulkUpdateDispatch(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitDispatch: (origUnitDispatch.get(rowNumber) ?? 0) + (d.unitBuy - d.oldUnitBuy),
          dispatchReceipt: origDispatchReceipt.get(rowNumber) ?? "",
        })),
        tx,
      )
    })
```

to:

```ts
    // 1. Write all Duplicate_Form updates in one batch. unit_arrive and
    //    unit_dispatch are bumped by however much of the *source* excess
    //    row(s) were actually arrived/dispatched (arriveDelta/dispatchDelta),
    //    not blindly by the full amount applied — in-transit excess must not
    //    make the target order look arrived just because it was reassigned.
    await withActor(session.user.email, async (tx) => {
      const entries = Array.from(formUpdates.entries())
      await bulkUpdatePurchase(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitBuy: d.unitBuy,
          receipt: d.receipt,
        })),
        tx,
      )
      await bulkUpdateArrive(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitArrive: (origUnitArrive.get(rowNumber) ?? 0) + d.arriveDelta,
        })),
        tx,
      )
      await bulkUpdateDispatch(
        entries.map(([rowNumber, d]) => ({
          rowNumber,
          unitDispatch: (origUnitDispatch.get(rowNumber) ?? 0) + d.dispatchDelta,
          dispatchReceipt: origDispatchReceipt.get(rowNumber) ?? "",
        })),
        tx,
      )
    })
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Same scenario as Task 8 Step 3, but through the "Apply excess" bulk action (Excess page's global apply-all, `POST /api/sheets/excess-purchase`) with at least one in-transit excess row present alongside fully-arrived ones. Confirm only the fully-arrived rows' allocations bump the target orders' `unit_arrive`, and the in-transit row's allocation bumps `unit_dispatch` only up to its own `unit_dispatch` value.

- [ ] **Step 5: Commit**

```bash
git add app/api/sheets/excess-purchase/route.ts
git commit -m "fix(api): bulk excess apply caps arrive/dispatch by source pools"
```

---

### Task 10: Shared `OverbuyTransitList` component

**Files:**
- Modify: `app/dashboard/excess-purchase/ExcessTable.tsx:20-38` (export `REASON_LABEL`/`REASON_CLASS`)
- Create: `components/OverbuyTransitList.tsx`

**Interfaces:**
- Consumes: `ExcessTransitItem` (Task 2), `REASON_LABEL`/`REASON_CLASS` (this task), `fmt` from `@/lib/format`.
- Produces: `<OverbuyTransitList items={ExcessTransitItem[]} stage={"dispatch" | "arrive"} onMarked={() => void} />`. Tasks 11 and 12 render this on the Dispatch List and Receiving List pages respectively.

- [ ] **Step 1: Export the reason badge lookups**

In `app/dashboard/excess-purchase/ExcessTable.tsx`, change (lines 20-38):

```ts
const REASON_LABEL: Record<ExcessReason, string> = {
```
and
```ts
const REASON_CLASS: Record<ExcessReason, string> = {
```

to `export const REASON_LABEL` and `export const REASON_CLASS` respectively (add the `export` keyword to both declarations; no other change).

- [ ] **Step 2: Write the shared component**

Create `components/OverbuyTransitList.tsx`:

```tsx
"use client"

import { useState } from "react"
import type { ExcessTransitItem } from "@/lib/db"
import { REASON_LABEL, REASON_CLASS } from "@/app/dashboard/excess-purchase/ExcessTable"
import { fmt } from "@/lib/format"

type Stage = "dispatch" | "arrive"

export default function OverbuyTransitList({
  items,
  stage,
  onMarked,
}: {
  items: ExcessTransitItem[]
  stage: Stage
  onMarked: () => void
}) {
  const [openRow, setOpenRow] = useState<number | null>(null)

  if (items.length === 0) return null

  const title = stage === "dispatch" ? "Overbuy in transit" : "Overbuy awaiting arrival"
  const subtitle = stage === "dispatch"
    ? "Bought but not yet dispatched — no customer, tracked separately from ready stock."
    : "Dispatched but not yet arrived — no customer, tracked separately from ready stock."
  const actionLabel = stage === "dispatch" ? "Mark dispatched" : "Mark arrived"
  const openItem = openRow != null ? items.find((i) => i.rowNumber === openRow) ?? null : null

  return (
    <div className="mt-4 rounded-xl border border-cream-border bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-cream-border bg-gray-50/80">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-gray-400">{subtitle}</div>
      </div>
      <div className="divide-y divide-cream-border">
        {items.map((it) => (
          <div key={it.rowNumber} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground truncate">{it.items}</div>
              <div className="text-xs text-gray-400">{it.event}</div>
            </div>
            <span className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] font-medium border ${REASON_CLASS[it.reason]}`}>
              {REASON_LABEL[it.reason]}
            </span>
            <span className="text-sm font-bold tabular-nums text-foreground w-12 text-right">{fmt(it.pending)}</span>
            <button
              type="button"
              onClick={() => setOpenRow(it.rowNumber)}
              className="text-xs font-medium text-brand hover:underline shrink-0"
            >
              {actionLabel}
            </button>
          </div>
        ))}
      </div>
      {openItem && (
        <MarkStageModal
          item={openItem}
          stage={stage}
          onClose={() => setOpenRow(null)}
          onSuccess={() => { setOpenRow(null); onMarked() }}
        />
      )}
    </div>
  )
}

function MarkStageModal({
  item,
  stage,
  onClose,
  onSuccess,
}: {
  item: ExcessTransitItem
  stage: Stage
  onClose: () => void
  onSuccess: () => void
}) {
  const [qty, setQty] = useState(String(item.pending))
  const [receipt, setReceipt] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const quantity = Math.max(0, Number(qty) || 0)
  const actionLabel = stage === "dispatch" ? "Mark dispatched" : "Mark arrived"

  async function handleSubmit() {
    if (quantity < 1) return
    setSaving(true)
    setError(null)
    try {
      const body: { qty: number; receipt?: string } = { qty: quantity }
      if (stage === "dispatch") body.receipt = receipt.trim()
      const res = await fetch(`/api/sheets/excess-purchase/${item.rowNumber}/${stage}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">{actionLabel}</div>
        <p className="text-sm text-gray-600">{item.items} — {item.event}</p>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Quantity <span className="text-gray-400">(pending: {item.pending})</span></span>
          <input
            type="number"
            min={1}
            max={item.pending}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            autoFocus
            className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </label>
        {stage === "dispatch" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Dispatch tracking <span className="text-gray-400 font-normal">(optional)</span></span>
            <input
              type="text"
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
              placeholder="e.g. TRK-001"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </label>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving || quantity < 1} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/excess-purchase/ExcessTable.tsx components/OverbuyTransitList.tsx
git commit -m "feat(ui): OverbuyTransitList component for in-transit overbuy rows"
```

---

### Task 11: Wire into `DispatchListClient.tsx`

**Files:**
- Modify: `app/dashboard/dispatch-list/DispatchListClient.tsx`

**Interfaces:**
- Consumes: `OverbuyTransitList` (Task 10), `excessPending` field on `GET /api/sheets/dispatch` (Task 5).

- [ ] **Step 1: Add state + import**

Add to the imports (near line 6-13):

```ts
import type { PaidStatus, DispatchListItem, DispatchListOrder, ExcessTransitItem } from "@/lib/db"
import OverbuyTransitList from "@/components/OverbuyTransitList"
```

Add state alongside the existing `items` state (`DispatchListClient.tsx:250`):

```ts
const [excessPending, setExcessPending] = useState<ExcessTransitItem[]>([])
```

- [ ] **Step 2: Capture it in `fetchItems`**

Change (`DispatchListClient.tsx:264-283`):

```ts
  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/dispatch?event=${encodeURIComponent(event)}`
      : "/api/sheets/dispatch"
    fetchJson<{ items: DispatchListItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        // Stores start collapsed (event headers + store headers visible, items
        // hidden). Only on an explicit load — a silent post-mutation refresh
        // leaves whatever the user has expanded alone.
        if (!silent) {
          setCollapsedStores(new Set(items.map((i) => `${i.event}|${i.store || "—"}`)))
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => { if (!silent) setLoading(false) })
  }, [])
```

to:

```ts
  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/dispatch?event=${encodeURIComponent(event)}`
      : "/api/sheets/dispatch"
    fetchJson<{ items: DispatchListItem[]; excessPending?: ExcessTransitItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        setExcessPending(data.excessPending ?? [])
        // Stores start collapsed (event headers + store headers visible, items
        // hidden). Only on an explicit load — a silent post-mutation refresh
        // leaves whatever the user has expanded alone.
        if (!silent) {
          setCollapsedStores(new Set(items.map((i) => `${i.event}|${i.store || "—"}`)))
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => { if (!silent) setLoading(false) })
  }, [])
```

- [ ] **Step 3: Render it below the grouped table/cards**

In the main return, insert right after the "Grouped cards (mobile)" block's closing `</div>` (`DispatchListClient.tsx:616`) and before `{dispatchingItem && (` (`DispatchListClient.tsx:618`):

```tsx
      <OverbuyTransitList
        items={excessPending}
        stage="dispatch"
        onMarked={() => fetchItems(selectedEvent || undefined, true)}
      />

```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual UI check**

Run `npm run dev`, log in, navigate to the Dispatch List page. With at least one `excess_purchase` row pending dispatch in the dev DB (from Task 1's backfill exclusion, or one created via Task 4/manual insert), confirm the "Overbuy in transit" section renders below the main table, "Mark dispatched" opens the modal, and submitting a valid quantity removes/reduces that row from the section (silently, without disrupting the main table's scroll position or any open modal there).

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/dispatch-list/DispatchListClient.tsx
git commit -m "feat(ui): show overbuy-in-transit rows on the Dispatch List page"
```

---

### Task 12: Wire into `ArrivalListClient.tsx`

**Files:**
- Modify: `app/dashboard/arrival-list/ArrivalListClient.tsx`

**Interfaces:**
- Consumes: `OverbuyTransitList` (Task 10), `excessPending` field on `GET /api/sheets/arrival-list` (Task 6).

- [ ] **Step 1: Add state + import**

Add near the existing imports (this file already imports `ArrivalListItem` from `@/lib/db` — add `ExcessTransitItem` to that same import line) plus:

```ts
import OverbuyTransitList from "@/components/OverbuyTransitList"
```

Add state alongside the existing `items` state (`ArrivalListClient.tsx:243`):

```ts
const [excessPending, setExcessPending] = useState<ExcessTransitItem[]>([])
```

- [ ] **Step 2: Capture it in `fetchItems`**

Change (`ArrivalListClient.tsx:257-276`):

```ts
  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/arrival-list?event=${encodeURIComponent(event)}`
      : "/api/sheets/arrival-list"
    fetchJson<{ items: ArrivalListItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        // Stores start collapsed (event headers + store headers visible, items
        // hidden). Only on an explicit load — a silent post-mutation refresh
        // leaves whatever the user has expanded alone.
        if (!silent) {
          setCollapsedStores(new Set(items.map((i) => `${i.event}|${i.store || "—"}`)))
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => { if (!silent) setLoading(false) })
  }, [])
```

to:

```ts
  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/arrival-list?event=${encodeURIComponent(event)}`
      : "/api/sheets/arrival-list"
    fetchJson<{ items: ArrivalListItem[]; excessPending?: ExcessTransitItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        setExcessPending(data.excessPending ?? [])
        // Stores start collapsed (event headers + store headers visible, items
        // hidden). Only on an explicit load — a silent post-mutation refresh
        // leaves whatever the user has expanded alone.
        if (!silent) {
          setCollapsedStores(new Set(items.map((i) => `${i.event}|${i.store || "—"}`)))
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => { if (!silent) setLoading(false) })
  }, [])
```

- [ ] **Step 3: Render it below the grouped table/cards**

Insert right after the "Grouped cards (mobile)" block's closing `</div>` (`ArrivalListClient.tsx:605`) and before `{arrivingItem && (` (`ArrivalListClient.tsx:607`):

```tsx
      <OverbuyTransitList
        items={excessPending}
        stage="arrive"
        onMarked={() => fetchItems(selectedEvent || undefined, true)}
      />

```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual UI check**

Same as Task 11 Step 5, but on the Receiving/Arrival List page, with a row that has `unit_dispatch` set and `unit_arrive` below it. Confirm "Mark arrived" works and the row clears once fully arrived.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/arrival-list/ArrivalListClient.tsx
git commit -m "feat(ui): show overbuy-awaiting-arrival rows on the Receiving List page"
```

---

## Self-Review Notes

- **Spec coverage:** visibility gap (Tasks 5-7, 10-12) ✅; migration + backfill per the user's LSJP202608-vs-rest split (Task 1) ✅; correctness bug in Apply surfaced by adding real transit tracking (Tasks 8-9) ✅; every `appendExcessPurchase` caller's semantics preserved with zero regression (Task 3) ✅; `returnOrderUnitsToExcess`'s existing "bought-but-not-yet-arrived" doc comment finally honored (Task 4) ✅.
- **Design decision on record:** overbuy-in-transit rows render in a separate section on each list page, not merged into the customer-order table — confirmed with the user via mockup comparison (excess rows have no customer, so merging would require faking one and reworking the FIFO fill-preview machinery for no benefit).
- **Out of scope, deliberately:** no "mark in-transit" toggle added to the manual "Add Inventory" form — every current manual/auto insert path except `returnOrderUnitsToExcess` genuinely is stock already in hand at insert time, so this wasn't part of the reported gap. If manually-entered future overbuys need this, that's a follow-up, not bundled here.
