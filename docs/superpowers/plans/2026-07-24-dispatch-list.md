# Dispatch List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a `unit_dispatch` stage between buy and arrive in the order lifecycle, with its own Dispatch List page, re-gate the arrival list on dispatch, and mark applied excess as buy=dispatch=arrive.

**Architecture:** Clone the shopping-list step pattern (page + client + modal + db module + route) for dispatch. Re-gate arrival on `unit_dispatch`. Backfill `unit_dispatch = unit_buy` on existing rows so the cutover is seamless.

**Tech Stack:** Next.js 16 App Router, postgres.js (raw SQL, `prepare:false`), local Supabase dev DB (127.0.0.1:54322), tsx for runtime tests, `tsc --noEmit` for typecheck.

## Global Constraints

- No unit-test framework. "Test" = `npx tsc --noEmit` (must exit 0) + `tsx` runtime scripts run with `node --env-file=.env.development.local --import=tsx <script>` (local DB only; each script guards host is 127.0.0.1, seeds, asserts, cleans up) + `psql` checks via `/opt/homebrew/opt/libpq/bin/psql "$LOCAL"` where `LOCAL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- Migrations applied to local with `supabase migration up`. Push to prod BEFORE deploying code.
- Lifecycle invariant (by convention, not DB-enforced): `unit_arrive ≤ unit_dispatch ≤ unit_buy ≤ unit`.
- Follow existing patterns; raw SQL via `sql` from `lib/db-pool`; barrel is `lib/db.ts` (`export * from "./db/<module>"`).
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Current branch state (`dispatch-column`)

Already present (uncommitted) from the standalone-column work — verify, don't redo:
- Migration `048_orders_unit_dispatch.sql` (adds `orders.unit_dispatch INTEGER`, applied to local).
- `lib/db/types.ts` FormRow has `unitDispatch: number | null`.
- `lib/db/orders.ts`: `mapFormRow` sets `unitDispatch`; paginated SELECT includes `o.unit_dispatch`; SORT_COLUMNS has `unitDispatch`; `updateOrderOwnerCell` accepts `"unit_dispatch"`.
- `app/api/sheets/duplicate-form/[row]/route.ts`: owner_cell allows `unit_dispatch`.
- `app/dashboard/list-order/DataTable.tsx`: editable Dispatch column exists (after Ship), `handleCellSave` typed, `initialVisibility` has `unitDispatch:false`.

Design spec: `docs/superpowers/specs/2026-07-24-dispatch-list-design.md`.

## File Structure

- `supabase/migrations/049_orders_dispatch_receipt_backfill.sql` — CREATE: `dispatch_receipt` column + backfill.
- `lib/db/types.ts` — MODIFY: FormRow `dispatchReceipt`; add `DispatchUpdate`.
- `lib/db/orders.ts` — MODIFY: mapFormRow `dispatchReceipt`; paginated SELECT `o.dispatch_receipt`; `bulkUpdateDispatch`; clamp in `returnOrderUnitsToExcess`.
- `lib/db/dispatch.ts` — CREATE: `getDispatchList`, `DispatchListItem`, `DispatchListOrder`.
- `lib/db/fulfillment.ts` — MODIFY: `getArrivalList` re-gate buy→dispatch.
- `lib/db.ts` — MODIFY: `export * from "./db/dispatch"`.
- `app/api/sheets/dispatch/route.ts` — CREATE: POST apply-dispatch.
- `app/dashboard/dispatch-list/{page,DispatchListClient,DispatchModal,loading}.tsx` — CREATE (clone of shopping-list).
- `app/api/sheets/excess-purchase/route.ts` + `[row]/route.ts` — MODIFY: add dispatch bump.
- `app/dashboard/list-order/DataTable.tsx` — MODIFY: reposition Dispatch column between Buy/Arrive; add hidden `dispatchReceipt` column.
- `components/SidebarClient.tsx`, `components/MobileNavClient.tsx` — MODIFY: "Dispatch List" nav entry.

---

### Task 1: Schema — `dispatch_receipt` + backfill

**Files:**
- Create: `supabase/migrations/049_orders_dispatch_receipt_backfill.sql`

**Interfaces:**
- Produces: `orders.dispatch_receipt TEXT NOT NULL DEFAULT ''`; existing rows have `unit_dispatch = unit_buy` where bought.

- [ ] **Step 1: Write the migration**

```sql
-- Dispatch tracking reference + backfill unit_dispatch for existing rows.
-- Backfill treats every already-bought unit as already dispatched, so the
-- re-gated arrival list (arrive < dispatch) behaves exactly as before
-- (arrive < buy) for in-flight orders, and the Dispatch List starts empty.
ALTER TABLE orders ADD COLUMN dispatch_receipt TEXT NOT NULL DEFAULT '';
UPDATE orders SET unit_dispatch = unit_buy WHERE unit_buy IS NOT NULL;
```

- [ ] **Step 2: Apply to local + verify**

Run:
```bash
supabase migration up
PGBIN=/opt/homebrew/opt/libpq/bin; LOCAL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
$PGBIN/psql "$LOCAL" -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name='dispatch_receipt';"
$PGBIN/psql "$LOCAL" -tAc "SELECT count(*) FROM orders WHERE unit_buy IS NOT NULL AND unit_dispatch IS DISTINCT FROM unit_buy;"
```
Expected: prints `dispatch_receipt`, then `0` (all bought rows backfilled).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/048_orders_unit_dispatch.sql supabase/migrations/049_orders_dispatch_receipt_backfill.sql
git commit -m "feat(dispatch): add unit_dispatch + dispatch_receipt columns, backfill dispatch=buy"
```
(048 is folded in here since it was uncommitted.)

