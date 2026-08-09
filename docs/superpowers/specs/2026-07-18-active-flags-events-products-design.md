# Active/Inactive Toggle for Events & Products

## Goal

Let an owner mark an **event** or **product** as inactive. An inactive event or
product must **not appear in the List Order input dropdowns** (the event picker
and the item picker on the Order page's add-order forms). Everywhere else is
unchanged — inactive items still show in their own management tables (so they
can be reactivated), in every other picker, and in all existing orders/reports.

## Decisions (confirmed with user)

- **Hide scope:** *only* the List Order input dropdowns. All other pickers
  (adjustments, payments, refunds, excess-purchase, arrival, shopping-list,
  ship) continue to show inactive events/products.
- **Toggle UI:** an inline switch in each row of the Events and Products
  management tables (not a checkbox buried in the edit form).
- **Toggling is instant:** optimistic flip, reverts on API error. No confirm
  dialog.
- **Inactive rows stay in place**, just dimmed (not moved to the bottom).

## Data model

Migration `039_active_flags.sql` (applied manually in the Supabase SQL editor
as postgres owner, per project convention):

```sql
ALTER TABLE events   ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
```

`DEFAULT TRUE` means every existing row is active on deploy — nothing vanishes.

## Hiding logic — carry active-ness, filter only in List Order

`getSheetOptions()` feeds **11 different pickers** via the shared
`useSheetOptions` hook + `/api/sheets/options`. Filtering it globally would hide
inactive items everywhere, which contradicts the chosen scope. Instead the
options payload *carries* active-ness and only List Order acts on it:

- `ItemOption` gains `active: boolean`.
- `SheetOptions` gains `activeEvents: string[]` — the subset of event names that
  are active. The existing `events: string[]` (all names) and `items:
  ItemOption[]` (all items) stay as-is, so the other 10 consumers are untouched.
- `getSheetOptions()`:
  - events query also selects `is_active`; builds both `events` (all) and
    `activeEvents` (active only).
  - products query selects `is_active`; each `ItemOption` gets `active`.

**List Order page (`app/dashboard/list-order/DataTable.tsx`)** — two add-order
forms (desktop ~L741/L832, mobile ~L1080/L1136):

- Event `<EventSelect>` is fed `options.activeEvents` instead of `options.events`.
- `itemOptions` `useMemo` filters `options.items` to `it.active` before mapping.

**Edit-existing-order edge case:** an order whose event or product later went
inactive keeps its stored value visible (we never blank a saved selection). The
inactive value simply isn't offered as a *new* pick. `EventSelect` /
`SearchableSelect` already render the current `value` even when it's not in the
options list, so no extra work — just don't strip the stored value.

## API — dedicated flag flips

A full product PUT requires every product field; toggling one boolean shouldn't
round-trip all of that. Add dedicated PATCH handlers:

- `PATCH /api/sheets/events/[id]` body `{ isActive: boolean }` → `setEventActive(id, isActive)`.
- `PATCH /api/sheets/products/[id]` body `{ isActive: boolean }` → `setProductActive(id, isActive)`.

New DB functions in `lib/db/catalog.ts`:

```ts
export async function setEventActive(id: number, isActive: boolean, db = sql) {
  await db`UPDATE events SET is_active = ${isActive}, updated_at = NOW() WHERE id = ${id}`
}
export async function setProductActive(id: number, isActive: boolean, db = sql) {
  await db`UPDATE products SET is_active = ${isActive}, updated_at = NOW() WHERE id = ${id}`
}
```

Both wrapped in `withActor(session.user.email, …)` like the sibling handlers,
and role-gated with the same `requireRole` the existing routes use.

## Types & queries touched

- `ItemOption` (`lib/db/types.ts`): add `active: boolean`.
- `SheetOptions` (`lib/db/types.ts`): add `activeEvents: string[]`.
- `EventRow` (`lib/db/types.ts` / wherever defined): add `isActive: boolean`;
  its list query selects `is_active`.
- `ProductRow` (`lib/db/types.ts`): add `isActive: boolean`;
  `getProductsPaginated` selects `is_active` and maps it.

## UI

### Shared component — `components/ToggleSwitch.tsx` (new)

A small controlled pill switch (no such component exists yet):

```
props: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }
```

Track `w-9 h-5 rounded-full`, knob slides; on = `bg-brand`, off =
`bg-gray-300`. Accessible: `role="switch"`, `aria-checked`, keyboard-toggle.

### Events table (`app/dashboard/events/EventsClient.tsx`)

- New "Active" column (before the actions column) rendering `<ToggleSwitch>`.
  `size: 90`.
- On flip: optimistic local update, `PATCH /api/sheets/events/[id]`, revert +
  toast/inline error on failure.
- Row dimming: when `!isActive`, the row's cells get `opacity-60`, and the
  event-name cell shows a gray "Inactive" badge.

### Products table (`app/dashboard/products/ProductsPageClient.tsx`)

- Same "Active" column + toggle, `size: 90`, visible by default.
- Same optimistic flip against `PATCH /api/sheets/products/[id]`.
- Dimming + "Inactive" badge on the name cell when inactive.
- Mobile card (`renderMobileCard`): include the toggle + dimming.

## Explicitly NOT changed

Existing orders, invoices, packing/ship, reports, `products_indo`, and the 10
non-List-Order pickers. The change is additive: a new column, two new API verbs,
two new nullable-safe DB columns defaulting to active.

## Verification

1. **Typecheck:** `npx tsc --noEmit` clean.
2. **Migration:** user applies `039_active_flags.sql` in Supabase.
3. **Manual (user):**
   - Toggle an event off → it disappears from the Order page event dropdown but
     still shows in Payments/Adjustments/etc. event pickers and in the Events
     table (dimmed, "Inactive").
   - Toggle a product off → gone from the Order page item dropdown, still
     present elsewhere.
   - An existing order whose event/product is now inactive still displays its
     saved value in the edit form.
   - Toggle back on → reappears in the Order dropdowns.
   - Kill the network mid-toggle → switch reverts, error surfaced.
