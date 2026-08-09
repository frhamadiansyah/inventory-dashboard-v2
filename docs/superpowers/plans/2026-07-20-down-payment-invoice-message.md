# Down Payment Threshold — Alternate Invoice Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global "Down Payment %" setting so a customer who has paid less than that percentage of an event's invoice total gets a separate, owner-editable "DP reminder" message instead of the normal invoice message — flipping back to the normal message automatically once they cross the threshold.

**Architecture:** The threshold check happens inside the existing per-event loop in `getInvoiceForCustomer` (`lib/db/invoice.ts`), which already computes `invoice.total` and `invoice.pembayaran` for every event. No new query. The DP percentage is one more field on the existing single-row `business_profile` table/settings object (same pattern as `bankAccountHolder`, `publicSiteUrl`). The DP reminder text is a 5th entry in the existing `message_templates` table/`TemplateKey` union (same pattern as `refund_specific` vs `refund_generic`), so it gets the existing Settings UI, save validation, and default-fallback behavior for free.

**Tech Stack:** Next.js (App Router) + TypeScript, `postgres` (porsager) tagged-template SQL against Supabase, React client components, Tailwind. No test runner is configured in this repo (`package.json` has no `test` script, no test files exist) — verification is `npx tsc --noEmit` plus the manual walkthrough in the spec.

## Global Constraints

- Migrations are written as `.sql` files under `supabase/migrations/` but are **applied manually by the user in the Supabase SQL editor as the postgres owner** — the app's runtime DB role cannot run DDL. Do not attempt to run the migration yourself; just create the file.
- Money/percent values follow the existing convention: percentages are stored as whole numbers (`profit_pct = 30` means 30%, not `0.3`), matching `product_defaults.profit_pct`.
- `DEFAULT_TEMPLATES`, `REQUIRED_TOKENS`, `OPTIONAL_TOKENS`, and the DB seed row bodies must all match verbatim for the same key — this is an existing rule stated in `supabase/migrations/040_settings.sql`'s header comment ("the seed values below must match those defaults verbatim").
- `findMissingTokens`/save-time validation is generic over `TemplateKey` already — do not hand-roll a parallel check for the new key.
- Public invoice site (`getPublicInvoiceForCustomer`, `PublicInvoiceEvent`) is explicitly out of scope — do not touch `lib/db-public.ts` or the public route.
- Every task ends with `npx tsc --noEmit` run from the repo root, expected to print nothing (clean exit).

---

### Task 1: Migration file for `business_profile.dp_percent`

**Files:**
- Create: `supabase/migrations/043_dp_percent.sql`

**Interfaces:**
- Consumes: nothing (pure SQL, no app code depends on this task directly).
- Produces: a `dp_percent NUMERIC(6,2) NOT NULL DEFAULT 0` column on `business_profile`, read/written by Task 2's `lib/db/settings.ts` changes.

- [ ] **Step 1: Write the migration file**

```sql
-- Adds business_profile.dp_percent — the global "% of invoice total that
-- must be paid before the default invoice message is sent" threshold. Below
-- threshold, getInvoiceForCustomer sends the new invoice_dp template instead
-- (see lib/db/invoice.ts, lib/message-templates.ts).
--
-- DEFAULT 0 means every event's paid-so-far (always >= 0) already meets a
-- 0% threshold, so this column ships inert: no existing invoice message
-- changes until the owner sets a real percentage in Settings.
--
-- The 040_settings.sql audit trigger on business_profile already covers new
-- columns on that table (row-level trigger), same as 042_public_site_url.sql.

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS dp_percent NUMERIC(6,2) NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/043_dp_percent.sql
git commit -m "Add business_profile.dp_percent migration for DP threshold feature"
```

---

### Task 2: `BusinessProfile` type + default

**Files:**
- Modify: `lib/business-profile.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BusinessProfile.dpPercent: number`, `DEFAULT_BUSINESS_PROFILE.dpPercent = 0`. Task 3, Task 4, and Task 7 all read/write this field by name.

- [ ] **Step 1: Add the field to the interface and default**

