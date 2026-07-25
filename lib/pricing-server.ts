// Server-side pricing authority for the Tier Kurs method.
//
// The product routes otherwise store whatever `price` the browser sends, which is
// how this app has always worked and is left alone here: repricing the whole
// catalogue server-side is a separate decision with its own migration risk.
//
// Tier Kurs is different, and gets recomputed. Its entire margin IS one number —
// the inflated rate — and that rate is not typed by the user at all: it is looked
// up from country_kurs_tiers. A client-supplied `tieredKurs` would therefore be a
// client-supplied margin, so the value in the request body is ignored and the
// bracket lookup is redone here, inside the write transaction.
//
// The math itself lives in lib/pricing.ts, which has no imports and runs unchanged
// in the browser for the form's live preview.

import { calcTierKursPrice } from "./pricing"
import type { PricingMethod } from "./pricing"
import { resolveTieredKurs } from "./kurs-tiers"
import { getTierKursInputs } from "./db"
import type { DBExecutor } from "./db/actor"

export interface ComputedPricing {
  /** Whole rupiah, for the INTEGER products.price column. */
  price: number
  /** The tiered rate actually used, to snapshot onto products.tiered_kurs. Null
   *  for every method other than tier_kurs. */
  tieredKurs: number | null
}

/**
 * The price and tiered rate to store.
 *
 * For `overseas` and `domestic` this returns the submitted price unchanged — those
 * two keep the pre-existing client-computed behaviour. For `tier_kurs` the price is
 * recomputed from valas, the resolved bracket rate and the configured rounding
 * step, and `body.price` / `body.tieredKurs` are both ignored.
 *
 * `countryId` drives the bracket lookup. On an update, callers MUST pass the
 * STORED country_id when the body omits it — see the PUT handler in
 * app/api/sheets/products/[id]/route.ts for why.
 *
 * `current` is the row's existing price and tiered rate on an update; omit when
 * creating.
 */
export async function computeProductPrice(opts: {
  pricingMethod: PricingMethod
  countryId: number | null
  body: Record<string, unknown>
  db: DBExecutor
  current?: { price: number; tieredKurs: number | null }
}): Promise<ComputedPricing> {
  const { pricingMethod, countryId, body, db, current } = opts

  if (pricingMethod !== "tier_kurs") {
    // Unchanged behaviour for the two original methods, including clearing any
    // stale tiered rate left over from a product that used to be Tier Kurs.
    return { price: Math.round(Number(body.price)) || 0, tieredKurs: null }
  }

  const valas = Number(body.valas) || 0
  const kurs = Number(body.kurs) || 0
  const { kursTiers, roundTo } = await getTierKursInputs(countryId, db)

  // Resolved from the live table, never from the body. The fallback is `kurs` —
  // the same rate cost is booked at — so a country with no brackets yields a
  // spread of exactly 0 rather than a rate mismatch.
  const tieredKurs = resolveTieredKurs(kursTiers, valas, kurs)
  const computed = Math.round(calcTierKursPrice({ valas, tieredKurs, kurs, roundTo }).price)

  // Some products carry a price imported directly from the original Google Sheets
  // migration, with none of the inputs a formula needs. Recomputing those yields
  // 0, so an unrelated edit — fixing a store name — would silently wipe a real
  // price. Keep the existing one; it self-corrects once the inputs are filled in.
  const fallback = current?.price ?? Number(body.price) ?? 0
  if (computed === 0 && fallback > 0) {
    return { price: Math.round(fallback), tieredKurs }
  }

  return { price: computed, tieredKurs }
}
