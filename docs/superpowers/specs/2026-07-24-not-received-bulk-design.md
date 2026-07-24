# Bulk "Not Received" — Receiving List — Design

**Date:** 2026-07-24
**Branch:** `not-received-bulk`

## Goal

Add a **Not Received** action to the Receiving List multi-select selection bar
(between *Received* and *Clear*). It opens a modal with four tabs — **Wrong ·
Broken · Missing · Cancelled** — that records a delivery problem against every
selected item at once, with a per-item editable quantity. This is the bulk
counterpart to the per-item problem flow that already lives in `ArriveModal`
(the box icon on each row), which stays unchanged.

## Background (existing code)

- Receiving List page: `app/dashboard/arrival-list/ArrivalListClient.tsx`.
  - Selection bar today: `Received` (opens `ConfirmReceivePanel`, bulk) + `Clear`.
  - `ConfirmReceivePanel` is the pattern to mirror: per-item qty rows grouped by
    event, fires one `POST /api/sheets/arrival-list` per selected item via
    `Promise.allSettled`, shows a per-item partial-failure list.
  - `ArriveModal` (per item) already has the 5 tabs Arrived/Wrong/Broken/Missing/
    Cancelled and their SKU picker / qty / per-order checkboxes. **Left as-is.**
- API `app/api/sheets/arrival-list/route.ts` POST actions:
  `wrong_product`, `broken`, `missing`, `customer_cancelled` — each per product,
  each cancels **whole** orders via `cancelOrderIds`.
- DB (`lib/db/orders.ts`): `recordWrongProduct`, `recordBrokenArrival`,
  `recordMissingArrival`, `recordCustomerCancellation` — all call
  `cancelOrderLines` (zeroes whole orders) and log inventory via
  `appendExcessPurchase({ reason })`. `cancelOrderUnits` does a **partial**
  single-order cancel but hard-logs the reclaimed units as
  `customer_cancelled`.
- Inventory reasons in use: `wrong_product`, `broken`, `customer_cancelled`,
  `overbuy`, `manual` (`ExcessReason`).
- Apply-excess-to-orders **skips `broken`** at
  `app/api/sheets/excess-purchase/route.ts:32`
  (`.filter((r) => r.reason !== "broken")`) — i.e. broken rows are unassignable.
- Priority allocation helpers: `compareOrderPriority` (`lib/db/shopping-list.ts`)
  and `allocateFifo` (`lib/fifo-fill.ts`), already used by the receive path.

## Semantics — Option Y (qty-scoped, partial refunds, leftover stays pending)

For each selected item the operator sets **`qty` = units affected** (default =
`totalPending`, editable, capped at pending). The action cancels **exactly
`qty` units**, allocated across that item's orders by the existing priority
(paid → partial → unpaid, then order id), **allowing partial-order
cancellation**. Any leftover (`pending − qty`) units **stay pending** (the order
shrinks; the item may remain on the list).

| Tab | Inventory effect (+`qty`) | Assignable? | Orders |
|---|---|---|---|
| **Missing** | logged, reason `missing` | **No** (unassignable, like broken) | partial cancel+refund `qty`, **no** stock return |
| **Broken** | logged, reason `broken` | **No** | partial cancel+refund `qty`, **no** stock return |
| **Cancelled** | logged, reason `customer_cancelled` | Yes | partial cancel+refund `qty` |
| **Wrong** | logged: the **picked received SKU**, reason `wrong_product` | Yes | partial cancel+refund `qty` of the **expected** item |

"Refund" is the existing auto-materialization: reducing `unit`/`unit_buy` drops
the invoice, so an overpaid customer's refund appears automatically. No refund
row is created directly.

### Worked example

Item *Marine Orchid*, 3 pending, orders Anna=2, Ben=1 (Ben higher priority),
tab = Broken, `qty = 1`:
- Allocate 1 unit by priority → Ben's order.
- Ben's line reduced by 1 (fully cancelled, refunded). Anna untouched (2 pending).
- Inventory: +1 unit reason `broken` (unassignable).
- Item stays on the list with 2 pending.

If instead the top-priority order were Anna (2 units) and `qty = 1`: reduce
Anna's line by **1** (partial) → 1 unit refunded, 1 stays pending. **No
over-refund** — this is why a refund-only partial cancel is required.

## Backend design

### 1. New inventory reason `missing`
- Add `"missing"` to the `ExcessReason` union (`lib/db/types.ts`).
- Make the apply-excess-to-orders filter skip it too:
  `app/api/sheets/excess-purchase/route.ts:32` →
  `.filter((r) => r.reason !== "broken" && r.reason !== "missing")`.
- No DB migration needed (`reason` is free text; the union is TS-only). Confirm
  during planning that no CHECK constraint on `excess_purchase.reason` exists;
  add a migration only if one does.

