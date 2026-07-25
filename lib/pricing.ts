// Pure product-pricing math — the single source of truth shared by the product
// forms (client) and any server-side use. No imports, so safe on both sides.

/** The three pricing methods. Stored on products.pricing_method (migration 050),
 *  which replaced `country_id IS NULL` as the formula discriminator — a Tier Kurs
 *  product has a country but must not use the overseas formula. */
export type PricingMethod = "overseas" | "domestic" | "tier_kurs"

export const PRICING_METHODS: readonly PricingMethod[] = ["overseas", "domestic", "tier_kurs"]

/** Labels used by the product form and the products table. */
export const PRICING_METHOD_LABEL: Record<PricingMethod, string> = {
  overseas: "Profit Margin",
  domestic: "Tier Rp",
  tier_kurs: "Tier Kurs",
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
  const cogs = p.valas * p.kurs + (p.gram / 1000) * p.cargoPerKg
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

/** Domestic price is just base cost plus a fixed profit. */
export function calcDomesticPrice(cost: number, profitFixed: number): number {
  return cost + profitFixed
}

export interface TierKursPriceInput {
  valas: number
  /** The rate CHARGED, resolved from the country's brackets — see
   *  resolveTieredKurs() in lib/kurs-tiers.ts. */
  tieredKurs: number
  /** The country's ACTUAL rate, which is what cost is booked at. */
  kurs: number
  /** Rounding step, from product_defaults.tier_kurs_round_to (default 5000). */
  roundTo: number
}

/**
 * Cost + selling price for a Tier Kurs product.
 *   cogs  = valas × kurs          (the actual rate)
 *   price = ceilTo( valas × tieredKurs, roundTo )
 *
 * No cargo, no fees, no profit percentage: the margin is the spread between the
 * charged rate and the actual one, plus whatever the round-up adds. When a country
 * has no brackets the resolver returns the actual rate, so the spread is 0 and the
 * product is priced at cost — visible, and self-correcting once brackets exist.
 */
export function calcTierKursPrice(p: TierKursPriceInput): { cogs: number; price: number } {
  return {
    cogs: p.valas * p.kurs,
    price: ceilTo(p.valas * p.tieredKurs, p.roundTo),
  }
}

/** Per-unit profit for a Tier Kurs product = price − cost. Unlike the overseas
 *  method there are no fees to subtract. */
export function tierKursProfit(p: { price: number; cogs: number }): number {
  return Math.round(p.price - p.cogs)
}
