// Server-side pricing authority for the methods whose margin is NOT typed by the
// user.
//
// The product routes otherwise store whatever `price` the browser sends, which is
// how this app has always worked and is left alone here: repricing the whole
// catalogue server-side is a separate decision with its own migration risk.
//
// Three cases are different and get recomputed:
//
//   tier_kurs         — its entire margin IS one number, the inflated rate, and that
//                       rate is not typed at all: it is looked up from
//                       country_kurs_tiers. A client-supplied `tieredKurs` would be
//                       a client-supplied margin.
//   flat_fee          — the fee is one global setting, which is the only thing
//                       distinguishing this method from Tier Fee. If the body could
//                       supply it, the two would be the same method with different
//                       labels.
//   tier_fee, VALAS   — the fee comes from the country's brackets and is converted at
//                       the country's rate; nothing about it is typed either.
//
// tier_fee in RUPIAH mode is the exception and keeps the client-computed price: its
// fee has always been typed on the product, with the brackets merely pre-filling the
// field, and taking that over would overwrite every manual fee in the catalogue.
// Which mode a row is in is decided by whether it has a country — see migration 053.
//
// All lookups happen here, inside the write transaction, so the value that priced the
// row is the value that was committed.
//
// The math itself lives in lib/pricing.ts, which has no imports and runs unchanged
// in the browser for the form's live preview.

import { calcTierKursPrice, calcRupiahFeePrice, calcTierFeeValasPrice } from "./pricing"
import type { PricingMethod } from "./pricing"
import { resolveTieredKurs } from "./kurs-tiers"
import { resolveTierFee } from "./tier-fee"
import { getTierKursInputs, getTierFeeValasInputs, getFlatFee } from "./db"
import type { DBExecutor } from "./db/actor"

export interface ComputedPricing {
  /** Whole rupiah, for the INTEGER products.price column. */
  price: number
  /** The tiered rate actually used, to snapshot onto products.tiered_kurs. Null
   *  for every method other than tier_kurs. */
  tieredKurs: number | null
  /** The fee actually used, to snapshot onto products.profit_fixed — non-null only
   *  for flat_fee. Null means "store what the body sent", which is what every other
   *  method does, including rupiah-mode tier_fee where the user types the fee. */
  profitFixed: number | null
  /** The valas fee actually used, to snapshot onto products.fee_valas. Non-null only
   *  for valas-mode tier_fee. */
  feeValas: number | null
}

/**
 * The price and any server-resolved inputs to store.
 *
 * For `overseas` and rupiah-mode `tier_fee` this returns the submitted price — those
 * two keep the pre-existing client-computed behaviour.
 *
 * For `tier_kurs` the price is recomputed from valas, the resolved bracket rate and
 * the configured rounding step; `body.price` and `body.tieredKurs` are both ignored.
 *
 * For `flat_fee` the price is recomputed as cost + the configured flat fee, and
 * `body.price` / `body.profitFixed` are both ignored.
 *
 * For `tier_fee` WITH a country the price is recomputed as
 * ceil((valas + bracketFee) × kurs); `body.price` and `body.feeValas` are ignored.
 * Without a country it is rupiah mode and the submitted price stands.
 *
 * `countryId` drives both bracket lookups, AND decides which mode tier_fee is in. On
 * an update, callers MUST pass the STORED country_id when the body omits it — see the
 * PUT handler in app/api/sheets/products/[id]/route.ts for why. For tier_fee that is
 * doubly important: getting it wrong does not merely lose a country, it switches the
 * formula.
 *
 * `current` is the row's existing price and snapshots on an update; omit when
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

  if (pricingMethod === "flat_fee") {
    const cost = Math.round(Number(body.cost)) || 0
    const flatFee = await getFlatFee(db)
    const computed = Math.round(calcRupiahFeePrice(cost, flatFee))

    // Same guard as tier_kurs below, and for the same reason: a Sheets-imported row
    // with no cost would otherwise have a real price overwritten by just the fee on
    // an unrelated edit. Here that means keeping the stored price when there is no
    // cost to build one from.
    const fallback = current?.price ?? Number(body.price) ?? 0
    if (cost === 0 && fallback > 0) {
      return { price: Math.round(fallback), tieredKurs: null, profitFixed: flatFee, feeValas: null }
    }
    return { price: computed, tieredKurs: null, profitFixed: flatFee, feeValas: null }
  }

  // Valas mode: a Tier Fee product WITH a country. The country supplies both the
  // bracket set and the rate, so `countryId` alone decides mode — there is no
  // separate flag to fall out of sync with.
  if (pricingMethod === "tier_fee" && countryId != null) {
    const valas = Number(body.valas) || 0
    const kurs = Number(body.kurs) || 0
    const { brackets, roundTo } = await getTierFeeValasInputs(countryId, db)

    // Resolved from the live table, never from the body. No bracket means a fee of 0,
    // which prices the product at cost — the same visible, self-correcting failure
    // Tier Kurs has when a country has no brackets.
    const feeValas = resolveTierFee(brackets, valas)
    const computed = Math.round(calcTierFeeValasPrice({ valas, feeValas, kurs, roundTo }).price)

    // Same Sheets-import guard as the other two authoritative paths.
    const fallback = current?.price ?? Number(body.price) ?? 0
    if (computed === 0 && fallback > 0) {
      return { price: Math.round(fallback), tieredKurs: null, profitFixed: 0, feeValas }
    }
    // profitFixed 0, not null: the rupiah fee column is meaningless for a row whose
    // fee is denominated in valas, and leaving it to the body would let a stale
    // rupiah fee ride along from before the product switched modes.
    return { price: computed, tieredKurs: null, profitFixed: 0, feeValas }
  }

  if (pricingMethod !== "tier_kurs") {
    // overseas and rupiah-mode tier_fee: the browser's price stands, as it always
    // has. Clearing tieredKurs and feeValas here also drops whatever a row carried
    // from another method before it was switched to this one.
    const submitted = Math.round(Number(body.price)) || 0

    // The same Sheets-import guard the three authoritative paths carry, and it belongs
    // here most of all. 40 of the 43 rupiah tier_fee rows are original spreadsheet
    // imports: they hold a real price but no cost and no fee, so the form computes
    // cost + fee = 0 and, without this, saving one — even just to fix a typo in its
    // name — replaced a real price with 0. The same path opens up when a valas-mode row
    // is switched to rupiah before a cost has been entered.
    //
    // The cost of the guard: a price can no longer be driven to 0 through the form once
    // the row has one. Getting there means zeroing every pricing input, which leaves a
    // row with no pricing data at all — precisely the state this exists to stop being
    // mistaken for a decision. Set it directly if you really mean 0.
    const stored = current?.price ?? 0
    if (submitted === 0 && stored > 0) {
      return { price: Math.round(stored), tieredKurs: null, profitFixed: null, feeValas: null }
    }

    return { price: submitted, tieredKurs: null, profitFixed: null, feeValas: null }
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
    return { price: Math.round(fallback), tieredKurs, profitFixed: null, feeValas: null }
  }

  return { price: computed, tieredKurs, profitFixed: null, feeValas: null }
}
