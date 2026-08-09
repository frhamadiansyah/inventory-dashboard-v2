# Flat Kurs — a fifth pricing method, and "Tier Kurs" becomes "Rate" — Design

**Date:** 2026-08-08
**Branch:** `flat-kurs`

## Goal

Give the Rate family a second member. Today `tier_kurs` charges a rate resolved
from that country's brackets, so the rate moves with the size of the purchase.
Flat Kurs charges **one rate per country**, whatever the valas.

The two sit behind a single **Rate** tab with a **Tier | Flat** toggle — the same
shape Markup already has, where `tier_fee` and `flat_fee` share one tab and one
toggle.

Also: the tab currently labelled "Tier Kurs" is renamed **Rate**, since it now
names a family rather than one method.

## Background (current behavior)

- `products.pricing_method` holds one of four values, constrained by
  `products_pricing_method_check` in `supabase/migrations/050_pricing_methods.sql:70`.
- Tier Kurs prices as `ceilTo(valas × tieredKurs + packingFee, roundTo)`, with
  cost booked separately at the country's actual rate — `calcTierKursPrice` in
  `lib/pricing.ts:264`.
- The charged rate is resolved from `country_kurs_tiers` by `resolveTieredKurs`
  (`lib/kurs-tiers.ts:63`), which falls back to the country's own rate when no
  bracket matches. A country with no brackets therefore prices at zero spread —
  visible, and self-correcting once brackets exist.
- The server is the authority: `computeProductPrice`
  (`lib/pricing-server.ts:218-245`) re-resolves the rate inside the write
  transaction and ignores `body.price` and `body.tieredKurs`, because the rate
  *is* the entire margin for this method.
- The brackets are edited per country in Settings → Pricing
  (`app/dashboard/settings/KursTiersSection.tsx`), one accordion row per country,
  each with its own draft and its own Save. The API writes one country's whole
  set atomically (`PUT /api/sheets/kurs-tiers`).
- Markup's equivalent split is stored as **two pricing methods**, not a mode
  column: `tier_fee` takes its fee from shared rupiah brackets, `flat_fee` from
  one Settings figure the server re-reads.

## Decisions

**1. Flat Kurs is a fifth `pricing_method`, not a mode column on `tier_kurs`.**

Markup's Tier/Flat pair is stored as two methods behind one toggle. Same UI
shape gets the same data shape; a `kurs_mode` column would make two visually
identical toggles store differently, and nothing would force a later reader to
discover the second shape. Cost accepted: every exhaustive `switch` and
`Record<PricingMethod>` must gain an entry — which the compiler enforces.

**2. The flat rate is per country, stored on `countries`.**

A rate is currency-specific — 226 for JPY, ~17.000 for USD — so one global number
cannot serve every country. Rejected alternatives: a rate typed per product
(breaks the rule the whole method rests on, that a typed rate is a typed margin),
and a global markup percentage (an extra indirection over `countries.kurs` when
the owner already thinks in absolute rates).

**3. Edited in Settings → Pricing, not on the Countries page.**

The flat rate is the direct alternative to the brackets, so it belongs in the
panel that shows them. Follows `5a32db1`, which deliberately folded Tier Kurs
config into this tab.

**4. Both Rate methods require a country.** See "Country is required" below.

## Data model — migration `053_flat_kurs.sql`

```sql
ALTER TABLE products DROP CONSTRAINT products_pricing_method_check;
ALTER TABLE products ADD CONSTRAINT products_pricing_method_check
  CHECK (pricing_method IN ('overseas','tier_fee','flat_fee','tier_kurs','flat_kurs'));

ALTER TABLE countries
  ADD COLUMN IF NOT EXISTS flat_kurs NUMERIC(12,4) NOT NULL DEFAULT 0;
```

`NUMERIC(12,4)` matches both `countries.kurs` and `country_kurs_tiers.kurs` — the
same kind of number, so the same precision.

`0` means unset, and is what every existing country gets. No backfill: no row
changes behaviour until the owner enters a rate and switches a product to the
method.

**Naming note.** `supabase/migrations/051_pricing_brackets.sql:40` already uses
the words "its flat kurs" to mean `countries.kurs`. That is prose in an applied
migration and must not be edited. The new column takes the name anyway, matching
the method it serves; its own column comment states that `countries.kurs` is the
cost rate and `countries.flat_kurs` the charged one.

## Pricing math