---

### Task 2: `dispatch_receipt` on FormRow + list-order plumbing

**Files:**
- Modify: `lib/db/types.ts` (FormRow), `lib/db/orders.ts` (mapFormRow, paginated SELECT)

**Interfaces:**
- Produces: `FormRow.dispatchReceipt: string`.

- [ ] **Step 1: Add field to FormRow**

In `lib/db/types.ts`, in the FormRow interface after `unitDispatch: number | null`:
```ts
  dispatchReceipt: string
```

- [ ] **Step 2: Map it**

In `lib/db/orders.ts` `mapFormRow`, after the `unitDispatch:` line:
```ts
    dispatchReceipt: (r.dispatch_receipt as string) ?? "",
```

- [ ] **Step 3: Select it in the paginated query**

In `lib/db/orders.ts` `getDuplicateFormRowsPaginated` dataQuery, change the lifecycle select line to include `o.dispatch_receipt`:
```
            o.unit_arrive, o.unit_ship, o.unit_dispatch, o.dispatch_receipt, o.unit_hold,
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit; echo EXIT=$?`
Expected: `EXIT=0` (any other literal-FormRow construction sites will surface here; add `dispatchReceipt: ""` to them if flagged).

- [ ] **Step 5: Commit**

```bash
git add lib/db/types.ts lib/db/orders.ts
git commit -m "feat(dispatch): surface dispatch_receipt on FormRow"
```

---

### Task 3: `DispatchUpdate` type + `bulkUpdateDispatch`

**Files:**
- Modify: `lib/db/types.ts` (add DispatchUpdate), `lib/db/orders.ts` (add bulkUpdateDispatch)
- Test: `scratchpad/test-bulk-dispatch.ts`

**Interfaces:**
- Produces: `DispatchUpdate { rowNumber: number; unitDispatch: number; dispatchReceipt: string }`; `bulkUpdateDispatch(updates: DispatchUpdate[], db?): Promise<void>`.

- [ ] **Step 1: Add the type**

In `lib/db/types.ts` after `ArriveUpdate`:
```ts
export interface DispatchUpdate {
  rowNumber: number
  unitDispatch: number
  dispatchReceipt: string
}
```

- [ ] **Step 2: Add the bulk fn** (mirror `bulkUpdatePurchase`)

