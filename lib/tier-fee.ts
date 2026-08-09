// Bracket resolution for the Tier Fee method: from which base amount upward to
// charge which fee.
//
// No imports, same rule as lib/kurs-tiers.ts and lib/pricing.ts, so the form can run
// it directly. `minBase` is INCLUSIVE and the HIGHEST matching minimum wins, so row
// order is irrelevant — deliberately the same rule as resolveTieredKurs(), because
// two different answers to "which bracket applies" in one app would be a bug waiting
// to happen.
//
// Two scopes, named by tier_fee_brackets.scope (see migrations 056/057). BOTH are
// denominated in rupiah — floors and fees alike — and differ only in which base cost
// they are matched against, and in who has the last word:
//
//   'rupiah'  the TYPED base cost of a Markup row with no country. A SUGGESTION only:
//             it pre-fills the form's Fee field, the owner can type over it, and
//             nothing recomputes it afterwards.
//   'valas'   the DERIVED base cost (valas × kurs + freight) of a Markup row with a
//             country, shared by every country. Resolved server-side on every save, so
//             unlike the rupiah set this one IS authoritative.
//
// The asymmetry is not an oversight: the rupiah fee is typed by a human and has been
// since before this table existed, while the valas fee is never typed at all.
//
// Before 056 the valas set was per-country and denominated in each country's own
// currency. Sharing one set is only coherent because the fee is rupiah: a shared
// `fee = 20` would otherwise mean 20 CNY for China and 20 JPY for Japan.

export type TierFeeMode = "fixed" | "percent"

/** Which bracket set (migrations 056/057). Both are denominated in RUPIAH:
 *
 *   rupiah — matched against the typed base cost of a no-country Markup Tier product.
 *   valas  — matched against the DERIVED base cost (valas × kurs + freight) of a Markup
 *            Tier product with a country. Shared by every country, which only works
 *            because the floors and the fee are rupiah rather than each country's own
 *            currency.
 */
export type TierFeeScope = "rupiah" | "valas"

/** Narrow a DB value or request field to a scope. Anything unrecognised reads as
 *  "rupiah" — the column's default, and the set that only ever suggests a value, so a
 *  bad input cannot silently become authoritative. */
export function toTierFeeScope(v: unknown): TierFeeScope {
  return v === "valas" ? "valas" : "rupiah"
}

/**
 * One bracket. Accepts strings because postgres-js returns NUMERIC as a string, and
 * unparsed form inputs are strings too.
 */
export interface TierFeeBracketInput {
  minBase: number | string
  /** "fixed" — feeValue is an amount. "percent" — feeValue is a % of the base. */
  feeMode: TierFeeMode | string
  feeValue: number | string
}

export function toTierFeeMode(v: unknown): TierFeeMode {
  return v === "percent" ? "percent" : "fixed"
}

/**
 * The bracket that applies to `base`, or null when none does — no brackets, a base
 * below the lowest floor, or every row unparseable.
 *
 * Separate from resolveTierFee() because the products form shows WHICH bracket it
 * used, not just the amount, and both must agree by construction.
 */
export function pickTierFeeBracket<T extends TierFeeBracketInput>(
  brackets: readonly T[] | null | undefined,
  base: number,
): T | null {
  let bestMin = -Infinity
  let best: T | null = null
  for (const b of brackets ?? []) {
    const min = Number(b.minBase)
    const value = Number(b.feeValue)
    if (!Number.isFinite(min) || !Number.isFinite(value) || value < 0) continue
    // Strict >, so the first of two equal minima wins. The
    // UNIQUE (scope, min_base) constraint makes that unreachable through the app anyway.
    if (base >= min && min > bestMin) {
      bestMin = min
      best = b
    }
  }
  return best
}

/**
 * What one bracket charges at `base`.
 *
 * NOT rounded, unlike its predecessor: a valas fee is legitimately fractional. The
 * rupiah callers round at the point of use, where the unit is known.
 */
export function tierFeeAmount(
  bracket: TierFeeBracketInput | null | undefined,
  base: number,
): number {
  if (!bracket) return 0
  const value = Number(bracket.feeValue)
  if (!Number.isFinite(value) || value < 0) return 0
  return toTierFeeMode(bracket.feeMode) === "percent" ? (base * value) / 100 : value
}

/**
 * The fee for `base`, in the same unit as the brackets.
 *
 * Returns 0 when no bracket applies — i.e. "no fee", which leaves a rupiah product's
 * fee to be typed by hand and prices a valas product at cost. Visible either way,
 * and self-correcting once brackets exist.
 */
export function resolveTierFee(
  brackets: readonly TierFeeBracketInput[] | null | undefined,
  base: number,
): number {
  return tierFeeAmount(pickTierFeeBracket(brackets, base), base)
}

/** Whole rupiah, for the INTEGER products.profit_fixed column. */
export function resolveRupiahTierFee(
  brackets: readonly TierFeeBracketInput[] | null | undefined,
  cost: number,
): number {
  return Math.round(resolveTierFee(brackets, cost))
}

/**
 * The brackets belonging to one scope. Shared by the form's preview and the Settings
 * editor so both read the same rows the server does.
 *
 * Order is preserved rather than sorted: the resolver picks the highest matching floor,
 * so order never affects the result, and the rows arrive ascending from the query.
 */
export function bracketsForScope<T extends TierFeeBracketInput & { scope: TierFeeScope }>(
  brackets: readonly T[] | null | undefined,
  scope: TierFeeScope,
): T[] {
  return (brackets ?? []).filter((b) => b.scope === scope)
}

/**
 * The rupiah brackets as they were hardcoded before migration 051, mirroring its
 * seed.
 *
 * Two jobs: the Settings editor's "reset to default", and a stand-in while the real
 * brackets are still loading, so a fast typist gets the same suggestion they always
 * did instead of a zero. Once the fetch lands, an empty set means an empty set — the
 * owner is allowed to turn suggestions off.
 */
export const DEFAULT_RUPIAH_TIER_FEE_BRACKETS: readonly {
  minBase: number
  feeMode: TierFeeMode
  feeValue: number
}[] = [
  { minBase: 0, feeMode: "fixed", feeValue: 5_000 },
  { minBase: 28_001, feeMode: "fixed", feeValue: 10_000 },
  { minBase: 98_001, feeMode: "fixed", feeValue: 20_000 },
  { minBase: 198_001, feeMode: "fixed", feeValue: 25_000 },
  { minBase: 298_001, feeMode: "fixed", feeValue: 35_000 },
  { minBase: 398_001, feeMode: "fixed", feeValue: 45_000 },
  { minBase: 498_001, feeMode: "fixed", feeValue: 55_000 },
  { minBase: 700_000, feeMode: "fixed", feeValue: 80_000 },
  { minBase: 800_000, feeMode: "percent", feeValue: 15 },
]