The formula is **identical** to Tier Kurs:

```
cogs  = valas × kurs + (gram / 1000) × cargoPerKg      (the country's actual rate)
price = ceilTo(valas × chargedRate + packingFee, roundTo)
```

Only the source of `chargedRate` differs, and that value is already passed in
rather than looked up. So there is no new math function.

That does make the current names lie, so rename in `lib/pricing.ts`:

- `calcTierKursPrice` → `calcKursPrice`
- `tierKursProfit` → `kursProfit`
- `TierKursPriceInput` → `KursPriceInput`, and its `tieredKurs` field →
  `chargedKurs`

Mechanical, and every call site is compiler-checked.

`PRICING_METHODS` gains `flat_kurs`. `PRICING_METHOD_LABEL` becomes:

| method | label |
|---|---|
| `overseas` | Profit Margin |
| `tier_fee` | Markup |
| `flat_fee` | Flat Fee |
| `tier_kurs` | **Rate** (was "Tier Kurs") |
| `flat_kurs` | **Flat Rate** |

`METHOD_TABS` is unchanged — still three tabs, with Flat Rate reached through the
toggle, exactly as Flat Fee is.

## Server authority

`computeProductPrice` gains a `flat_kurs` branch beside the `tier_kurs` one. It:

- reads `countries.flat_kurs` for `countryId` via a new `getFlatKursInputs`
  in `lib/db/catalog.ts`, alongside `product_defaults.tier_kurs_round_to`, in one
  round trip inside the write transaction — same shape as `getTierKursInputs`
- falls back to **the rate this row books as cost** — `body.kurs`, the value being
  snapshotted onto the product — when `flat_kurs` is 0, giving the same
  zero-spread, self-correcting failure a country with no brackets already has.

  **Not `countries.kurs`.** `lib/kurs-tiers.ts:58-61` spells out why: the fallback
  must be the same rate cost is booked at, or the unset case produces a spread
  instead of pricing at cost. `computeProductPrice` already honours this for
  `tier_kurs` by passing `body.kurs` (`lib/pricing-server.ts:225`).

  The client preview must use the same fallback — `costRate` in the Add form,
  `tierKursCostRate` in the Edit modal. Note that `tier_kurs` does **not**: its
  preview passes `selectedCountry.kurs` while the server passes `body.kurs`, and
  those differ whenever a live rate is in play, so the no-brackets preview shows a
  spread the save then removes. Flat Kurs does not inherit that; fixing it for
  `tier_kurs` is out of scope here.
- ignores `body.price` and `body.tieredKurs`
- snapshots the resolved rate onto `products.tiered_kurs`, as `tier_kurs` does
- carries the same Sheets-import guard: a computed 0 against a stored price > 0
  keeps the stored price

`products.tiered_kurs` now means "the rate this row was charged at" for both Rate
methods rather than for `tier_kurs` alone. Column comment updated to say so; no
schema change, and the two sites that gate on it
(`ProductsPageClient.tsx:461,475`) move to the widened helper below.

## Country is required

Both Rate methods need a country, and `flat_kurs` joins `overseas` and
`tier_kurs` in `methodNeedsCountry`.

The Add form already enforces this: its Tier Kurs branch renders its own country
select (`ProductsPageClient.tsx:1580-1592`) listing countries only — the
`IDR (Rupiah)` option exists solely on the hoisted `countrySelect` the two fee
methods use. Flat Kurs reuses that same branch and inherits the constraint.

**The Edit modal does not enforce it, and the gap silently reprices rows.**
`ProductsPageClient.tsx:2486-2499` renders one Country field for every method
with `clearable` and placeholder "Domestic". Clearing it on a Tier Kurs row
sends `countryId: null` and — because valas is gated on `draft.countryId != null`
— `valas: 0`. Server-side, `getTierKursInputs(null)` matches no brackets,
`resolveTieredKurs([], 0, kurs)` returns `kurs`, and the price becomes
`ceilTo(0 × kurs + packingFee, 5000)` = **Rp 5.000**. Non-zero, so the
Sheets-import guard does not catch it. The row is repriced to Rp 5.000 by
clearing one field.

This predates the feature and is fixed as part of it:

- Edit modal: `clearable={!methodNeedsCountry(draft.method)}`, so the × is absent
  for `overseas`, `tier_kurs` and `flat_kurs`