In `lib/db/orders.ts` after `bulkUpdateArrive`, add (and import `DispatchUpdate` in the existing type import from `./types`):
```ts
export async function bulkUpdateDispatch(updates: DispatchUpdate[], db: DBExecutor = sql): Promise<void> {
  if (updates.length === 0) return
  const ids = updates.map((u) => u.rowNumber)
  const dispatches = updates.map((u) => u.unitDispatch)
  const receipts = updates.map((u) => u.dispatchReceipt)
  await db`
    UPDATE orders SET
      unit_dispatch = data.unit_dispatch,
      dispatch_receipt = data.dispatch_receipt,
      updated_at = NOW()
    FROM unnest(${ids}::int[], ${dispatches}::int[], ${receipts}::text[])
      AS data(id, unit_dispatch, dispatch_receipt)
    WHERE orders.id = data.id
  `
}
```

- [ ] **Step 3: Write runtime test** `scratchpad/test-bulk-dispatch.ts`

```ts
import sql from "@/lib/db-pool"
import { bulkUpdateDispatch } from "@/lib/db"
const CUST = "__t_bd__"; let orderId = 0
const A = (c: boolean, m: string) => { console.log(`${c?"PASS":"FAIL"}: ${m}`); if(!c) process.exitCode = 1 }
async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/]+)\//)?.[1] ?? ""
  if (!/(localhost|127\.0\.0\.1)/.test(host)) throw new Error("non-local host")
  const [ev] = await sql`SELECT name FROM events LIMIT 1`
  const [p] = await sql`SELECT id FROM products LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${CUST}) ON CONFLICT DO NOTHING`
  const [o] = await sql`INSERT INTO orders (event,customer,product_id,unit_price,unit,unit_buy) VALUES (${ev.name},${CUST},${p.id},0,5,5) RETURNING id`
  orderId = o.id
  await bulkUpdateDispatch([{ rowNumber: orderId, unitDispatch: 3, dispatchReceipt: "TRK1" }])
  const [r] = await sql`SELECT unit_dispatch, dispatch_receipt FROM orders WHERE id=${orderId}`
  A(r.unit_dispatch === 3, `unit_dispatch=3 (got ${r.unit_dispatch})`)
  A(r.dispatch_receipt === "TRK1", `dispatch_receipt=TRK1 (got ${r.dispatch_receipt})`)
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
  .finally(async () => { if(orderId) await sql`DELETE FROM orders WHERE id=${orderId}`; await sql`DELETE FROM customers WHERE instagram_id=${CUST}`; await sql.end() })
```

- [ ] **Step 4: Run test**

Run: `npx tsc --noEmit && node --env-file=.env.development.local --import=tsx scratchpad/test-bulk-dispatch.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/types.ts lib/db/orders.ts
git commit -m "feat(dispatch): add DispatchUpdate + bulkUpdateDispatch"
```

---

### Task 4: `lib/db/dispatch.ts` — `getDispatchList` + barrel export

**Files:**
- Create: `lib/db/dispatch.ts`
- Modify: `lib/db.ts`
- Test: `scratchpad/test-dispatch-list.ts`

**Interfaces:**
- Consumes: `bulkUpdateDispatch` (Task 3).
- Produces: `getDispatchList(event?: string): Promise<DispatchListItem[]>`; `DispatchListItem`, `DispatchListOrder` (same shape as ShoppingListItem/Order but pending = `unit_buy − unit_dispatch`).

- [ ] **Step 1: Read the clone source**

Read `lib/db/shopping-list.ts` lines 29–195 (`ShoppingListOrder`, `ShoppingListItem`, `getShoppingList`). The dispatch versions are identical in shape; only the gate and the "total available" change:
- gate `(o.unit_buy IS NULL OR o.unit_buy < o.unit)` → `(o.unit_buy IS NOT NULL AND (o.unit_dispatch IS NULL OR o.unit_dispatch < o.unit_buy))`
- `pending = o.unit − COALESCE(o.unit_buy,0)` → `o.unit_buy − COALESCE(o.unit_dispatch,0)`
- `total_pending = SUM(o.unit − COALESCE(o.unit_buy,0))` → `SUM(o.unit_buy − COALESCE(o.unit_dispatch,0))`
- the "total_original" subquery (SUM(unit)) → `SUM(unit_buy)` filtered to `unit_buy IS NOT NULL`
- per-order JSON: expose `unitBuy` (the cap) and `unitDispatch` (done so far) and `pending`
- `HAVING SUM(o.unit_buy − COALESCE(o.unit_dispatch,0)) > 0`