### 2. Refund-only partial cancel + allocator
- Extract the order-row mutation from `cancelOrderUnits` into a shared
  **refund-only** reducer: reduce `unit`, `unit_buy`, and `unit_dispatch` by the
  allocated amount, clamped so nothing drops below already-committed units
  (`unit_buy ≥ unit_ship`, `unit_dispatch ≥ unit_arrive`, `unit ≥ unit_arrive`).
  It logs **no** inventory.
- Refactor `cancelOrderUnits` to reuse the reducer, then keep its existing
  `customer_cancelled` inventory log — behavior unchanged for current callers.
- Add an **allocator** `allocateNotReceived({ event, productId, qty }, tx)` that
  loads the item's pending orders in `compareOrderPriority` order and walks `qty`
  across them via the refund-only reducer (partial on the last touched order),
  returning the total units cancelled (and, for the Cancelled tab's stock math,
  the reclaimed in-hand units).

### 3. Four qty-based record functions (bulk)
New per-item functions that take `{ event, productId, qty, ... }`, run inside a
`withActor` transaction, allocate via the allocator, then log inventory:
- **Missing / Broken**: allocate `qty` (refund-only), then
  `appendExcessPurchase(qty, reason=missing|broken)`.
- **Cancelled**: allocate `qty` but log the reclaimed in-hand units per touched
  order as `customer_cancelled` (mirror `cancelOrderUnits`'s `unit_buy−unit_ship`
  math so already-shipped units aren't re-stocked).
- **Wrong**: allocate `qty` on the **expected** item, then
  `appendExcessPurchase(qty, items=receivedItem, reason=wrong_product,
  expectedItem)`. Require `receivedItem` present and ≠ expected.

The existing whole-order `record*` functions and their `ArriveModal` callers
stay; the bulk path is additive.

### 4. API
Extend `POST /api/sheets/arrival-list` with bulk action names that carry
`productId` + `qty` (and, for wrong, `receivedItem`) instead of `cancelOrderIds`
— e.g. `not_received` with a `mode` field of `wrong|broken|missing|cancelled`.
Validate: `qty ≥ 1`, `qty ≤ pending`, and (wrong) `receivedItem` present and
different from the expected product. Owner-gated like the rest of the route.

## Frontend design

New `NotReceivedPanel` in `ArrivalListClient.tsx`, modeled on
`ConfirmReceivePanel`:
- Selection-bar action **Not Received**, amber, between *Received* and *Clear*.
- Modal: title "Not received — N items", four tabs
  (`Wrong · Broken · Missing · Cancelled`) reusing `ArriveModal`'s tab styling
  (amber active). One tab active at a time applies to all selected items.
- Body: per-item rows grouped by event; each row = product (+ store), editable
  qty (default `totalPending`, `/ N pending`, max = pending).
  - **Wrong tab only**: each row also shows a required SKU picker (the same
    `itemOptions` product list `ArriveModal` uses), which must differ from the
    row's expected product.
- Footer: Confirm (amber) + Cancel. Fire one request per selected item via
  `Promise.allSettled`; on partial failure keep the modal open, list the failed
  items, drop the succeeded ones from the selection (mirror `ConfirmReceivePanel`
  `onPartial`). On full success close + refresh.
- Switching tabs preserves each row's qty; Wrong's SKU picks may reset.

## Edge cases

- qty = 0 rows are skipped (not sent).
- qty > pending rejected client- and server-side.
- Wrong with a missing/equal SKU on any row → that row fails (partial-failure
  list), others still process.
- Selection spanning multiple events → grouped display; each item is an
  independent request, so a failure on one doesn't roll back others (same as
  bulk receive). Within a single item the allocation is one transaction.
- Partial-order cancel never reduces a line below its already-arrived/shipped
  units.

## Testing

Runtime tests against the **local** DB (tsx scripts, guard host 127.0.0.1,
seed → assert → cleanup), matching the project's existing harness:
- Allocator: qty landing mid-order partial-cancels exactly (Anna 2 / qty 1 → 1
  refunded, 1 pending); qty = pending cancels all.
- Each tab's inventory log lands with the right reason and assignability
  (missing/broken unassignable via the apply filter; cancelled/wrong assignable).
- Refund-only reducer logs no inventory; `cancelOrderUnits` still logs
  `customer_cancelled` (no regression).
- Leftover units remain pending and the item still appears in `getArrivalList`.
- `npx tsc --noEmit` clean.

## Out of scope

- Changing `ArriveModal` (per-item flow) or the whole-order `record*` functions.
- Per-order checkboxes in the bulk panel (priority allocation replaces them).
- Refund UI/records beyond the existing auto-materialization.