Edit `lib/business-profile.ts` to the following full contents:

```ts
// Shared business identity fields, edited once from /dashboard/settings and
// reused wherever a message needs them (today: the invoice's bank details
// and DP threshold; ownerName/storeName/phoneNumber aren't wired into any
// message yet, they're just stored for later).

export interface BusinessProfile {
  bankAccountHolder: string
  /** One "Bank Name 123456789" per line. */
  bankAccountLines: string
  ownerName: string
  storeName: string
  phoneNumber: string
  /** Public order-status site, e.g. "Cek rekapan mandiri {publicSiteUrl}" in
   *  the invoice message and "Cek resi {publicSiteUrl}" in the shipment one. */
  publicSiteUrl: string
  /** % of an event's invoice total that must be paid before the default
   *  invoice message is sent instead of the invoice_dp reminder (see
   *  lib/db/invoice.ts). Whole number (30 means 30%), not a fraction. 0
   *  disables the feature — every event always meets a 0% threshold. */
  dpPercent: number
}

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  bankAccountHolder: "Shinta Michiko",
  bankAccountLines: "Bank Jago (Artos) 103382719370\nBank Central Asia 4419051991",
  ownerName: "",
  storeName: "Yubisayu",
  phoneNumber: "",
  publicSiteUrl: "https://yubisayu-invoice.netlify.app/",
  dpPercent: 0,
}
```

- [ ] **Step 2: Typecheck (expect new errors from downstream files — that's fine, they're fixed in later tasks)**

Run: `npx tsc --noEmit`
Expected: errors in `lib/db/settings.ts` and `app/api/sheets/business-profile/route.ts` about missing `dpPercent` — these are fixed in Tasks 3 and 4. No error should appear in `lib/business-profile.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add lib/business-profile.ts
git commit -m "Add dpPercent field to BusinessProfile type"
```

---

### Task 3: Wire `dp_percent` through `lib/db/settings.ts`

**Files:**
- Modify: `lib/db/settings.ts:41-70`

**Interfaces:**
- Consumes: `BusinessProfile.dpPercent` (Task 2).
- Produces: `getBusinessProfile()` returns `dpPercent`; `updateBusinessProfile(data)` persists it. Task 4 (API route) and Task 6 (`getInvoiceForCustomer`) both consume `getBusinessProfile()`'s return value.

- [ ] **Step 1: Update `getBusinessProfile` and `updateBusinessProfile`**

Replace the `// ─── Business profile ───` section (lines 35-70) of `lib/db/settings.ts` with:

