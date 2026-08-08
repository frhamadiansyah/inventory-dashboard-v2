// Default values pre-filled into the Add Product form (overseas pricing:
// profit %, operational fee, packing fee). Edited from /dashboard/settings —
// only changes what a *new* product form starts with, never touches existing
// products' stored values.
//
// Three of these are the exception and say so on themselves: tierKursRoundTo,
// profitMarginRoundTo and the three flat-fee figures are read when a price is COMPUTED, so
// they move existing products on their next save.

import type { PricingMethod } from "./pricing"

export interface ProductDefaults {
  profitPct: number
  operationalFee: number
  packingFee: number
  markupPct: number
  /**
   * Rounding step for the Tier Kurs method (migration 050).
   *
   * Unlike every other field here this is NOT merely a form pre-fill: it is read
   * at price-computation time by lib/pricing-server.ts, so changing it reprices
   * Tier Kurs products on their next save.
   */
  tierKursRoundTo: number
  /**
   * Rounding step for the Profit Margin method (migration 054), replacing the hardcoded
   * ceilTo1000() that method used to carry.
   *
   * Its own column rather than a share of tierKursRoundTo: the two are different numbers
   * (1000 and 5000) and the owner set neither of them together.
   *
   * Unlike tierKursRoundTo this is applied CLIENT-side — an overseas price is computed by
   * the form and stored as submitted (see lib/pricing-server.ts) — so it moves a product
   * only when that product is next saved through the form.
   */
  profitMarginRoundTo: number
  /**
   * The fee added to base cost by the Flat Fee method (migration 052).
   *
   * Also NOT a form pre-fill: it is resolved server-side at save time, which is the
   * whole point of the method — every Flat Fee product is priced from this one
   * number, so changing it reprices them all on their next save.
   */
  flatFee: number
  /**
   * The percentage of base cost charged when a Flat Fee row is in percent mode
   * (migration 054). Same authority as flatFee — server-resolved at save time — so
   * changing it reprices every percent-mode Flat Fee product on its next save.
   */
  flatFeePct: number
  /**
   * A floor under the percent-mode Flat Fee (migration 055). 0 means no floor.
   *
   * Percent mode only: a minimum under a fixed amount would either do nothing or replace
   * the owner's chosen fee with a different constant.
   */
  flatFeeMin: number
  /**
   * Which country the Add Product form's Country field starts on (migration 052).
   *
   * NULL is a real value, not "unset": the field offers "IDR (Rupiah)", so a null default starts
   * the form in rupiah mode — which for the two fee methods decides whether the base cost is
   * typed or derived.
   *
   * A pre-fill only. Nothing reads it at price-computation time, so changing it cannot move a
   * stored price.
   */
  defaultCountryId: number | null
  /**
   * Which pricing method the Add Product form opens on (migration 055).
   *
   * A pre-fill, like defaultCountryId beside it: no stored product reads it, and a row's own
   * pricing_method is what prices it.
   *
   * Note the three methods that need a country — overseas and both Rate methods. Pairing one
   * of those with a null defaultCountryId is legal and simply opens the form with the Country
   * field empty, which is the same state it had before this setting existed.
   */
  defaultPricingMethod: PricingMethod
}

export const DEFAULT_PRODUCT_DEFAULTS: ProductDefaults = {
  profitPct: 30,
  operationalFee: 5000,
  packingFee: 5000,
  markupPct: 5,
  // 5,000 matches how the catalogue is actually priced — see migration 050.
  tierKursRoundTo: 5000,
  // 1,000 is exactly what ceilTo1000() did before migration 054, so an install that never
  // touches this keeps the prices it always produced.
  profitMarginRoundTo: 1000,
  // The owner's starting value, not a derived one. Editable in Settings.
  flatFee: 10_000,
  // 0 until the owner sets one: a percent-mode row then prices at cost, which is visible
  // in the profit readout rather than silently applying a rate nobody chose.
  flatFeePct: 0,
  // Inert until set: MAX(fee, 0) is fee.
  flatFeeMin: 0,
  // No country, i.e. "IDR (Rupiah)". Only the fallback for a form whose settings have not
  // loaded and the target of Settings' reset button — migration 052 seeds the real column with
  // the country the form used to hardcode, so an existing install keeps its behaviour.
  defaultCountryId: null,
  // What the form hardcoded before migration 055, so an install that never touches this
  // opens exactly where it always did.
  defaultPricingMethod: "overseas",
}
