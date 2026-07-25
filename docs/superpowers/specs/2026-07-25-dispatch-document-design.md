# Dispatch Document Download — Design

**Date:** 2026-07-25
**Branch:** `dispatch-document`

## Goal

Add a "download document" control to the Dispatch List page — reprint the cargo-style manifest for a dispatch batch, filtered by **event** (required) and **dispatch_receipt** (optional substring). Reuses the existing cargo-document PDF template. Mirrors the Receiving List's report-download bar.

## Background (existing code)

- Receiving List has `ReceivedReportControls` (`app/dashboard/arrival-list/ReceivedReportControls.tsx`) placed between the page header and the client list (`arrival-list/page.tsx`). It calls `GET /api/sheets/receiving-report` and downloads a PDF. This is the UI/flow pattern to mirror.
- The cargo PDF generator is reusable as-is: `generateCargoDocument({ name?, date, lines: { productName, qty, valas, currency }[] })` (`lib/cargo-document-pdf.ts`) — groups lines by currency with a per-currency subtotal.
- `EventSelect` (`components/EventSelect.tsx`) is the click-only event dropdown; `useSheetOptions()` provides `events`.
- Orders carry `unit_dispatch` (dispatched units) and `dispatch_receipt` (tracking ref, one per order). Product cost fields `valas` + country `currency` are joined the same way `getDispatchList` does (`lib/db/dispatch.ts`: `JOIN products p` + `LEFT JOIN countries c ON c.id = p.country_id`).

## Data

New query `getDispatchDocument(event: string, receipt?: string | null): Promise<DispatchDocLine[]>` in `lib/db/dispatch.ts`.

- `DispatchDocLine = { productName: string; qty: number; valas: number; currency: string }`.
- Aggregates dispatched order lines for the event, per product:
  - `SUM(o.unit_dispatch)::int AS qty`
  - `p.name AS productName`, `p.valas`, `COALESCE(c.currency, '') AS currency`
- Filter:
  - `o.event = ${event}`
  - `o.unit_dispatch IS NOT NULL AND o.unit_dispatch > 0`
  - When `receipt` is non-empty: `o.dispatch_receipt ILIKE '%' || ${receipt} || '%'` (case-insensitive substring; `MNC` matches `MNC38179`). When empty/absent: no receipt filter (all dispatched lines for the event).
- `GROUP BY p.name, p.valas, c.currency` (and product_id for correctness); `HAVING SUM(unit_dispatch) > 0`.
- `ORDER BY p.store, p.name` (stable, matches dispatch list ordering intent).

Note: `dispatch_receipt` is a single field per order, so each order's `unit_dispatch` associates with exactly one receipt — no double counting across receipts.

## API

`GET /api/sheets/dispatch-report?event=&receipt=` in `app/api/sheets/dispatch-report/route.ts`.

- Owner-gated (`requireSession` + `requireOwner`), matching the receiving-report route.
- `event` required → 400 if missing. `receipt` optional (trimmed; empty treated as absent).
- Returns `{ event, receipt, lines }` with `Cache-Control: no-store`.
- On query error → 500.

## PDF / client

New `DispatchDocControls` (`app/dashboard/dispatch-list/DispatchDocControls.tsx`), modeled on `ReceivedReportControls`:

- `EventSelect` (required) + a free-text `Receipt` input (optional) + Download button (disabled until event set).
- Mobile: event on its own row, receipt + button on the second (same responsive approach as `ReceivedReportControls`).
- On download: `fetchJson` the route, then `generateCargoDocument`:
  - `name` (title) = `event` + (` · ${receipt}` when a receipt was typed)
  - `date` = today in Asia/Jakarta (`en-CA` formatter, same helper as the siblings)
  - `lines` = the returned lines
  - filename = `dispatch-${event}${receipt ? '-' + receipt : ''}.pdf`
- Empty `lines` → inline message: `No dispatched items for ${event}` + ` matching "${receipt}"` when a receipt was given. (Do not download an empty PDF.)

Placement: render `<DispatchDocControls />` between `<PageHeader/>` and `<DispatchListClient/>` in `app/dashboard/dispatch-list/page.tsx`.

## Edge cases

- No event selected → Download disabled.
- Receipt with no matches → empty-result message, no PDF.
- Products with no currency (`valas 0` / `currency ""`) → the cargo template already handles the blank-currency group (`"—"` label); qty still shows.
- Multi-currency event → cargo template groups per currency with subtotals (existing behavior).

## Testing

Runtime test (local DB, host-guarded, seed → assert → cleanup) for `getDispatchDocument`:
- Seed one event + products + dispatched orders (`unit_dispatch > 0`) with distinct `dispatch_receipt` values.
- Assert: event-only returns all dispatched products (qty = summed `unit_dispatch`); a receipt substring narrows to matching orders; a non-matching substring returns none; `valas`/`currency` populated.
- `npx tsc --noEmit` clean.

## Out of scope

- Editable quantities (the in-panel cargo flow keeps that; this is a fixed reprint from data).
- Changing `generateCargoDocument`, the existing in-list `CargoDocPanel`, or `getDispatchList`.
- Date filtering (receipt is the batch key here, not dates).