```ts
// ─── Business profile ────────────────────────────────────────────────────────
//
// Shared business identity fields (bank details, DP threshold today; owner
// name/store name/phone number stored for later use). Single row, id always
// 1. See lib/business-profile.ts and app/api/sheets/business-profile/route.ts.

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const [row] = await sql`
    SELECT bank_account_holder, bank_account_lines, owner_name, store_name, phone_number, public_site_url, dp_percent
    FROM business_profile WHERE id = 1
  `
  if (!row) return DEFAULT_BUSINESS_PROFILE
  return {
    bankAccountHolder: row.bank_account_holder as string,
    bankAccountLines: row.bank_account_lines as string,
    ownerName: row.owner_name as string,
    storeName: row.store_name as string,
    phoneNumber: row.phone_number as string,
    publicSiteUrl: row.public_site_url as string,
    dpPercent: Number(row.dp_percent),
  }
}

export async function updateBusinessProfile(data: BusinessProfile, db: DBExecutor = sql): Promise<void> {
  await db`
    INSERT INTO business_profile (id, bank_account_holder, bank_account_lines, owner_name, store_name, phone_number, public_site_url, dp_percent, updated_at)
    VALUES (1, ${data.bankAccountHolder}, ${data.bankAccountLines}, ${data.ownerName}, ${data.storeName}, ${data.phoneNumber}, ${data.publicSiteUrl}, ${data.dpPercent}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      bank_account_holder = EXCLUDED.bank_account_holder,
      bank_account_lines = EXCLUDED.bank_account_lines,
      owner_name = EXCLUDED.owner_name,
      store_name = EXCLUDED.store_name,
      phone_number = EXCLUDED.phone_number,
      public_site_url = EXCLUDED.public_site_url,
      dp_percent = EXCLUDED.dp_percent,
      updated_at = NOW()
  `
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `lib/db/settings.ts`. The `app/api/sheets/business-profile/route.ts` error from Task 2 may still be present (fixed next task) — if `tsc` doesn't surface it yet because the route just spreads `body` loosely, that's fine, Task 4 handles it regardless.

- [ ] **Step 3: Commit**

```bash
git add lib/db/settings.ts
git commit -m "Read/write dp_percent in getBusinessProfile/updateBusinessProfile"
```

---

### Task 4: API route — accept `dpPercent` in the PATCH body

**Files:**
- Modify: `app/api/sheets/business-profile/route.ts`

**Interfaces:**
- Consumes: `BusinessProfile` (Task 2), `updateBusinessProfile` (Task 3).
- Produces: `PATCH /api/sheets/business-profile` persists `dpPercent` from the request body. Task 7's Settings UI sends this field.

- [ ] **Step 1: Add `dpPercent` to the parsed body**

In `app/api/sheets/business-profile/route.ts`, change the `PATCH` handler's body-parsing block from:

```ts
    const profile = {
      bankAccountHolder: String(body.bankAccountHolder ?? ""),
      bankAccountLines: String(body.bankAccountLines ?? ""),
      ownerName: String(body.ownerName ?? ""),
      storeName: String(body.storeName ?? ""),
      phoneNumber: String(body.phoneNumber ?? ""),
      publicSiteUrl: String(body.publicSiteUrl ?? ""),
    }
```

to:

```ts
    const profile = {
      bankAccountHolder: String(body.bankAccountHolder ?? ""),
      bankAccountLines: String(body.bankAccountLines ?? ""),
      ownerName: String(body.ownerName ?? ""),
      storeName: String(body.storeName ?? ""),
      phoneNumber: String(body.phoneNumber ?? ""),
      publicSiteUrl: String(body.publicSiteUrl ?? ""),
      dpPercent: Number(body.dpPercent) || 0,
    }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean — no errors anywhere in the project (Tasks 2-4 together close the loop on `BusinessProfile`).

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/business-profile/route.ts
git commit -m "Accept dpPercent in business-profile PATCH route"
```

---

### Task 5: New `invoice_dp` template key

**Files:**
- Modify: `lib/message-templates.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TemplateKey` includes `"invoice_dp"`; `TEMPLATE_KEYS`, `REQUIRED_TOKENS.invoice_dp`, `OPTIONAL_TOKENS.invoice_dp`, `DEFAULT_TEMPLATES.invoice_dp` all defined. Task 6 (`lib/db/invoice.ts`) builds messages with this key; Task 7 (Settings UI) renders an editor for it; Task 8 (migration seed) inserts its default row.

- [ ] **Step 1: Update the type union and key list**

In `lib/message-templates.ts`, change:

```ts
export type TemplateKey = "invoice" | "shipment" | "refund_specific" | "refund_generic"

export const TEMPLATE_KEYS: TemplateKey[] = ["invoice", "shipment", "refund_specific", "refund_generic"]
```

to:

```ts
export type TemplateKey = "invoice" | "invoice_dp" | "shipment" | "refund_specific" | "refund_generic"

export const TEMPLATE_KEYS: TemplateKey[] = ["invoice", "invoice_dp", "shipment", "refund_specific", "refund_generic"]
```

- [ ] **Step 2: Add required/optional tokens**

Change:

```ts
export const REQUIRED_TOKENS: Record<TemplateKey, string[]> = {
  invoice: [
    "{eventId}", "{handle}", "{produkLines}", "{subtotalBarang}", "{weightKg}", "{perKgRate}", "{sisaPelunasan}",
    "{bankAccountHolder}", "{bankAccountLines}", "{publicSiteUrl}",
  ],
  shipment: ["{event}", "{handle}", "{dataDiri}", "{items}", "{publicSiteUrl}"],
  refund_specific: ["{customer}", "{event}", "{itemsList}", "{refundAmount}"],
  refund_generic: ["{customer}", "{event}", "{refundAmount}"],
}

// Tokens allowed but not mandatory — currently only invoice's optional fee line.
export const OPTIONAL_TOKENS: Record<TemplateKey, string[]> = {
  invoice: ["{biayaLainnyaBlock}"],
  shipment: [],
  refund_specific: [],
  refund_generic: [],
}
```

to:

```ts
export const REQUIRED_TOKENS: Record<TemplateKey, string[]> = {
  invoice: [
    "{eventId}", "{handle}", "{produkLines}", "{subtotalBarang}", "{weightKg}", "{perKgRate}", "{sisaPelunasan}",
    "{bankAccountHolder}", "{bankAccountLines}", "{publicSiteUrl}",
  ],
  invoice_dp: [
    "{eventId}", "{handle}", "{produkLines}", "{subtotalBarang}", "{weightKg}", "{perKgRate}",
    "{dpAmount}", "{dpShortfall}", "{bankAccountHolder}", "{bankAccountLines}", "{publicSiteUrl}",
  ],
  shipment: ["{event}", "{handle}", "{dataDiri}", "{items}", "{publicSiteUrl}"],
  refund_specific: ["{customer}", "{event}", "{itemsList}", "{refundAmount}"],
  refund_generic: ["{customer}", "{event}", "{refundAmount}"],
}

// Tokens allowed but not mandatory — currently the invoice/invoice_dp fee
// line, plus invoice_dp's optional full-remaining-balance figure.
export const OPTIONAL_TOKENS: Record<TemplateKey, string[]> = {
  invoice: ["{biayaLainnyaBlock}"],
  invoice_dp: ["{biayaLainnyaBlock}", "{sisaPelunasan}"],
  shipment: [],
  refund_specific: [],
  refund_generic: [],
}
```

- [ ] **Step 3: Add the default template body**

In `DEFAULT_TEMPLATES`, add an `invoice_dp` entry right after `invoice` (before `shipment`):

```ts
  invoice_dp: [
    "INVOICE - DOWN PAYMENT",
    "{eventId} {handle}",
    "",
    "Produk:",
    "{produkLines}",
    "",
    "Subtotal Barang: Rp {subtotalBarang}",
    "Estimasi Ongkir: {weightKg} kg x Rp {perKgRate}{biayaLainnyaBlock}",
    "",
    "Down Payment yang dibutuhkan: Rp {dpAmount}",
    "Kekurangan Down Payment: Rp {dpShortfall}",
    "",
    "Rekening an {bankAccountHolder}:",
    "{bankAccountLines}",
    "",
    "Mohon lakukan pembayaran down payment agar pesanan diproses.",
    "",
    "Cek rekapan mandiri {publicSiteUrl}",
  ].join("\n"),
```

(This is inserted between the `invoice:` entry's closing `}),` and the `shipment:` entry — both untouched otherwise.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors in `app/dashboard/settings/SettingsClient.tsx` (its `SAMPLE_VARS`/`TEMPLATE_LABELS` records are no longer exhaustive over `TemplateKey`) — fixed in Task 7. No error should appear in `lib/message-templates.ts` itself, and no error in `lib/db/invoice.ts` yet (Task 6 references `templates.invoice_dp` which will type-check fine since it's now a valid key on `Record<TemplateKey, string>`).

- [ ] **Step 5: Commit**

```bash
git add lib/message-templates.ts
git commit -m "Add invoice_dp template key, tokens, and default text"
```

---

### Task 6: Threshold logic in `getInvoiceForCustomer`

**Files:**
- Modify: `lib/db/invoice.ts:16-53` (`buildInvoiceMessage`), `lib/db/invoice.ts:253-259` (message-building call site inside `getInvoiceForCustomer`)

**Interfaces:**
- Consumes: `BusinessProfile.dpPercent` (Task 2/3), `TemplateKey` `"invoice_dp"` + its tokens (Task 5).
- Produces: `InvoiceEvent.message` (unchanged shape — still just a `string`) now reflects the DP-vs-default choice. No consumer of `InvoiceEvent.message` (`InvoiceMessageActions`, the customer detail drawer, etc.) needs any change — they just render whichever string comes back.

- [ ] **Step 1: Extend `buildInvoiceMessage` to accept extra template vars**

Replace the `buildInvoiceMessage` function (lines 16-53) with:

```ts
function buildInvoiceMessage(
  event: Omit<InvoiceEvent, "message">,
  customer: string,
  template: string,
  profile: BusinessProfile,
  extraVars: Record<string, string> = {},
): string {
  const { orders, totals, invoice } = event
  const handle = customer.startsWith("@") ? customer : `@${customer}`
  // e.g. "Lip Balm x 2 x Rp 150,000" — o.order is "name x unit", o.price is the
  // formatted unit price.
  const produkLines = orders.map((o) => `${o.order} x Rp ${o.price}`).join("\n")

  const perKgCandidate = Number(invoice.ongkirPerKg)
  const perKg =
    Number.isFinite(perKgCandidate) && perKgCandidate > 0
      ? perKgCandidate
      : totals.weightKg > 0
        ? Math.round(invoice.estimasiOngkir / totals.weightKg)
        : 0

  const biayaLainnyaBlock = invoice.biayaLainnya !== 0
    ? `\nBiaya Lainnya: Rp ${formatIdrNumber(invoice.biayaLainnya)}`
    : ""

  return fillTemplate(template, {
    eventId: event.eventId,
    handle,
    produkLines,
    subtotalBarang: formatIdrNumber(invoice.subtotalBarang),
    weightKg: formatIdrNumber(totals.weightKg),
    perKgRate: formatIdrNumber(perKg),
    biayaLainnyaBlock,
    sisaPelunasan: formatIdrNumber(invoice.sisaPelunasan),
    bankAccountHolder: profile.bankAccountHolder,
    bankAccountLines: profile.bankAccountLines,
    publicSiteUrl: profile.publicSiteUrl,
    ...extraVars,
  })
}
```

(Only the function signature gained `extraVars` and the `fillTemplate` call spreads it in — everything else is unchanged from the current file.)

- [ ] **Step 2: Choose the template per event in `getInvoiceForCustomer`**

Replace the `return { ...base, message: ... }` block (lines 253-258) with:

```ts
    const dpThreshold = invoice.total * ((businessProfile?.dpPercent ?? 0) / 100)
    const meetsDpThreshold = invoice.total === 0 || invoice.pembayaran >= dpThreshold

    let message = ""
    if (templates && businessProfile) {
      message = meetsDpThreshold
        ? buildInvoiceMessage(base, customer, templates.invoice, businessProfile)
        : buildInvoiceMessage(base, customer, templates.invoice_dp, businessProfile, {
            dpAmount: formatIdrNumber(dpThreshold),
            dpShortfall: formatIdrNumber(Math.max(0, dpThreshold - invoice.pembayaran)),
          })
    }

    return { ...base, message }
