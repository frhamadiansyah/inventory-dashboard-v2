# Event Performance Panel — Design

## Goal

On the Events page, make each event row expandable (like the invoice page) to reveal a
mini-dashboard of that event's performance: sales, payments, fulfillment, and profit.

## Metrics

Per event:

- **Sales** — order count, unique customers, total units, revenue (omzet).
- **Payments** — total paid, outstanding balance, count of unpaid invoices.
- **Fulfillment** — units bought / arrived / shipped vs ordered (progress bars).
- **Profit** — net profit.

### Revenue (omzet)

Matches the dashboard convention:
`subtotal + ongkir + adjustments`, per (event, customer), summed over the event.

- subtotal = `SUM(o.unit_price * o.unit)`
- ongkir = `ongkos_kirim(customer, event.warehouse) * CEIL(total_gram / 1000)` per invoice
- adjustments = `SUM(adjustments.amount)` per (event, customer)

### Outstanding / paid

- paid = `SUM(payments.amount) WHERE is_checked = true`, per event.
- outstanding = `SUM(GREATEST(invoiceTotal - paidPerInvoice, 0))` per (event, customer).
- unpaid count = number of (event, customer) invoices with a positive balance.

### Profit

Simple cash view: `netProfit = totalPaid - opsExpenses`.

- totalPaid = all checked payments for the event (see above).
- opsExpenses = `SUM(operational_expenses.amount_idr)` for that event — every category,
  including `Shop` (goods purchases). Because profit is cash-in minus cash-out, goods
  cost enters via the ops ledger, NOT via products.cost. There is no separate gross-margin
  term (an earlier draft used `SUM(unit * (unit_price - product.cost))`, which
  double-counted COGS against the `Shop` expenses and drove events falsely negative).

## Data loading — batch (chosen)

One aggregate endpoint returns stats for **all** events, fetched once alongside the
events list. No per-row fetch, no N+1, no per-row spinners. The events list is small
(dozens of rows), so a single query is cheap.

Rejected: lazy per-row fetch on expand (extra requests, per-row loading states, needless
for a small list).

Note: the existing `getDashboardSummary` per-event aggregate filters to active events
(`total_units > total_shipped`) and is keyed differently. Event performance must cover
**all** events, so it gets its own query rather than reusing that one.

## Architecture

1. **`getEventPerformance()`** — new function in `lib/db/dashboard.ts`. Runs the aggregate
   query, returns `EventPerformance[]` (one per event name). New exported interface
   `EventPerformance` with the fields above.

2. **`GET /api/sheets/events/performance`** — new route returning `{ rows: EventPerformance[] }`.
   Mirrors auth/error shape of the existing events route.

3. **`EventPerformancePanel`** — presentational component (own file under
   `app/dashboard/events/`). Props: one `EventPerformance` (+ currency for formatting).
   Renders three stat groups (Sales / Payments / Fulfillment) as tiles, a fulfillment
   progress bar (bought/arrived/shipped), and a net-profit line
   (`paid − ops`). No data fetching inside. Reused by desktop and mobile.

4. **`EventsClient` wiring** —
   - Fetch performance alongside events in `load()` (add to the `Promise.all`); store a
     `Map<eventName, EventPerformance>`.
   - Desktop: pass `renderExpandedRow` to `DataGrid` → renders `EventPerformancePanel`
     for that row's event (DataGrid already supports expandable rows).
   - Mobile: add a tap-to-expand toggle on each event card that reveals the same panel.
   - If an event has no performance data (no orders yet), show a muted "No activity yet".

## Layout sketch

```
┌ Sales ──────┬ Payments ────┬ Fulfillment ─┐
│ 42 orders   │ Paid  12.4jt │ Bought 90%   │
│ 18 buyers   │ Owed   2.1jt │ Arrived 70%  │  ← progress bars
│ 210 units   │ 3 unpaid     │ Shipped 40%  │
│ Rev 14.5jt  │              │              │
└─────────────┴──────────────┴──────────────┘
        Net profit: 1.7jt (paid 3.8jt − ops 2.1jt)
```

## Out of scope

- No historical trend / time series.
- No per-customer or per-product breakdown in the panel (that's the invoice page).
- No CSV export.
- No caching layer — query runs on each page load (data is small).

## Testing

- Verify `getEventPerformance()` numbers reconcile against the invoice page for a sample
  event (revenue, paid, outstanding).
- Verify an event with zero orders returns a zeroed/absent row and the panel shows the
  empty state.
- Verify expand/collapse works on both desktop table and mobile cards.
