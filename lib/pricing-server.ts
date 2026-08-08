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
//   tier_fee, VALAS   — the fee comes from the shared valas brackets, matched against a
//                       base cost that is itself derived from valas, the rate and the
//                       freight; nothing about it is typed either.
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

import {
  calcKursPrice, calcRupiahFeePrice, calcTierFeeValasPrice,
  flatFeeAmount, landedCost,
} from "./pricing"
import { isKursMethod } from "./pricing"
import type { FlatFeeMode, PricingMethod } from "./pricing"
import { resolveTieredKurs, resolveFlatKurs } from "./kurs-tiers"
import { resolveRupiahTierFee } from "./tier-fee"
import {
  getTierKursInputs, getTierFeeValasInputs, getFlatFeeSettings, getFlatKursInputs,
} from "./db"
import type { DBExecutor } from "./db/actor"

/**
 * A request whose pricing inputs cannot produce a price. Distinct from a database failure so
 * the routes can answer 400 rather than 500 — the caller sent something unusable, and saying
 * which field is more useful than a generic failure.
 */
export class PricingInputError extends Error {}

export interface ComputedPricing {
  /** Whole rupiah, for the INTEGER products.price column. */
  price: number
  /** The tiered rate actually used, to snapshot onto products.tiered_kurs. Null
   *  for every method other than tier_kurs. */
  tieredKurs: number | null
  /** The fee actually used, to snapshot onto products.profit_fixed — non-null for
   *  flat_fee and for valas-mode tier_fee. Null means "store what the body sent", which
   *  is what the other two do, including rupiah-mode tier_fee where the user types it. */
  profitFixed: number | null
  /** The rupiah cost to store. Non-null for the two valas fee modes, where cost is
   *  DERIVED from valas, the rate and the freight rather than typed — so it has to be
   *  resolved here rather than taken from the body, or the client could set a cost that
   *  contradicts the inputs beside it. Null means "store what the body sent". */
  cost: number | null
}

/**
 * The four inputs to landed cost, parsed off the body once.
 *
 * All three valas paths below read exactly these, and each of them needs them twice — once
 * for the base cost that picks a bracket, once for the price. Parsing them per use is how
 * two reads of the same field would start to disagree.
 */
function landedInputs(body: Record<string, unknown>): {
  valas: number; kurs: number; gram: number; cargoPerKg: number
} {
  return {
    valas: Number(body.valas) || 0,
    kurs: Number(body.kurs) || 0,
    gram: Number(body.gram) || 0,
    cargoPerKg: Number(body.cargoPerKg) || 0,
  }
}

/**
 * The price to fall back on when the formula yields 0 — the stored one if there is a row,
 * otherwise whatever the body sent.
 *
 * `|| 0` rather than a second `??`: a body with no `price` gives `Number(undefined)` = NaN,
 * which `??` passes through since NaN is neither null nor undefined. Every caller then
 * compares it with `> 0`, so a NaN would silently disable the guard.
 */