```

The full `events.map` callback (after this change) should read:

```ts
  const events: InvoiceEvent[] = order.map((eid) => {
    const group = groups[eid]

    const orders: InvoiceOrderLine[] = group.map((r) => ({
      order: `${r.product_name} x ${r.unit}`,
      unit: r.unit,
      price: formatIdrNumber(r.unit_price),
      subtotal: formatIdrNumber(r.unit_price * r.unit),
      unitArrive: r.unit_arrive ?? 0,
      orderId: r.id as number,
      productName: r.product_name as string,
      rawUnitPrice: r.unit_price as number,
      unitBuy: (r.unit_buy as number) ?? 0,
    }))

    const { eta, totals, invoice } = computeEventCore(
      group,
      Number(group[0]?.ongkir ?? 0),
      paymentByEvent.get(eid) ?? 0,
      adjustmentByEvent.get(eid) ?? 0,
    )

    const base = {
      eventId: eid,
      eta,
      status: "",
      shipments: [] as InvoiceShipment[],
      showShipments: false,
      orders,
      totals,
      invoice,
    }

    const dpThreshold = invoice.total * ((businessProfile?.dpPercent ?? 0) / 100)
    const meetsDpThreshold = invoice.total === 0 || invoice.pembayaran >= dpThreshold

    let message = ""
    if (templates && businessProfile) {
      message = meetsDpThreshold
        ? buildInvoiceMessage(base, customer, templates.invoice, businessProfile)
        : buildInvoiceMessage(base, customer, templates.invoice_dp, businessProfile, {
            dpAmount: formatIdrNumber(dpThreshold),
            dpShortfall: formatIdrNumber(Math.max(0, dpThreshold - invoice.pembayaran)),
          })
    }

    return { ...base, message }
  })
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean, except (if Task 7 hasn't run yet in a different execution order) the pre-existing `SettingsClient.tsx` exhaustiveness errors from Task 5 — those are resolved by Task 7. No error should originate from `lib/db/invoice.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/db/invoice.ts
git commit -m "Send invoice_dp reminder when a customer is below the DP threshold"
```

---

### Task 7: Settings UI — DP % field and template editor entry

**Files:**
- Modify: `app/dashboard/settings/SettingsClient.tsx`

**Interfaces:**
- Consumes: `BusinessProfile.dpPercent` (Task 2/3/4), `TemplateKey` `"invoice_dp"` + `REQUIRED_TOKENS`/`OPTIONAL_TOKENS`/`DEFAULT_TEMPLATES` (Task 5).
- Produces: nothing further downstream — this is the last app-code task.

- [ ] **Step 1: Add the template label**

Change:

```ts
const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  invoice: "Invoice message",
  shipment: "Shipment confirmation",
  refund_specific: "Refund message — items unavailable",
  refund_generic: "Refund message — generic",
}
```

to:

```ts
const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  invoice: "Invoice message",
  invoice_dp: "Invoice message — DP reminder",
  shipment: "Shipment confirmation",
  refund_specific: "Refund message — items unavailable",
  refund_generic: "Refund message — generic",
}
```

- [ ] **Step 2: Add sample preview vars**

In `SAMPLE_VARS`, add an `invoice_dp` entry right after `invoice`:

```ts
  invoice_dp: {
    eventId: "EVT1",
    handle: "@customer",
    produkLines: "Lip Balm x 2 x Rp 150,000",
    subtotalBarang: "300,000",
    weightKg: "2",
    perKgRate: "50,000",
    biayaLainnyaBlock: "\nBiaya Lainnya: Rp 10,000",
    dpAmount: "90,000",
    dpShortfall: "40,000",
    sisaPelunasan: "300,000",
    bankAccountHolder: "Business Owner",
    bankAccountLines: "Bank Example 123456789",
    publicSiteUrl: "https://example.com/",
  },
