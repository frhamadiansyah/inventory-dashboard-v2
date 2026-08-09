# Customer Detail Drawer — Design

## Goal

On the Customers page, clicking a customer row opens a right-side slide-over
showing that customer's whole financial picture in one read-only view:
invoices, payments, adjustments, and refunds — plus a compact money header.

## Interaction

- Desktop table row click and mobile card tap both open the drawer (via
  `DataGrid`'s existing `onRowClick`; the row's Edit/Delete buttons already
  `stopPropagation`, so they keep working).
- Drawer dismiss: backdrop click / Escape (`useModalDismiss`), matching
  `InvoiceDetailDrawer`.
- Read-only. No add/edit from the drawer — those stay on their own pages.

## Data — one endpoint

`GET /api/sheets/customers/summary?customer=<instagramId>` returns everything in
one round-trip:

```ts
{
  invoices: InvoiceResult,      // getInvoiceForCustomer(id)
  payments: PaymentRow[],       // customer-filtered, newest first
  adjustments: AdjustmentRow[], // customer-filtered, newest first
  refunds: RefundRow[],         // getRefunds({ customer })
}
```

- Auth mirrors the other events/customers routes (`requireSession` +
  `requireOwner`).
- New `getCustomerLedger(instagramId)` in `lib/db/finance.ts` runs the payments /
  adjustments / refunds queries in one `Promise.all`. Payments and adjustments
  get thin customer-filtered SELECTs (canonical handle = bare lowercase; match
  the existing filter approach in `getPaymentsPaginated` /
  `getAdjustmentsPaginated`). Refunds reuse `getRefunds({ customer })`.
- The route calls `getInvoiceForCustomer(id)` and `getCustomerLedger(id)` in
  parallel and merges.

Row counts per customer are small, so no pagination inside the endpoint or the
drawer sections.

## Component — `CustomerDetailDrawer`

New file under `app/dashboard/customers/`. Mirrors `InvoiceDetailDrawer`'s shell:
fixed right slide-over, backdrop, `useModalDismiss`, `max-w-3xl`, scrolling body.
Props: `{ customer: string; onClose: () => void }`. Fetches the summary endpoint
on mount (cancel-on-unmount, like `InvoiceDetailDrawer`).

### Money header (compact)

Derived from `invoices` (`InvoiceResult`):

- **Total invoiced** = Σ `events[].invoice.total`
- **Total paid** = Σ `events[].invoice.pembayaran`
- **Balance** = Σ `events[].invoice.sisaPelunasan` — positive = owed (red),
  negative = overpaid (purple, shown as magnitude), zero = settled (green).

Matches the colour convention already used on the payment-status panel.

### Sections (stacked, titled, each with a count + empty state)

1. **Invoices** — reuse `EventCard` (from `app/dashboard/invoice/EventCard.tsx`)
   per `invoices.events[]`. Already renders orders + per-event totals.
2. **Payments** — date · amount · account · checked (✓ / pending) · remarks.
3. **Adjustments** — event · ±amount · description.
4. **Refunds** — event · amount · reason · status.

Each section renders "No <thing> yet" when empty.

## Wire-up

`CustomersClient`:
- Add `const [detailCustomer, setDetailCustomer] = useState<string | null>(null)`.
- `onRowClick={(row) => setDetailCustomer(row.instagramId)}` on the `DataGrid`.
- Render `<CustomerDetailDrawer customer={detailCustomer} onClose={() => setDetailCustomer(null)} />`
  when set.

## Reuse note

`EventCard` currently lives under `app/dashboard/invoice/`. It's already a shared
presentational component (imported by `InvoiceDetailDrawer`); importing it from
the customers drawer is fine and avoids duplicating invoice rendering. No move
required.

## Out of scope

- Editing / adding anything from the drawer (read-only).
- Pagination within sections.
- CSV export.
- A dedicated full-page customer view (the drawer is the whole feature).

## Testing

- Endpoint returns the four data sets for a sample customer; payments /
  adjustments / refunds arrays match what their own pages show when filtered to
  that customer.
- Money header: invoiced / paid / balance reconcile against the invoice page for
  the same customer.
- Drawer opens on desktop row click and mobile card tap; Edit/Delete buttons
  still work without opening it.
- Empty states render for a customer with no payments / adjustments / refunds.
