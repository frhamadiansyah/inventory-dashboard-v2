// Pure product-pricing math — the single source of truth shared by the product
// forms (client) and any server-side use. No imports, so safe on both sides.

/** The pricing methods. Stored on products.pricing_method (migration 050), which
 *  replaced `country_id IS NULL` as the formula discriminator — a Tier Kurs product
 *  has a country but must not use the overseas formula. `flat_fee` was added in
 *  migration 052, `flat_kurs` in 053. */
export type PricingMethod = "overseas" | "tier_fee" | "tier_kurs" | "flat_fee" | "flat_kurs"

export const PRICING_METHODS: readonly PricingMethod[] = [
  "overseas", "tier_fee", "flat_fee", "tier_kurs", "flat_kurs",
]

/** Labels used by the product form and the products table.
 *
 *  The two `_kurs` methods are a family, so the tab that reaches them is labelled for the
 *  family — "Rate" — and the Tier/Flat toggle inside picks the member, exactly as "Markup"
 *  and "Flat Fee" already read. */
export const PRICING_METHOD_LABEL: Record<PricingMethod, string> = {
  overseas: "Profit Margin",
  // The stored value stays `tier_fee` — renaming a pricing_method means a migration and a
  // CHECK constraint change, and the label is the only thing the owner reads. Keep the
  // keyword list in getProductsPaginated's type filter in step with this.
  tier_fee: "Markup",
  flat_fee: "Flat Fee",
  tier_kurs: "Rate",
  flat_kurs: "Flat Rate",
}

/** The two methods priced from a charged exchange rate, reached through the Rate tab's
 *  Tier | Flat toggle exactly as the fee pair is reached through the Fee toggle.
 *
 *  Lives here, beside the union it narrows, because both the server pricing authority and
 *  the product form ask the same question. Two copies of "which methods are Rate methods"
 *  would drift the day a sixth method lands. */
export function isKursMethod(m: PricingMethod): boolean {
  return m === "tier_kurs" || m === "flat_kurs"
}

/** Narrow an arbitrary string (a DB value or request body field) to a method. */
export function toPricingMethod(v: unknown): PricingMethod {
  return PRICING_METHODS.includes(v as PricingMethod) ? (v as PricingMethod) : "overseas"
}

/** Round up to the nearest multiple of 1000. */
export function ceilTo1000(n: number): number {
  return Math.ceil(n / 1000) * 1000
}

/** Round up to the nearest multiple of `to`. Guards a zero/negative step, which
 *  would otherwise divide by zero. */
export function ceilTo(n: number, to: number): number {
  const step = to > 0 ? to : 1
  return Math.ceil(n / step) * step
}

/**
 * Landed rupiah cost of goods: the foreign-currency price converted, plus freight for
 * the shipping weight.
 *
 *   valas × kurs + (gram / 1000) × cargoPerKg
 *
 * Extracted because three methods book exactly this — Profit Margin, Tier Kurs, and
 * Flat Fee with a country — and a fourth copy is how they would start to disagree.
 */
export function landedCost(p: {
  valas: number
  kurs: number
  gram: number
  cargoPerKg: number
}): number {
  return p.valas * p.kurs + (p.gram / 1000) * p.cargoPerKg
}

export interface AbroadPriceInput {
  valas: number
  kurs: number
  gram: number
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
}

/**
 * Landed cost + selling price for an overseas product.
 *   COGS  = valas × kurs + (gram/1000) × cargoPerKg
 *   price = ceilTo1000( COGS × 100/(100−profit%) + opFee + packFee )
 * profit% ≥ 100 is invalid (would divide by ≤0), so price falls back to 0.
 */
export function calcAbroadPrice(p: AbroadPriceInput): { cogs: number; price: number } {
  const cogs = landedCost(p)
  if (p.profitPct >= 100) return { cogs, price: 0 }
  const raw = (cogs * 100) / (100 - p.profitPct) + p.operationalFee + p.packingFee
  return { cogs, price: ceilTo1000(raw) }
}

/** Per-unit profit for an overseas product = price − COGS − fees. */
export function abroadProfit(p: {
  price: number
  cogs: number
  operationalFee: number
  packingFee: number
}): number {
  return Math.round(p.price - p.cogs - p.operationalFee - p.packingFee)
}

