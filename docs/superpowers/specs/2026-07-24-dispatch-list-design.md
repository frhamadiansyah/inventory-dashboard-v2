# Dispatch step + Dispatch List page — design

Date: 2026-07-24
Branch: `dispatch-column`

## Goal

Insert a **dispatch** stage into the order fulfillment lifecycle, between "buy"
and "arrive", and give it its own step-page (mirroring the Shopping List page).

New lifecycle:

```
unit → unit_buy → unit_dispatch → unit_arrive → unit_ship
```

Business meaning: an item is bought from the store (`unit_buy`), dispatched by
the store/forwarder (`unit_dispatch`), arrives at our warehouse (`unit_arrive`),
then ships to the customer (`unit_ship`).

Invariant (by convention, not DB-enforced — matches how buy/arrive work today):
`unit_arrive ≤ unit_dispatch ≤ unit_buy ≤ unit`.

## Approach

**A — clone the shopping-list pattern.** The codebase already has one
page + route + db-module per lifecycle step (shopping-list = buy,
arrival-list = arrive, ship = ship). The dispatch step gets the same treatment:
a parallel page, route, and db module. Chosen over generalizing buy/dispatch
into one component (risky refactor of a working flow) or bolting dispatch onto
the arrival page (muddies two steps).

## Data model

- `orders.unit_dispatch INTEGER` — already added in migration 048 (nullable).
- `orders.dispatch_receipt TEXT NOT NULL DEFAULT ''` — NEW. Dispatch
  tracking/reference (e.g. forwarder/courier tracking no.), separate from the
  purchase `receipt`. Mirrors the `receipt` column's shape.
- **Backfill** (same migration as `dispatch_receipt`):
  `UPDATE orders SET unit_dispatch = unit_buy WHERE unit_buy IS NOT NULL;`
  Effect: every already-bought unit counts as already dispatched, so the
  re-gated arrival list behaves exactly as today for in-flight orders, and the
  Dispatch List starts empty. The dispatch step applies to new work going
  forward.

## Lifecycle re-gating (queries)

- **Shopping List (buy)** — unchanged: `unit_buy IS NULL OR unit_buy < unit`;
  pending = `unit − unit_buy`.
- **Dispatch List (new)**: `unit_dispatch IS NULL OR unit_dispatch < unit_buy`
  (and `unit_buy IS NOT NULL`); pending = `unit_buy − COALESCE(unit_dispatch,0)`.
- **Arrival / Receiving List** — CHANGE gate from `unit_arrive < unit_buy` to
  `unit_arrive < unit_dispatch`; pending = `unit_dispatch − COALESCE(unit_arrive,0)`;
  `total_bought` sums switch from `unit_buy` to `unit_dispatch` where they gate
  arrival. (`lib/db/fulfillment.ts` `getArrivalList`, both the per-event and
  all-events branches.)
- **Packing / Ship** — unchanged (arrived → shipped).

## Dispatch List page (`/dashboard/dispatch-list`)

Mirrors `app/dashboard/shopping-list/`:

- `page.tsx` — server component, owner/role guard, fetches events + list.
- `DispatchListClient.tsx` — grouped by event+product, event filter, search,
  select + "Dispatch" bulk action, mobile cards. Cloned from `ShoppingListClient`.
- `DispatchModal.tsx` — cloned from `PurchaseModal`; captures **quantity
  dispatched + dispatch tracking (`dispatch_receipt`)**; writes `unit_dispatch`
  and appends/combines `dispatch_receipt`.
- `loading.tsx`.

Data + API:

- `lib/db/dispatch.ts` (new): `getDispatchList(event?)` returning
  `DispatchListItem[]` (same shape as `ShoppingListItem`, pending computed
  against `unit_buy`); `bulkUpdateDispatch(updates)` setting `unit_dispatch`
  (+ `dispatch_receipt`) on orders (unnest bulk update, mirroring
  `bulkUpdatePurchase`).
- `app/api/sheets/dispatch/route.ts` (new): `POST` — role-guarded, validates
  allocations, calls `bulkUpdateDispatch` via `withActor`. Follows the
  purchasing route shape.

## Excess apply (both paths)

`app/api/sheets/excess-purchase/route.ts` and `.../[row]/route.ts` currently set
`unit_buy` + `unit_arrive` on apply (in-hand stock). Add `unit_dispatch` so
applied excess sets **buy = dispatch = arrive** — keeps the chain consistent and
drops the item off shopping, dispatch, and arrival lists. Uses a new
`bulkUpdateDispatch` (or extends the existing atomic tx) alongside
`bulkUpdatePurchase` + `bulkUpdateArrive`.

## List Order table (`app/dashboard/list-order/DataTable.tsx`)

- **Reposition** the editable Dispatch column to sit **between Buy and Arrive**
  (matches the lifecycle order). Editable inline (owner), hidden by default.
- **Add** a hidden, read-only `dispatchReceipt` column (like the `receipt`
  column). Requires `dispatchReceipt` on `FormRow` + `mapFormRow` + the
  paginated SELECT.
- `initialVisibility`: `unitDispatch: false`, `dispatchReceipt: false`.

## Navigation

Add "Dispatch List" (`/dashboard/dispatch-list`) between "Shopping List" and
"Receiving List" in both `components/SidebarClient.tsx` and
`components/MobileNavClient.tsx`. New icon.

## Migrations & deploy order

- 048 (already applied local): `orders.unit_dispatch`.
- 049 (new): `orders.dispatch_receipt` + the `unit_dispatch = unit_buy` backfill.
- Push migrations to prod **before** deploying code — the re-gated arrival
  query reads `unit_dispatch`, which must be backfilled first, or in-flight
  orders would drop off the arrival list. `supabase db push --dry-run` → push,
  then deploy.

## Edge cases / invariants

- `dispatch_receipt` NOT NULL DEFAULT '' — no null handling needed on read.
- Owner-cell edits of lifecycle quantities are NOT hard-clamped today (arrive can
  exceed buy in principle); keep parity — do not add strict clamping for
  dispatch. The invariant is maintained by workflow, as with buy/arrive.
- `returnOrderUnitsToExcess` (shrinking an order) reads unit_buy/unit_arrive;
  when it reduces `unit_buy`, `unit_dispatch` may exceed the new `unit_buy`.
  Clamp `unit_dispatch = LEAST(unit_dispatch, new unit_buy)` there to preserve
  the invariant. (Small, targeted addition.)

## Testing (local, seeded orders — tsx scripts like the excess test)

1. Backfill: existing bought rows get `unit_dispatch = unit_buy`; arrival list
   membership unchanged before/after migration.
2. Dispatch List gate: bought-not-dispatched order appears; after dispatch it
   leaves the Dispatch List and enters the Arrival List.
3. Arrival re-gate: an order not yet dispatched does NOT appear in Arrival;
   appears only once dispatched.
4. Dispatch modal write: sets `unit_dispatch` + `dispatch_receipt`.
5. Excess apply: sets buy = dispatch = arrive; gone from all three lists.
6. List Order: Dispatch column editable round-trip (already verified for 048);
   `dispatch_receipt` surfaces read-only.

## Out of scope

- No changes to the buy (shopping-list) or ship flows beyond the arrival re-gate.
- No dashboard/analytics changes for the dispatch stage.
- No strict DB-level enforcement of the lifecycle invariant.
