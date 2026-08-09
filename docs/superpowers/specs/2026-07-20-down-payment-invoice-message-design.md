# Down Payment Threshold — Alternate Invoice Message

## Goal

Add a global **Down Payment %** setting. When generating a customer's invoice
message for an event, if the customer has paid **less than** that percentage
of the event's total, send a different ("DP reminder") message instead of the
normal invoice message. Once they've paid at or above the threshold, the
normal invoice message resumes automatically — no manual switching.

## Decisions (confirmed with user)

- **Threshold basis:** % of the event's full invoice total (subtotal + ongkir
  + biaya lainnya) — the same `total` `computeEventCore` already computes.
  Not subtotal-only, not a flat Rupiah amount.
- **Message relationship:** a brand new, separately-editable template (not a
  conditional block inside the existing invoice template) — same pattern as
  `refund_specific` vs `refund_generic` already being two variants of "refund
  message".
- **DP content:** the reminder message gets two new computed numbers — the
  required DP amount and how much more is needed to reach it — not just a
  reworded copy of the existing invoice numbers.
- **Scope:** one global percentage, no per-event override.
- **Public site:** untouched. The public no-login invoice recap
  (`getPublicInvoiceForCustomer` / `PublicInvoiceEvent`) has no `message`
  field — this feature only affects the dashboard-generated WhatsApp message
  (`InvoiceMessageActions` / "View message" / "Copy message" / "Send
  message").

## Data model

Migration `043_dp_percent.sql` (applied manually in the Supabase SQL editor as
postgres owner, per project convention):

```sql
ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS dp_percent NUMERIC NOT NULL DEFAULT 0;
```

`DEFAULT 0` means the feature is inert until the owner sets a real percentage
in Settings — with threshold `0`, every event's `pembayaran (≥0) >= 0*total`
is always true, so the default invoice template keeps being used exactly as
today. No deploy-day behavior change. The `040_settings.sql` audit trigger on
`business_profile` already covers new columns on that table, same as
`042_public_site_url.sql` noted.

## Types & settings plumbing

- **`lib/business-profile.ts`**
  - `BusinessProfile` gains `dpPercent: number`.
  - `DEFAULT_BUSINESS_PROFILE.dpPercent = 0`.
- **`lib/db/settings.ts`** — `getBusinessProfile` selects `dp_percent`, maps
  to `dpPercent: Number(row.dp_percent)`; `updateBusinessProfile` writes it
  through the existing upsert (already round-trips the whole object, no new
  API route needed).

## Template + tokens (`lib/message-templates.ts`)

- `TemplateKey` gains `"invoice_dp"`.
- `TEMPLATE_KEYS` includes it.
- `REQUIRED_TOKENS.invoice_dp`:
  `["{eventId}", "{handle}", "{produkLines}", "{subtotalBarang}", "{weightKg}", "{perKgRate}", "{dpAmount}", "{dpShortfall}", "{bankAccountHolder}", "{bankAccountLines}", "{publicSiteUrl}"]`
- `OPTIONAL_TOKENS.invoice_dp`: `["{biayaLainnyaBlock}", "{sisaPelunasan}"]`
  — full remaining balance stays available for a template that wants to
  mention it alongside the DP figure, but isn't mandatory.
- `DEFAULT_TEMPLATES.invoice_dp` — new seed text, e.g.:

  ```
  INVOICE - DOWN PAYMENT
  {eventId} {handle}

  Produk:
  {produkLines}

  Subtotal Barang: Rp {subtotalBarang}
  Estimasi Ongkir: {weightKg} kg x Rp {perKgRate}{biayaLainnyaBlock}

  Down Payment yang dibutuhkan: Rp {dpAmount}
  Kekurangan Down Payment: Rp {dpShortfall}

  Rekening an {bankAccountHolder}:
  {bankAccountLines}

  Mohon lakukan pembayaran down payment agar pesanan diproses.

  Cek rekapan mandiri {publicSiteUrl}
  ```

## Selection + computation logic (`lib/db/invoice.ts`)

Inside `getInvoiceForCustomer`'s existing per-event `events.map(...)` loop
(where `computeEventCore` already yields `invoice.total` and
`invoice.pembayaran`):

```ts
const dpThreshold = invoice.total * (businessProfile.dpPercent / 100)
const meetsThreshold = invoice.total === 0 || invoice.pembayaran >= dpThreshold
```

The `invoice.total === 0` guard covers a fully-cancelled/void event — never
send a "pay your down payment" message for a Rp 0 order.

- If `meetsThreshold`: build with `templates.invoice` exactly as today.
- Else: build with `templates.invoice_dp`, passing two extra computed vars:
  - `dpAmount = formatIdrNumber(dpThreshold)`
  - `dpShortfall = formatIdrNumber(Math.max(0, dpThreshold - invoice.pembayaran))`

`buildInvoiceMessage` is extended to accept the template key's extra vars (or
a sibling `buildDpReminderMessage` sharing the same `produkLines`/`fillTemplate`
plumbing) — implementation detail decided in the plan, not the spec.

`getMessageTemplates()` needs no change: it already merges DB rows over
`DEFAULT_TEMPLATES` per key, so `invoice_dp` gets the same "not yet saved
falls back to default text" behavior the other four templates have.

## Settings UI (`app/dashboard/settings/SettingsClient.tsx`)

- **Business Profile section:** add a "Down Payment %" number input
  (0–100, step 1) alongside the existing bank/store fields, saved through the
  same `business-profile` PATCH the section already uses.
- **Template editor:** `invoice_dp` appears automatically wherever
  `TEMPLATE_KEYS.map(...)` renders a tab/section (label: "Invoice message —
  DP reminder" in `TEMPLATE_LABELS`). Add its `SAMPLE_VARS` entry (including
  sample `dpAmount`/`dpShortfall`) so the live preview pane works while
  editing, matching the other four templates.
- Save-time validation: `findMissingTokens` is already generic over
  `TemplateKey` — adding `invoice_dp` to `REQUIRED_TOKENS` is sufficient to
  get the same "can't save with a missing required token" guard the other
  four templates have. No new validation code.

## Explicitly NOT changed

- Public invoice recap site (no message field there).
- Shipment/refund templates and their selection logic.
- Per-event overrides — this is a single global percentage.
- Existing `invoice` template behavior when `dpPercent` is `0` or unset.

## Verification

1. **Typecheck:** `npx tsc --noEmit` clean.
2. **Migration:** user applies `043_dp_percent.sql` in Supabase.
3. **Manual (user):**
   - Leave DP% at 0 → every event's message is unchanged (still the default
     invoice template), confirming the inert-by-default behavior.
   - Set DP% to e.g. 30 in Settings → open an event where the customer has
     paid <30% of total → "View message"/"Copy message" shows the DP
     reminder template with correct `{dpAmount}`/`{dpShortfall}`.
   - Record a payment that pushes them ≥30% → reopen the invoice → message
     flips back to the default invoice template (no caching — recomputed on
     every request).
   - A fully-cancelled event (`total = 0`) never shows the DP reminder.
   - Settings: try saving the `invoice_dp` template with a required token
     removed → save is rejected, same as the other four templates.