```

(`invoice`'s existing entry stays exactly as-is, right before this one.)

- [ ] **Step 3: Add the DP % field to the Business Profile section**

In `BusinessProfileSection`'s JSX, inside the `<div className="grid md:grid-cols-2 gap-3">` block, add a new `<label>` right after the "Public site URL" one (before "Owner name"):

```tsx
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Down Payment %</span>
            <span className="text-[10px] text-gray-400">
              Customers below this % of an event's total get the DP reminder message instead of the invoice message. 0 = feature off.
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={profile.dpPercent}
              onChange={(e) => setProfileNumber("dpPercent", e.target.value)}
              className={fieldInputCls}
            />
          </label>
```

This uses a new `setProfileNumber` helper (number fields need `Number(...)`, unlike the existing `field` helper which only handles strings). Add it right after the existing `field` function inside `BusinessProfileSection`:

```ts
  function setProfileNumber(key: "dpPercent", value: string) {
    setProfile((p) => (p ? { ...p, [key]: Number(value) || 0 } : p))
  }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean, zero errors project-wide.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/settings/SettingsClient.tsx
git commit -m "Add Down Payment % field and DP-reminder template editor to Settings"
```

---

### Task 8: Seed the `invoice_dp` template row for existing databases

**Files:**
- Modify: `supabase/migrations/043_dp_percent.sql` (the file created in Task 1)

**Interfaces:**
- Consumes: `DEFAULT_TEMPLATES.invoice_dp`'s exact text (Task 5) — must match verbatim per the Global Constraints rule.
- Produces: a `message_templates` row for `key = 'invoice_dp'` on databases that already ran `040_settings.sql` before this feature existed (fresh databases running `040_settings.sql` today wouldn't have this row either, since that file isn't retroactively edited — this INSERT is what backfills it either way).

- [ ] **Step 1: Append the seed INSERT to the migration file**

Add to the end of `supabase/migrations/043_dp_percent.sql` (after the `ALTER TABLE` statement from Task 1):

```sql