- `computeProductPrice`: either Rate method with a null `countryId` is a 400
  naming the method, rather than a priced country-less row

**Pre-flight, before the server guard ships:**

```sql
SELECT count(*) FROM products WHERE pricing_method = 'tier_kurs' AND country_id IS NULL;
```

Must be 0. If it is not, those rows are already mispriced and cannot be saved
through the form until a country is picked — decide whether to backfill them
first or let the 400 surface it.

## Settings → Pricing

`KursTiersSection` keeps its per-country accordion. Each panel gains one **Flat
rate** number field above the bracket list, inside the same draft and covered by
the same Save. Card title "Tier Kurs" → "Rate"; the section's own copy explains
that the flat rate serves Flat Rate products and the brackets serve Tier Rate
ones, and that a country may have both.

The collapsed header summary gains the flat rate beside the existing spread, so
"which countries are configured, and how" still reads without expanding.

`PUT /api/sheets/kurs-tiers` gains an optional `flatKurs` in its body, validated
against the same `MAX_KURS` ceiling the brackets use and rounded to the column's
4 decimal places before storage. `replaceKursTiers` writes `countries.flat_kurs`
in the **same transaction** as the bracket rows: one Save button hitting two
endpoints could half-apply.

`CountryRow` gains `flatKurs`, so `/api/sheets/countries` carries it to the form
for the preview and the popover.

## Product form

**Rate toggle.** A `rateSourceToggle`, built from the same shape as
`feeSourceToggle` (`ProductsPageClient.tsx:1281-1311`), switching between
`tier_kurs` and `flat_kurs`. Rendered in the Tier Kurs grid branch in the Add
form and beside the method tabs in the Edit modal, mirroring where the Fee toggle
sits.

**One asymmetry, deliberate.** Markup's Flat *clears* the country, because its
fee is a single rupiah setting with no valas form to be in. Rate's Flat **keeps**
it, because its rate is per country. Same toggle, opposite country behaviour —
called out in a comment at both sites.

**Charged field.** Stays read-only in both modes; only its source changes. In
Flat mode it shows `countries.flat_kurs`, falling back to the row's cost rate as
above.

**`KursTierPopover`** gains a flat variant: instead of the bracket table it names
the country's flat rate and, when the fallback is in play, says the country has
no flat rate set and is charging its cost rate.

**Readout bar.** `flat_kurs` gets its own entry in the `readouts` Record — the
same MARKUP RATE / SHIPPING / COST / PROFIT figures Tier Kurs shows, since the
cost side is identical.

## Fallout

Compiler-enforced by the widened `PricingMethod` union:

- `readouts` Record — `ProductsPageClient.tsx:1367`
- badge `tone` Record — `ProductsPageClient.tsx:404`
- the duplicate `switch` with its `never` guard — `ProductsPageClient.tsx:980-1017`
  (`flat_kurs` copies `packFee` like `tier_kurs`; the rate is deliberately not
  copied, since the server re-resolves it)
- `PRICING_METHODS`, `PRICING_METHOD_LABEL` — `lib/pricing.ts:10,15`

Not compiler-enforced, so each needs finding by hand:

- `isTierKurs` → `isKursMethod`, covering both methods, so the Tier Rate and
  Shipping/kg columns render for Flat Rate rows too
  (`ProductsPageClient.tsx:122,461,475`)
- `methodNeedsCountry` — `ProductsPageClient.tsx:145`
- the search filter's keyword chain, `lib/db/catalog.ts:204-224`. It is an
  if/else chain, so order matters:

  | typed | before | after |
  |---|---|---|
  | `flat` | `flat_fee` | `flat_fee`, `flat_kurs` |
  | `kurs` | `tier_kurs` | `tier_kurs`, `flat_kurs` |
  | `rate` | — | `tier_kurs`, `flat_kurs` |
  | `mark` | `tier_fee` | unchanged |
  | `fee` | `tier_fee`, `flat_fee` | unchanged |
  | `tier` | `tier_fee`, `tier_kurs` | unchanged |

- `lib/db/catalog.ts` insert and update statements already pass
  `pricing_method` through as a value, so they need no change

## Out of scope

- Repricing existing `tier_kurs` rows. Nothing about them changes.
- A per-product override of the flat rate. If the owner wants one product at a
  different rate, that is a bracket or a different method.
- Percent-mode flat rate. `flat_fee` has one because a fee scales with cost; a
  rate does not.
