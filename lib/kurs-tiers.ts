// Bracket resolution for the Tier Kurs pricing method. Like lib/pricing.ts this
// file has NO imports, so it is safe on both the client (live form preview) and
// the server (which is the pricing authority for this method — see
// lib/pricing-server.ts).
//
// Deliberately NOT inside lib/pricing.ts: that module is pure arithmetic over
// values it is handed, and it knows nothing about database rows. It could not do
// this lookup anyway — having no imports means no database access — which is why
// the resolved rate is passed IN to calcTierKursPrice() rather than looked up
// there.
//
// `minValas` is INCLUSIVE and the HIGHEST matching minimum wins, so row order is
// irrelevant.

/**
 * One bracket. Accepts strings because postgres-js returns NUMERIC as a string,
 * and unparsed form inputs are strings too.
 */
export interface KursTierInput {
  minValas: number | string
  kurs: number | string
}

/**
 * The bracket that applies to `valas`, or null when none does — no brackets, a
 * valas below the lowest floor, or every row unparseable.
 *
 * Separate from resolveTieredKurs() because the products form shows WHICH bracket
 * produced the charged rate, and both must agree by construction.
 */
export function pickKursTier<T extends KursTierInput>(
  tiers: readonly T[] | null | undefined,
  valas: number,
): T | null {
  let bestMin = -Infinity
  let best: T | null = null
  for (const t of tiers ?? []) {
    const min = Number(t.minValas)
    const kurs = Number(t.kurs)
    if (!Number.isFinite(min) || !Number.isFinite(kurs) || kurs <= 0) continue
    // Strict >, so the first of two equal minima wins. The
    // UNIQUE (country_id, min_valas) constraint makes that unreachable through
    // the app anyway.
    if (valas >= min && min > bestMin) {
      bestMin = min
      best = t
    }
  }
  return best
}

/**
 * The rate to charge for `valas`.
 *
 * Falls back to `fallbackKurs` when there are no brackets, when none matches
 * (a valas below the lowest floor), or when every row is unparseable.
 *
 * `fallbackKurs` must be the SAME kurs the engine books as cost — vars.kurs, i.e.
 * the value being snapshotted onto the product — and not a fresh read of
 * countries.kurs. Otherwise the "no brackets" case produces a non-zero spread
 * instead of pricing the product at cost.
 */
export function resolveTieredKurs(
  tiers: readonly KursTierInput[] | null | undefined,
  valas: number,
  fallbackKurs: number,
): number {
  const best = pickKursTier(tiers, valas)
  // pickKursTier has already rejected non-finite and non-positive rates.
  return best ? Number(best.kurs) : fallbackKurs
}

/**
 * The brackets belonging to one country, ascending. Shared by the product form's
 * preview and the Settings editor so both read the same rows the server does.
 */
export function tiersForCountry<T extends KursTierInput & { countryId: number }>(
  tiers: readonly T[] | null | undefined,
  countryId: number | null | undefined,
): T[] {
  if (countryId == null) return []
  return (tiers ?? [])
    .filter((t) => t.countryId === countryId)
    .sort((a, b) => Number(a.minValas) - Number(b.minValas))
}
