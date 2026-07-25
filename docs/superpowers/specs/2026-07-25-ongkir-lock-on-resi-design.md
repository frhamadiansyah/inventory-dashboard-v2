# Lock ongkir once a shipment's resi is filled — Design

**Date:** 2026-07-25
**Branch:** `ongkir-lock-on-resi`

## Goal

Freeze an invoice's ongkir (shipping rate) once the shipment has a resi
(tracking number). While the resi is empty, ongkir stays live (follows the
customer's current rate). A later change to the customer's ongkir must not move
an already-resi'd shipment's ongkir.

## Background (current behavior)

- Ongkir is a **per-customer, per-warehouse per-kg rate** in
  `customer_warehouse_ongkir` (`cwo.ongkos_kirim`).
- Both invoice recaps read it **live**:
  - internal: `lib/db/invoice.ts` main recap query (`COALESCE(cwo.ongkos_kirim, 0) AS ongkir`, ~line 166)
  - public site: `getPublicInvoiceForCustomer` (`COALESCE(cwo.ongkos_kirim, 0) AS ongkir`, ~line 329)
  The ongkir is selected per order row; `computeInvoice`/`computeEventCore` use
  the per-event value.
- A shipment (`shipments` table) is created by `shipCustomerOrders` /
  `shipMergedCustomerOrders` with `shipments.ongkir` = the per-kg rate at **ship
  time** (`ongkirPerKg`), and `tracking_number = ''` (resi filled later).
- The resi is filled later via `updateTrackingNumber` (sets `tracking_number`,
  propagating to the `merge_group`).
- So today, changing a customer's ongkir recalculates every invoice — including
  shipped/resi'd ones.

## Decision

**Lock value = the ship-time snapshot already stored in `shipments.ongkir`.**
(Chosen over re-snapshotting at resi-fill: read-only, lower risk. Accepted
edge: if ongkir changes in the ship→resi-fill window while the resi is still
empty, the invoice shows the new value during that window, then reverts to the
ship-time value when the resi is filled.)

**Read-side only — no write-path change, no migration.**

## Change

In **both** recap queries, replace the ongkir expression:

```sql
COALESCE(cwo.ongkos_kirim, 0) AS ongkir
```

with a version that prefers a resi'd shipment's stored ongkir for that
(customer, event), falling back to the live rate:

```sql
COALESCE(
  (SELECT s.ongkir
     FROM shipments s
    WHERE s.event = o.event
      AND lower(replace(s.customer, '@', '')) = <searchId>
      AND s.tracking_number <> ''
    ORDER BY s.id DESC
    LIMIT 1),
  cwo.ongkos_kirim, 0
) AS ongkir
```

- `<searchId>` is the same normalized-handle parameter each query already binds
  for its customer match.
- The subquery is correlated on `o.event`, so every order row of an event gets
  the same locked/live rate (consistent with how `computeInvoice` consumes it).
- A resi'd shipment with `ongkir = 0` is a valid lock (0, not NULL) → COALESCE
  keeps 0. Only the *absence* of a resi'd shipment (NULL) falls through to `cwo`.
- Merged shipments share the resi (propagated) and the same per-kg rate, so any
  resi'd row of the group yields the correct rate.

Apply the identical shape to the public query (`getPublicInvoiceForCustomer`),
matching its own `searchId`/customer-match binding.

## Behavior after change

| Resi state | Ongkir used |
|---|---|
| No resi'd shipment for (customer, event) | live `cwo.ongkos_kirim` |
| A resi'd shipment exists | that shipment's stored (ship-time) `ongkir` — frozen |

Changing the customer's ongkir afterward:
- resi empty → new rate applies (live)
- resi filled → invoice unchanged (locked)

## Testing

Runtime test (local DB; seed a focused scenario since the recap has no unit
harness):
- Seed warehouse + event (warehouse), product, customer, `customer_warehouse_ongkir`
  row (rate A), one order.
- Assert the internal recap ongkir = A (no resi'd shipment yet).
- Insert a shipment for (customer, event) with `ongkir = B`, `tracking_number = ''`;
  assert recap still = A (live cwo, resi empty).
- Set the shipment's `tracking_number` to a value; assert recap now = B (locked
  to the shipment's stored ongkir).
- Change `cwo.ongkos_kirim` to C; assert recap **stays B** (locked).
- Clear the resi; assert recap returns to C (live).
- Repeat the key assertions against `getPublicInvoiceForCustomer`.
- Exact-match cleanup only (never `LIKE`); `npx tsc --noEmit` clean.

## Out of scope

- Re-snapshotting ongkir at resi-fill (the exact-timing variant).
- Recomputing `shipments.ongkir_total` or merge-billing adjustments.
- Any migration (the `shipments.ongkir` column already exists).
