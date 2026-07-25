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
}

export const DEFAULT_PRODUCT_DEFAULTS: ProductDefaults = {
  profitPct: 30,
  operationalFee: 5000,
  packingFee: 5000,
  markupPct: 5,
  // 5,000 matches how the catalogue is actually priced — see migration 050.
  tierKursRoundTo: 5000,
}