- [ ] **Step 2: Write `lib/db/dispatch.ts`**

Create the file with `DispatchListOrder`, `DispatchListItem`, and `getDispatchList(event?)` — a copy of `getShoppingList` with the substitutions above. Fields: `DispatchListItem { event, productId, productName, store, totalUnits /* remaining to dispatch = buy-dispatch */, totalOriginal /* SUM(unit_buy) */, customerCount, customers, orderIds, orders }`; `DispatchListOrder { rowNumber, customer, unitBuy, unitDispatch, pending, ... }`. Match the exact select/group/order-by structure of `getShoppingList` (both per-event and all-events branches).

- [ ] **Step 3: Export from barrel**

In `lib/db.ts`, add after the shopping-list export:
```ts
export * from "./db/dispatch"
```

- [ ] **Step 4: Write runtime test** `scratchpad/test-dispatch-list.ts`

Seed: customer + one order `unit=5, unit_buy=5, unit_dispatch=NULL` on an event. Assert:
- `getDispatchList(event)` includes the product (pending 5).
- After `bulkUpdateDispatch([{rowNumber, unitDispatch:5, dispatchReceipt:""}])`, `getDispatchList(event)` no longer includes it.
(Model on `scratchpad/test-dispatch.ts` structure; guard host, cleanup.)

- [ ] **Step 5: Run**

Run: `npx tsc --noEmit && node --env-file=.env.development.local --import=tsx scratchpad/test-dispatch-list.ts`
Expected: PASS (present before, gone after).

- [ ] **Step 6: Commit**

```bash
git add lib/db/dispatch.ts lib/db.ts
git commit -m "feat(dispatch): getDispatchList + DispatchListItem, barrel export"
```

---

### Task 5: Re-gate arrival list on `unit_dispatch`

**Files:**
- Modify: `lib/db/fulfillment.ts` (`getArrivalList`, both branches)
- Test: `scratchpad/test-arrival-regate.ts`

**Interfaces:**
- Consumes: `getArrivalList`, `bulkUpdateDispatch`, `bulkUpdateArrive`.

- [ ] **Step 1: Change the gate math** (both the per-event and all-events branches of `getArrivalList`)

Replace every `unit_buy`-based gating expression with `unit_dispatch`:
- `WHERE o.unit_buy IS NOT NULL` → `WHERE o.unit_dispatch IS NOT NULL`
- `(o.unit_arrive IS NULL OR o.unit_arrive < o.unit_buy)` → `... < o.unit_dispatch`
- `SUM(o.unit_buy - COALESCE(o.unit_arrive, 0))` → `SUM(o.unit_dispatch - COALESCE(o.unit_arrive, 0))` (total_pending and HAVING)
- `SUM(o.unit_buy)::int AS total_bought` → `SUM(o.unit_dispatch)::int AS total_bought`
- per-order JSON `'unitBuy', o.unit_buy` → `'unitBuy', o.unit_dispatch` and `'pending', o.unit_buy - COALESCE(o.unit_arrive,0)` → `... o.unit_dispatch - ...`

Add a comment: `-- Arrival gates on unit_dispatch (dispatched stock is what can be received); 'unitBuy' JSON key carries the dispatched count.`

- [ ] **Step 2: Write runtime test** `scratchpad/test-arrival-regate.ts`

Seed customer + order `unit=5, unit_buy=5, unit_dispatch=NULL`. Assert:
- `getArrivalList(event)` does NOT include product (nothing dispatched).
- `bulkUpdateDispatch([{rowNumber, unitDispatch:5, dispatchReceipt:""}])` → `getArrivalList(event)` includes it, pending 5.
- `bulkUpdateArrive([{rowNumber, unitArrive:5}])` → gone from arrival.