function fallbackPrice(
  current: { price: number } | undefined,
  body: Record<string, unknown>,
): number {
  return current?.price ?? (Number(body.price) || 0)
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
 * ceil(landedCost + bracketFee), with the bracket chosen by that same landed cost;
 * `body.price` and `body.profitFixed` are ignored. Without a country it is rupiah mode and
 * the submitted price stands.
 *
 * `countryId` drives both bracket lookups, AND decides which mode tier_fee is in. On
 * an update, callers MUST pass the STORED country_id when the body omits it — see the
 * PUT handler in app/api/sheets/products/[id]/route.ts for why. For tier_fee that is
 * doubly important: getting it wrong does not merely lose a country, it switches the
 * formula.
 *
 * `current` is the row's existing price and snapshots on an update; omit when creating.
 * Its `profitFixed` is what the row was actually priced with, so a save that KEEPS the
 * price keeps the fee that explains it — see the guards below.
 */
export async function computeProductPrice(opts: {
  pricingMethod: PricingMethod
  /** Only consulted for flat_fee: whether its fee is the fixed amount or a share of the
   *  base cost (migration 054). */
  flatFeeMode: FlatFeeMode
  countryId: number | null
  body: Record<string, unknown>
  db: DBExecutor
  current?: { price: number; tieredKurs: number | null; profitFixed: number }
}): Promise<ComputedPricing> {
  const { pricingMethod, flatFeeMode, countryId, body, db, current } = opts

  // Both Rate methods price as `valas × a rate this country configures`, so a Rate row with
  // no country has no rate to be charged at and no currency to have a valas in. Rejected
  // rather than defaulted: without this the bracket lookup matches nothing, the resolver
  // falls back, valas arrives as 0 because the form gates it on the country, and the row
  // saves at ceil(0 × kurs + packingFee) — Rp 5.000 for the default packing fee and rounding
  // step. Non-zero, so the Sheets-import guard below does not catch it either. A real price
  // was silently replaced by 5000 by clearing one field.
  if (isKursMethod(pricingMethod) && countryId == null) {
    throw new PricingInputError(
      `${pricingMethod === "flat_kurs" ? "Flat Rate" : "Rate"} products need a country`,
    )
  }

  if (pricingMethod === "flat_fee") {
    const { flatFee: fixedFee, flatFeePct, flatFeeMin } = await getFlatFeeSettings(db)

    // With a country the base is bought in foreign currency, so cost is landed cost —
    // converted goods plus freight — and is DERIVED, not typed. Without one it is the
    // rupiah figure the user entered. Same discriminator Tier Fee uses (migration 053),
    // now that a country means something for this method too.
    const valasMode = countryId != null
    // landedCost directly, not calcFlatFeeValasPrice: the fee cannot be known until the
    // cost is (percent mode reads it), so there is no price to compute yet — and calling the
    // price function with `fee: 0` only to throw the price away invited someone to "fix"
    // that zero.
    const cost = valasMode
      ? Math.round(landedCost(landedInputs(body)))
      : Math.round(Number(body.cost)) || 0
    // Resolved from cost, so it has to come after it. In fixed mode the base is ignored and
    // this is just the Settings amount.
    const flatFee = flatFeeAmount(flatFeeMode, cost, fixedFee, flatFeePct, flatFeeMin)
    const computed = Math.round(calcRupiahFeePrice(cost, flatFee))

    // Same guard as tier_kurs below, and for the same reason: a Sheets-imported row
    // with no cost would otherwise have a real price overwritten by just the fee on
    // an unrelated edit. Here that means keeping the stored price when there is no
    // cost to build one from.
    const fallback = fallbackPrice(current, body)
    if (cost === 0 && fallback > 0) {
      // The row's own fee, not the one just resolved: with no cost to work from, percent mode
      // resolves to the FLOOR (max(0, flat_fee_min)) and fixed mode to the Settings amount —
      // neither of which built the price being kept. Storing one would leave a row whose fee
      // and price contradict each other, which is exactly what the dryrun gates flag.
      return { price: Math.round(fallback), tieredKurs: null, profitFixed: current?.profitFixed ?? flatFee, cost: valasMode ? cost : null }
    }
    // cost returned only in valas mode; in rupiah mode the body's own value stands.
    return { price: computed, tieredKurs: null, profitFixed: flatFee, cost: valasMode ? cost : null }
  }

  // Valas mode: a Markup Tier product WITH a country. The country supplies the rate and the
  // freight rate; the brackets themselves are shared by every country (migrations 056/057).
  if (pricingMethod === "tier_fee" && countryId != null) {
    const { brackets, roundTo } = await getTierFeeValasInputs(db)
    const inputs = landedInputs(body)
    const landed = Math.round(landedCost(inputs))

    // Resolved from the live table against the RUPIAH base cost, never from the body. No
    // bracket means a fee of 0, which prices the product at cost — the same visible,
    // self-correcting failure Tier Kurs has when a country has no brackets.
    const fee = resolveRupiahTierFee(brackets, landed)
    const computed = Math.round(calcTierFeeValasPrice({ ...inputs, fee, roundTo }).price)

    // Same Sheets-import guard as the other authoritative paths, and the fee is kept with the
    // price for the same reason as in flat_fee above.
    const fallback = fallbackPrice(current, body)
    if (computed === 0 && fallback > 0) {
      return { price: Math.round(fallback), tieredKurs: null, profitFixed: current?.profitFixed ?? fee, cost: landed }
    }
    // The fee is rupiah, so it snapshots onto profit_fixed like the other two fee modes —
    // the superseded per-country shape needed its own foreign-currency column for this. Cost
    // is derived, so it is returned for storage rather than taken from the body.
    return { price: computed, tieredKurs: null, profitFixed: fee, cost: landed }
  }

  // The flat sibling of tier_kurs below: one rate for the whole country, so there is no
  // bracket to match a valas against. Everything else — which rate cost is booked at, the
  // rounding, the snapshot onto tiered_kurs, the import guard — is identical, which is why
  // both call calcKursPrice.
  if (pricingMethod === "flat_kurs") {
    const valas = Number(body.valas) || 0
    const kurs = Number(body.kurs) || 0
    const { flatKurs, roundTo } = await getFlatKursInputs(countryId, db)

    // From the live table, never from the body — the charged rate IS this method's entire
    // margin, so a client-supplied one would be a client-supplied margin. `kurs` is the
    // fallback for the same reason resolveTieredKurs takes it: a country with no rate set
    // then prices at cost rather than at a rate its cost was not booked at.
    const chargedKurs = resolveFlatKurs(flatKurs, kurs)
    const computed = Math.round(calcKursPrice({
      valas, chargedKurs, kurs, roundTo,
      gram: Number(body.gram) || 0,
      cargoPerKg: Number(body.cargoPerKg) || 0,
      packingFee: Number(body.packingFee) || 0,
    }).price)

    // Same Sheets-import guard the other authoritative paths carry: a row migrated from the
    // spreadsheet holds a real price but none of the inputs a formula needs, so recomputing
    // yields 0 and an unrelated edit would wipe it.
    const fallback = fallbackPrice(current, body)
    if (computed === 0 && fallback > 0) {
      return { price: Math.round(fallback), tieredKurs: chargedKurs, profitFixed: null, cost: null }
    }

    // tiered_kurs holds "the rate this row was charged at" for BOTH Rate methods, not just
    // the bracketed one — so the Tier Rate column reads the same column whichever member
    // priced the row.
    return { price: computed, tieredKurs: chargedKurs, profitFixed: null, cost: null }
  }

  if (pricingMethod !== "tier_kurs") {
    // overseas and rupiah-mode tier_fee: the browser's price stands, as it always
    // has. Returning a null tieredKurs also drops whatever rate a row carried from
    // another method before it was switched to this one.
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
      return { price: Math.round(stored), tieredKurs: null, profitFixed: null, cost: null }
    }

    return { price: submitted, tieredKurs: null, profitFixed: null, cost: null }
  }

  const valas = Number(body.valas) || 0
  const kurs = Number(body.kurs) || 0
  const { kursTiers, roundTo } = await getTierKursInputs(countryId, db)

  // Resolved from the live table, never from the body. The fallback is `kurs` —
  // the same rate cost is booked at — so a country with no brackets yields a
  // spread of exactly 0 rather than a rate mismatch.
  const tieredKurs = resolveTieredKurs(kursTiers, valas, kurs)
  // gram and cargoPerKg move only `cogs`, which nothing here stores. packingFee DOES move
  // the price, but it is a pass-through charge the user sets — like valas, not like the
  // tiered rate — so the body is its rightful source.
  const computed = Math.round(calcKursPrice({
    valas, chargedKurs: tieredKurs, kurs, roundTo,
    gram: Number(body.gram) || 0,
    cargoPerKg: Number(body.cargoPerKg) || 0,
    packingFee: Number(body.packingFee) || 0,
  }).price)

  // Some products carry a price imported directly from the original Google Sheets
  // migration, with none of the inputs a formula needs. Recomputing those yields
  // 0, so an unrelated edit — fixing a store name — would silently wipe a real
  // price. Keep the existing one; it self-corrects once the inputs are filled in.
  const fallback = fallbackPrice(current, body)
  if (computed === 0 && fallback > 0) {
    return { price: Math.round(fallback), tieredKurs, profitFixed: null, cost: null }
  }

  return { price: computed, tieredKurs, profitFixed: null, cost: null }
}
