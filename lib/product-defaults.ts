// Default values pre-filled into the Add Product form (overseas pricing:
// profit %, operational fee, packing fee). Edited from /dashboard/settings —
// only changes what a *new* product form starts with, never touches existing
// products' stored values.

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
   * The fee added to base cost by the Flat Fee method (migration 052).
   *
   * Also NOT a form pre-fill: it is resolved server-side at save time, which is the
   * whole point of the method — every Flat Fee product is priced from this one
   * number, so changing it reprices them all on their next save.
   */
  flatFee: number
}

export const DEFAULT_PRODUCT_DEFAULTS: ProductDefaults = {
  profitPct: 30,
  operationalFee: 5000,
  packingFee: 5000,
  markupPct: 5,
  // 5,000 matches how the catalogue is actually priced — see migration 050.
  tierKursRoundTo: 5000,
  // The owner's starting value, not a derived one. Editable in Settings.
  flatFee: 10_000,
}