- [ ] **Step 3: Run**

Run: `npx tsc --noEmit && node --env-file=.env.development.local --import=tsx scratchpad/test-arrival-regate.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/db/fulfillment.ts
git commit -m "feat(dispatch): re-gate arrival list on unit_dispatch"
```

---

### Task 6: Dispatch apply API route

**Files:**
- Create: `app/api/sheets/dispatch/route.ts`

**Interfaces:**
- Consumes: `getDispatchList` OR `getDuplicateFormRowsForEvent`, `bulkUpdateDispatch`, `withActor`, `requireSession`, `requireRole`.
- Produces: `POST /api/sheets/dispatch` accepting `{ event, receipt, allocations|orderIds }` and setting `unit_dispatch` (+ `dispatch_receipt`).

- [ ] **Step 1: Read the clone source**

Read `app/api/sheets/purchasing/route.ts` (130 lines). Mirror its POST: validate, derive updates server-side (never trust client caps), combine receipts, call the bulk fn via `withActor`.

- [ ] **Step 2: Write the route**

Create `app/api/sheets/dispatch/route.ts` mirroring purchasing but: caps come from `unit_buy` (not `unit`), it sets `unit_dispatch` via `bulkUpdateDispatch`, and writes `dispatch_receipt` (combined like purchasing combines `receipt`). Role guard = same as purchasing (`requireRole`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit; echo EXIT=$?`
Expected: `EXIT=0`.

- [ ] **Step 4: Commit**

```bash
git add app/api/sheets/dispatch/route.ts
git commit -m "feat(dispatch): POST /api/sheets/dispatch apply route"
```

---

### Task 7: Dispatch List page (clone shopping-list)

**Files:**
- Create: `app/dashboard/dispatch-list/{page,DispatchListClient,DispatchModal,loading}.tsx`

**Interfaces:**
- Consumes: `getDispatchList` (page.tsx server fetch), `POST /api/sheets/dispatch` (client).

- [ ] **Step 1: Clone the four files**

Copy `app/dashboard/shopping-list/{page,ShoppingListClient,PurchaseModal,loading}.tsx` to `app/dashboard/dispatch-list/{page,DispatchListClient,DispatchModal,loading}.tsx`.

- [ ] **Step 2: Adapt names + data source**

In the clones, apply these mechanical transforms:
- Rename components: `ShoppingListClient`→`DispatchListClient`, `PurchaseModal`→`DispatchModal`; update imports.
- `page.tsx`: fetch `getDispatchList` instead of `getShoppingList`; pass to `DispatchListClient`.
- Client: types `ShoppingListItem`→`DispatchListItem`; labels "Shopping List"/"Purchase"→"Dispatch List"/"Dispatch"; the pending field is "to dispatch".
- Modal: POST to `/api/sheets/dispatch`; the receipt field label → "Dispatch tracking" (writes `dispatch_receipt`); quantity capped at each order's `pending` (`unit_buy − unit_dispatch`).
- Remove any buy-only concepts not applicable (e.g. out-of-stock marking) unless they map cleanly; keep the select + bulk-apply UX.

- [ ] **Step 3: Typecheck + dev smoke**

Run: `npx tsc --noEmit; echo EXIT=$?`
Expected: `EXIT=0`. Then load `/dashboard/dispatch-list` in `npm run dev` (dev DB): page renders, lists a seeded bought-not-dispatched order, dispatch modal writes and the row leaves the list.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/dispatch-list/
git commit -m "feat(dispatch): Dispatch List page (clone of shopping-list)"
```

---

### Task 8: Navigation entry

**Files:**
- Modify: `components/SidebarClient.tsx`, `components/MobileNavClient.tsx`

- [ ] **Step 1: Add sidebar link**

In `components/SidebarClient.tsx`, add a nav entry between the "Shopping List" (`/dashboard/shopping-list`) and "Receiving List" (`/dashboard/arrival-list`) items:
```tsx
{ href: "/dashboard/dispatch-list", label: "Dispatch List", icon: (/* pick an existing-style truck/send SVG */) },
```
Match the surrounding object shape (roles, icon markup) exactly.

- [ ] **Step 2: Add mobile nav link**

In `components/MobileNavClient.tsx`, add the same `/dashboard/dispatch-list` entry in the corresponding position, matching that file's item shape.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit; echo EXIT=$?`
Expected: `EXIT=0`.

- [ ] **Step 4: Commit**

```bash
git add components/SidebarClient.tsx components/MobileNavClient.tsx
git commit -m "feat(dispatch): add Dispatch List nav entry"
```

---

### Task 9: Excess apply marks dispatched too

**Files:**
- Modify: `app/api/sheets/excess-purchase/[row]/route.ts`, `app/api/sheets/excess-purchase/route.ts`
- Test: `scratchpad/test-excess-dispatch.ts`

**Interfaces:**
- Consumes: `bulkUpdateDispatch`.

- [ ] **Step 1: Per-row route** (`[row]/route.ts`)

Import `bulkUpdateDispatch`. In the apply loop, each update already computes `allocate`; add `unitDispatch: (r.unitDispatch ?? 0) + allocate` to the pushed update object. In the atomic `withActor(async tx => {...})`, after `bulkUpdateArrive`, add:
```ts
await bulkUpdateDispatch(
  updates.map(({ rowNumber: rn, unitDispatch }) => ({ rowNumber: rn, unitDispatch, dispatchReceipt: "" })),
  tx,
)
```
(Applied excess dispatch carries no tracking; empty string is fine.)

- [ ] **Step 2: Bulk route** (`route.ts`)

Import `bulkUpdateDispatch`. Alongside `origUnitArrive`, capture original dispatch: `const origUnitDispatch = new Map<number,number>(); for (const r of formRows) origUnitDispatch.set(r.rowNumber, r.unitDispatch ?? 0)`. In the atomic write block, after `bulkUpdateArrive`, add a `bulkUpdateDispatch` over `entries` with `unitDispatch: (origUnitDispatch.get(rowNumber) ?? 0) + (d.unitBuy - d.oldUnitBuy)` and `dispatchReceipt: ""`.
(Requires `FormRow.unitDispatch`, already present.)

- [ ] **Step 3: Runtime test** `scratchpad/test-excess-dispatch.ts`

Seed customer + order `unit=5, unit_buy=0, unit_dispatch=NULL, unit_arrive=NULL` + excess row (event, product, unit_buy 5, reason manual). Mirror the real per-row apply: `bulkUpdatePurchase([{rowNumber,unitBuy:5,receipt:""}])`, `bulkUpdateArrive([{rowNumber,unitArrive:5}])`, `bulkUpdateDispatch([{rowNumber,unitDispatch:5,dispatchReceipt:""}])`. Assert: order `unit_buy=unit_dispatch=unit_arrive=5`; gone from `getShoppingList`, `getDispatchList`, `getArrivalList`.

- [ ] **Step 4: Run**

Run: `npx tsc --noEmit && node --env-file=.env.development.local --import=tsx scratchpad/test-excess-dispatch.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/sheets/excess-purchase/route.ts "app/api/sheets/excess-purchase/[row]/route.ts"
git commit -m "feat(dispatch): applied excess marks buy=dispatch=arrive"
```

---

### Task 10: List Order — reposition Dispatch + hidden dispatch_receipt column; invariant clamp

**Files:**
- Modify: `app/dashboard/list-order/DataTable.tsx`, `lib/db/orders.ts` (`returnOrderUnitsToExcess`)
- Test: `scratchpad/test-return-clamp.ts`

- [ ] **Step 1: Reposition the Dispatch column**

In `DataTable.tsx`, move the existing `unitDispatch` column object so it sits between the `unitBuy` column and the `unitArrive` column (currently it's after `unitShip`). Keep its definition identical.

- [ ] **Step 2: Add hidden read-only `dispatchReceipt` column**

After the `receipt` column (or near the note column), add:
```tsx
{
  accessorKey: "dispatchReceipt",
  header: "Dispatch Ref",
  enableColumnFilter: false,
  size: 140,
  cell: ({ getValue }) => {
    const v = getValue<string>()
    return <span className="whitespace-nowrap">{v || "—"}</span>
  },
},
```
And in `initialVisibility`, add `dispatchReceipt: false`.

- [ ] **Step 3: Clamp `unit_dispatch` in `returnOrderUnitsToExcess`**

In `lib/db/orders.ts`, in the `excessUnits > 0` UPDATE (the one that sets `unit = ${newUnit}, unit_buy = ${unitBuy - excessUnits}`), add a dispatch clamp:
```sql
      SET unit = ${newUnit}, unit_buy = ${unitBuy - excessUnits},
          unit_dispatch = LEAST(COALESCE(unit_dispatch, 0), ${newUnit}), updated_at = NOW()
```

- [ ] **Step 4: Runtime test** `scratchpad/test-return-clamp.ts`

Seed order `unit=10, unit_buy=10, unit_dispatch=10, unit_arrive=0`. Call `returnOrderUnitsToExcess(orderId, 4)` (newUnit=6). Assert order `unit=6, unit_buy=6, unit_dispatch=6` (clamped, not 10). Cleanup order + any excess row created.

- [ ] **Step 5: Run + typecheck**

Run: `npx tsc --noEmit && node --env-file=.env.development.local --import=tsx scratchpad/test-return-clamp.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/list-order/DataTable.tsx lib/db/orders.ts
git commit -m "feat(dispatch): reposition Dispatch column, add dispatch_receipt column, clamp on return-to-excess"
```

---

### Task 11: Full-flow integration test + reset check

**Files:**
- Test: `scratchpad/test-dispatch-flow.ts`

- [ ] **Step 1: Write end-to-end test**

Seed customer + order `unit=5` (unbought). Walk the chain via the bulk fns and assert list membership at each step:
1. `getShoppingList` has it; `getDispatchList` / `getArrivalList` don't.
2. `bulkUpdatePurchase(unitBuy:5)` → in `getDispatchList`, not in shopping/arrival.
3. `bulkUpdateDispatch(unitDispatch:5)` → in `getArrivalList`, not in dispatch.
4. `bulkUpdateArrive(unitArrive:5)` → in none of the three.
Cleanup.

- [ ] **Step 2: Run**

Run: `npx tsc --noEmit && node --env-file=.env.development.local --import=tsx scratchpad/test-dispatch-flow.ts`
Expected: all PASS.

- [ ] **Step 3: Reset check (migrations reproducible)**

Run: `supabase db reset && ./scripts/seed-local.sh`
Expected: migrations 000→049 apply clean; reference data reseeds. (Confirms 048+049 replay from scratch.)

- [ ] **Step 4: Commit test**

```bash
git add scratchpad/test-dispatch-flow.ts 2>/dev/null || true
git commit -m "test(dispatch): full lifecycle flow integration test" --allow-empty
```

---

## Deploy (after all tasks, when merging to prod)

1. `supabase db push --dry-run` → confirm 046, 047, 048, 049 listed → `supabase db push` (migrations FIRST).
2. Deploy code. The backfill makes the arrival re-gate seamless for in-flight orders.

## Self-Review

**Spec coverage:** data model (T1,T2,T3), lifecycle re-gate (T4 dispatch gate, T5 arrival gate), Dispatch List page (T6 route, T7 page), excess apply three-way (T9), List Order reposition + hidden dispatch_receipt (T10), nav (T8), migrations/deploy order (T1, Deploy), edge-case clamp (T10), testing (each task + T11). All spec sections mapped.

**Placeholder scan:** clone tasks (T7) reference source files with exact transforms rather than pasting 1600 lines — acceptable for a mechanical clone; the substitution list is concrete. No TBD/TODO.

**Type consistency:** `DispatchUpdate {rowNumber, unitDispatch, dispatchReceipt}` used consistently in `bulkUpdateDispatch` (T3), dispatch route (T6), excess routes (T9). `FormRow.dispatchReceipt` (T2) used in T10 column. `getDispatchList`/`DispatchListItem` (T4) used in T5/T7/T9/T11.