/**
 * Base cost plus a fee, both in rupiah. Shared by two methods, deliberately:
 *
 *   tier_fee (rupiah mode) — the fee is typed on the product; the brackets in
 *                            lib/tier-fee.ts only pre-fill it.
 *   flat_fee               — the fee is one global setting, resolved server-side, so
 *                            every such product uses the same number.
 *
 * Same arithmetic, same stored column (products.profit_fixed); only the authority
 * over the fee differs. See migrations 052 and 053.
 */
export function calcRupiahFeePrice(cost: number, fee: number): number {
  return cost + fee
}

/** How a Flat Fee row expresses its fee (migration 054). Same two words as
 *  tier_fee_brackets.fee_mode, and the same meaning. */
export type FlatFeeMode = "fixed" | "percent"

/** Narrow a DB value or request field to a mode; anything unknown reads as "fixed", the
 *  column's own default and the behaviour every row had before migration 054. */
export function toFlatFeeMode(v: unknown): FlatFeeMode {
  return v === "percent" ? "percent" : "fixed"
}

/**
 * The Flat Fee charge for a base cost.
 *
 *   fixed    the flat fee, whatever the base
 *   percent  MAX( round(base × pct / 100), min )
 *
 * The floor applies to PERCENT MODE ONLY (migration 055). In fixed mode the fee is already
 * a flat amount, so a floor would either do nothing or quietly substitute a different
 * constant for the one the owner chose.
 *
 * Rounded to whole rupiah, like resolveRupiahTierFee: a percentage of an integer cost is
 * usually fractional, and products.profit_fixed — where this gets snapshotted — is an
 * INTEGER column, so rounding here is what keeps the stored fee and the price consistent.
 *
 * Every input comes from product_defaults, never from the request body: that single
 * authority is the whole difference between this method and Markup Tier.
 */
export function flatFeeAmount(
  mode: FlatFeeMode,
  base: number,
  flatFee: number,
  flatFeePct: number,
  flatFeeMin: number,
): number {
  if (mode !== "percent") return flatFee
  // Math.max, not a `<` branch: a min of 0 is then inert by arithmetic rather than by a
  // special case, which is what lets 0 mean "no minimum" with no flag to keep in step.
  return Math.max(Math.round((base * flatFeePct) / 100), flatFeeMin)
}

/** True when the floor, not the percentage, is what set the fee — so callers can name which
 *  figure applied instead of showing a percentage that does not explain the number. */
export function flatFeeFloorApplies(
  mode: FlatFeeMode,
  base: number,
  flatFeePct: number,
  flatFeeMin: number,
): boolean {
  return mode === "percent" && flatFeeMin > 0 && Math.round((base * flatFeePct) / 100) < flatFeeMin
}

export interface FlatFeeValasPriceInput {
  valas: number
  /** The country's rate. */
  kurs: number
  gram: number
  cargoPerKg: number
  /** The one rupiah fee from product_defaults, already resolved by flatFeeAmount. */
  fee: number
}

/**
 * Cost + selling price for a Flat Fee product bought in foreign currency.
 *
 *   cogs  = valas × kurs + (gram / 1000) × cargoPerKg
 *   price = cogs + fee
 *
 * The fee stays a RUPIAH amount — that is what makes it flat — and there is no rounding
 * step: the landed cost is already rupiah, and rounding it would reprice rows on an
 * unrelated edit.
 *
 * With no country this method uses calcRupiahFeePrice instead, on a typed base cost.
 * `countryId` is what picks between the two, exactly as it does for Markup Tier.
 */
export function calcFlatFeeValasPrice(p: FlatFeeValasPriceInput): { cogs: number; price: number } {
  const cogs = landedCost(p)
  return { cogs, price: cogs + p.fee }
}

export interface TierFeeValasPriceInput {
  /** Purchase price in the country's currency. */
  valas: number
  /** The country's rate. */
  kurs: number
  /** Shipping weight, for the freight half of cost. */
  gram: number
  /** The country's shipping rate per kilo. */
  cargoPerKg: number
  /** The fee for this base cost, in RUPIAH, from the shared valas bracket set. */
  fee: number
  /** Rounding step, shared with Tier Kurs (product_defaults.tier_kurs_round_to). */
  roundTo: number
}