-- Seed the invoice_dp template row (body must match
-- lib/message-templates.ts DEFAULT_TEMPLATES.invoice_dp verbatim — see the
-- 040_settings.sql header comment for why). ON CONFLICT DO NOTHING so an
-- owner who's already customized this template (impossible before this
-- migration runs, but keeps the statement idempotent/re-runnable) isn't
-- overwritten.
INSERT INTO message_templates (key, body) VALUES
('invoice_dp', $tpl$INVOICE - DOWN PAYMENT
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

Cek rekapan mandiri {publicSiteUrl}$tpl$)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Byte-compare against the TypeScript default**

Open `lib/message-templates.ts`'s `DEFAULT_TEMPLATES.invoice_dp` (added in Task 5) side by side with the `$tpl$...$tpl$` body just added, line by line. They must be identical text (the TS version is `.join("\n")`'d, so compare it to the raw SQL heredoc content, not to the array-of-strings source). This step has no command to run — it's a manual line-by-line read, because a mismatch here would only surface at runtime as "DB row differs from the app's own default," which nothing currently detects automatically (same blind spot the existing 4 templates have).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/043_dp_percent.sql
git commit -m "Seed invoice_dp message_templates row in the DP threshold migration"
```

---

### Task 9: Final verification pass

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: nothing — this is the terminal task.

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: clean exit, zero output.

- [ ] **Step 2: Confirm the migration file reads correctly end-to-end**

```bash
cat supabase/migrations/043_dp_percent.sql
```

Expected: one `ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS dp_percent ...` statement followed by one `INSERT INTO message_templates (key, body) VALUES ('invoice_dp', ...) ON CONFLICT (key) DO NOTHING;` statement. Confirm there are no stray `$tpl$` delimiter mismatches (each `$tpl$` opener has exactly one matching closer).

- [ ] **Step 3: Hand off migration + manual smoke test to the user**

This step is not automatable — it requires a real Supabase connection and real event/payment data. Tell the user:

> "Typecheck is clean. Before this is live, you need to:
> 1. Run `supabase/migrations/043_dp_percent.sql` in the Supabase SQL editor (as the postgres owner, per the project's migration workflow).
> 2. In `/dashboard/settings` → Business Profile, confirm 'Down Payment %' shows `0` and every existing invoice message is unchanged (feature-off default).
> 3. Set it to a real percentage (e.g. 30), open a customer/event where paid-so-far is under that %, and confirm 'View message' / 'Copy message' on that event now shows the DP reminder text with correct Rp amounts for `{dpAmount}`/`{dpShortfall}`.
> 4. Record a payment that pushes them over the threshold, reopen the invoice, and confirm it flips back to the normal invoice message.
> 5. Find (or make) a fully-cancelled event with total Rp 0, and confirm it always shows the normal invoice message, never the DP reminder — regardless of the DP % setting.
> 6. Check the Settings → Message Templates tab shows a 5th 'Invoice message — DP reminder' editor with a live preview, and that removing a required token from it and clicking Save is rejected with a 'Missing required token(s)' error."

- [ ] **Step 4: Commit (if any fixups were made during verification)**

```bash
git status
```

If clean, nothing to commit — Tasks 1-8's commits already cover the full feature. If any fixup was needed, `git add` the specific files and commit with a message describing the fix.