/**
 * Cost + selling price for a Markup Tier product bought in foreign currency.
 *
 *   cogs  = valas × kurs + (gram / 1000) × cargoPerKg
 *   price = ceilTo(cogs + fee, roundTo)
 *
 * Both halves are rupiah. The fee is chosen by matching `cogs` against the shared valas
 * brackets (migrations 056/057) — one set for every country, which is only coherent because
 * the floors and the fee are rupiah. A shared "20" could not mean anything sensible for CNY
 * and JPY at the same time.
 *
 * Superseded the earlier shape, where the fee was denominated in the country's currency and
 * added BEFORE the conversion. That version needed a bracket table per country and a second
 * fee column to snapshot the result; this one puts a rupiah fee on profit_fixed like the
 * other two fee modes.
 *
 * With no bracket the fee is 0, so the product is priced at cost (bar the round-up):
 * visible, and self-correcting once brackets exist. Same failure shape as Tier Kurs.
 */
export function calcTierFeeValasPrice(p: TierFeeValasPriceInput): { cogs: number; price: number } {
  const cogs = landedCost(p)
  return { cogs, price: ceilTo(cogs + p.fee, p.roundTo) }
}

export interface KursPriceInput {
  valas: number
  /** The rate CHARGED. For tier_kurs that is resolved from the country's brackets by
   *  resolveTieredKurs(); for flat_kurs it is countries.flat_kurs via resolveFlatKurs().
   *  Both live in lib/kurs-tiers.ts, and both fall back to the cost rate when unconfigured,
   *  which is what makes an unconfigured country price at cost rather than at nothing. */
  chargedKurs: number
  /** The country's ACTUAL rate, which is what cost is booked at. */
  kurs: number
  /** Shipping weight. Costs money to land, so it belongs in cogs. */
  gram: number
  /** The country's shipping rate per kilo. */
  cargoPerKg: number
  /** Packing charge, recovered in the price. Per product, pre-filled from
   *  product_defaults.packing_fee. */
  packingFee: number
  /** Rounding step, from product_defaults.tier_kurs_round_to (default 5000). */
  roundTo: number
}

/**
 * Cost + selling price for a Tier Kurs product.
 *   cogs  = valas × kurs + (gram / 1000) × cargoPerKg      (the actual rate)
 *   price = ceilTo( valas × tieredKurs + packingFee, roundTo )
 *
 * The cargo term is the same one calcAbroadPrice books, and for the same reason:
 * landing the goods costs freight whichever formula sets the price.
 *
 * PRICE ignores cargo entirely — it is `valas × the charged rate`, full stop. So the
 * margin is the rate spread plus whatever the round-up adds, MINUS freight, and it can
 * therefore go negative on a heavy, cheap item. That is real, not a bug: the brackets
 * have to be set wide enough to cover shipping. Callers show a negative profit in red.
 *
 * `gram` and `cargoPerKg` are required rather than optional-defaulting-to-0, so a new
 * call site has to state what it means instead of silently pricing freight at nothing.
 *
 * When a country has no brackets the resolver returns the actual rate, so the spread is
 * 0 and the product is priced at bare goods cost — visible, and self-correcting once
 * brackets exist.
 */
export function calcKursPrice(p: KursPriceInput): { cogs: number; price: number } {
  return {
    cogs: landedCost(p),
    // The packing charge goes in BEFORE the ceiling, as it does in calcAbroadPrice: it is
    // part of what the customer pays, so rounding applies to the total rather than
    // leaving a rounded price with an unrounded fee bolted on.
    price: ceilTo(p.valas * p.chargedKurs + p.packingFee, p.roundTo),
  }
}

/** Per-unit profit for a Tier Kurs product = price − cost − the packing charge.
 *
 *  packingFee is subtracted for the same reason abroadProfit subtracts it: the fee is a
 *  cost recovered through the price, not margin. Leaving it in would report the packing
 *  charge as profit. */
export function kursProfit(p: { price: number; cogs: number; packingFee: number }): number {
  return Math.round(p.price - p.cogs - p.packingFee)
}
