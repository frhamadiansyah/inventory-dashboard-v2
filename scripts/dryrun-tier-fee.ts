// Read-only check for the Tier Fee brackets and the Flat Fee setting. Changes nothing.
//
// The RUPIAH brackets only pre-fill a form field, so there is no stored value to drift
// from. What CAN break is the migration-051 translation: the table used to be
// hardcoded in the products page with mixed inclusive (>=) and exclusive (>)
// boundaries, and the DB rows are all inclusive. This sweeps every integer cost in the
// range that matters and asserts the two agree on every single one.
//
// The VALAS brackets (migration 053) are a different matter: they ARE authoritative,
// resolved server-side on every save, so a stored price can disagree with them. Two
// failure modes, kept apart because they mean different things — a row that
// contradicts its own snapshot is corruption, while a row whose snapshot predates a
// bracket edit is merely stale and will reprice when next saved.
//
// Usage:
//   node --env-file=.env.development.local --import=tsx scripts/dryrun-tier-fee.ts

import postgres from "postgres"
import {
  DEFAULT_RUPIAH_TIER_FEE_BRACKETS,
  bracketsForScope,
  resolveRupiahTierFee,
  type TierFeeBracketInput,
} from "../lib/tier-fee"
import { calcTierFeeValasPrice, flatFeeAmount, landedCost, toFlatFeeMode } from "../lib/pricing"

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}

const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL)
const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: isLocal ? false : "require" })

const rp = (n: number) => Math.round(n).toLocaleString("id-ID")

/** The table exactly as it was hardcoded in ProductsPageClient.tsx before
 *  migration 051. Kept verbatim here — this file is the only reason it still needs
 *  to exist, and comparing against a copy is the whole point. */
function hardcodedRupiahFee(cost: number): number {
  if (cost >= 800_000) return Math.round(cost * 0.15)
  if (cost >= 700_000) return 80_000
  if (cost > 498_000) return 55_000
  if (cost > 398_000) return 45_000
  if (cost > 298_000) return 35_000
  if (cost > 198_000) return 25_000
  if (cost > 98_000) return 20_000
  if (cost > 28_000) return 10_000
  return 5_000
}

const SWEEP_MAX = 1_200_000

function sweep(label: string, tiers: readonly TierFeeBracketInput[]): number {
  let mismatches = 0
  let firstMismatch: { cost: number; was: number; now: number } | null = null
  for (let cost = 0; cost <= SWEEP_MAX; cost++) {
    const was = hardcodedRupiahFee(cost)
    // resolveRupiahTierFee, not resolveTierFee: the rupiah scope is whole rupiah,
    // and the unrounded resolver returns 120000.15 for a 15% bracket at cost 800.001
    // where the old hardcoded table returned 120000.
    const now = resolveRupiahTierFee(tiers, cost)
    if (was !== now) {
      mismatches++
      if (!firstMismatch) firstMismatch = { cost, was, now }
    }
  }
  if (mismatches === 0) {
    console.log(`  ✅ ${label}: identical to the old hardcoded table for all ${rp(SWEEP_MAX + 1)} integer costs 0–${rp(SWEEP_MAX)}`)
  } else {
    console.log(
      `  ❌ ${label}: ${rp(mismatches)} of ${rp(SWEEP_MAX + 1)} costs disagree` +
        (firstMismatch
          ? ` — first at cost ${rp(firstMismatch.cost)}: was ${rp(firstMismatch.was)}, now ${rp(firstMismatch.now)}`
          : ""),
    )
  }
  return mismatches
}

async function main() {
  // ── 1. The constant mirrors the old hardcoded function ───────────────────
  console.log("\n── 1. DEFAULT_RUPIAH_TIER_FEE_BRACKETS vs the old hardcoded table ──")
  let failed = sweep("lib/tier-fee.ts constant", DEFAULT_RUPIAH_TIER_FEE_BRACKETS) > 0

  // ── 2. The migration seed mirrors the constant ────────────────────────────
  // scope = 'rupiah' only: these checks are all about that set. The valas
  // scopes are checked in section 7.
  const rows = (await sql`
    SELECT min_base, fee_mode, fee_value FROM tier_fee_brackets
     WHERE scope = 'rupiah' ORDER BY min_base
  `) as unknown as { min_base: number; fee_mode: string; fee_value: string }[]

  console.log(`\n── 2. The ${rows.length} rupiah bracket(s) in the database ──`)
  if (rows.length === 0) {
    console.log("  ℹ️  no brackets — the form suggests nothing and the field is typed by hand")
  }
  for (const r of rows) {
    const v = Number(r.fee_value)
    console.log(
      `  from cost ${rp(r.min_base).padStart(11)}  →  ` +
        (r.fee_mode === "percent" ? `${v}% of cost` : `Rp ${rp(v)}`),
    )
  }

  const live: TierFeeBracketInput[] = rows.map((r) => ({
    minBase: r.min_base,
    feeMode: r.fee_mode,
    feeValue: r.fee_value,
  }))

  // Only meaningful while the brackets are still the seeded ones. Once the owner
  // edits them this is EXPECTED to differ, so it reports rather than fails.
  console.log("\n── 3. Live brackets vs the old hardcoded table ──")
  if (rows.length > 0) {
    const drift = sweep("database", live)
    if (drift > 0) {
      console.log("     ↑ expected once the brackets have been edited in Settings; not a failure")
    }
  } else {
    console.log("  (skipped — no brackets)")
  }

  // ── 4. Shape checks that survive editing ─────────────────────────────────
  console.log("\n── 4. Bracket-set sanity ──")
  if (rows.length > 0) {
    if (!rows.some((r) => Number(r.min_base) === 0)) {
      console.log(`  ⚠️  no bracket starts at 0, so a cost below ${rp(rows[0].min_base)} suggests nothing`)
    } else {
      console.log("  ✅ a bracket covers cost 0, so every cost resolves")
    }
    const dupes = rows.length - new Set(rows.map((r) => Number(r.min_base))).size
    if (dupes > 0) {
      console.log(`  ❌ ${dupes} duplicate floor(s) — UNIQUE (min_base) should have prevented this`)
      failed = true
    }
  } else {
    console.log("  (skipped — no brackets)")
  }

  // ── 5. No stored product value depends on any of this ────────────────────
  const [{ n }] = (await sql`
    SELECT COUNT(*)::int AS n FROM products WHERE pricing_method = 'tier_fee'
  `) as unknown as { n: number }[]
  const [{ n: rupiahN }] = (await sql`
    SELECT COUNT(*)::int AS n FROM products
     WHERE pricing_method = 'tier_fee' AND country_id IS NULL
  `) as unknown as { n: number }[]
  console.log(
    `\n── 5. ${n} Tier Fee product(s), ${rupiahN} of them in rupiah mode. The rupiah ones are ` +
      "not recomputed from these brackets: profit_fixed is stored per product and only ever " +
      "set by hand or by the form's initial suggestion.",
  )

  // ── 6. Flat Fee, the other method built on cost + profit_fixed ───────────
  //
  // Unlike Tier Fee this one IS authoritative (migration 052): the fee comes from
  // product_defaults and the server re-resolves it on every save. Two failure modes
  // worth catching, and they are different from each other:
  //
  //   a. price != cost + profit_fixed — the row disagrees with its OWN snapshot,
  //      which should be impossible and means something wrote a price directly.
  //   b. profit_fixed != the current fee — the row is intact but predates a fee
  //      change, so it will reprice on its next save. Reported, not failed.
  console.log("\n── 6. Flat Fee rows ──")
  const [defs] = (await sql`
    SELECT flat_fee, flat_fee_pct, flat_fee_min FROM product_defaults WHERE id = 1
  `) as unknown as { flat_fee: number; flat_fee_pct: string; flat_fee_min: number }[]
  const liveFee = Number(defs?.flat_fee) || 0
  const livePct = Number(defs?.flat_fee_pct) || 0
  const liveMin = Number(defs?.flat_fee_min) || 0
  console.log(`  Current flat fee: Rp ${rp(liveFee)} · percent mode: ${livePct}%, floor Rp ${rp(liveMin)} (product_defaults)`)

  const flatRows = (await sql`
    SELECT id, name, price, cost, profit_fixed, country_id, valas, kurs, gram, cargo_per_kg,
           flat_fee_mode
      FROM products WHERE pricing_method = 'flat_fee' AND name != '' ORDER BY id
  `) as unknown as {
    id: number; name: string; price: number; cost: number; profit_fixed: number
    country_id: number | null; valas: string; kurs: string; gram: number; cargo_per_kg: string
    flat_fee_mode: string
  }[]

  if (flatRows.length === 0) {
    console.log("  ℹ️  no products use Flat Fee yet")
  } else {
    let broken = 0
    const staleFee: typeof flatRows = []
    for (const r of flatRows) {
      // With a country, cost is DERIVED — landed cost from the row's own snapshots — so
      // check it reproduces rather than trusting the stored figure. Without one it is
      // typed, and there is nothing to reproduce it from.
      if (r.country_id != null) {
        const landed = Math.round(landedCost({
          valas: Number(r.valas) || 0,
          kurs: Number(r.kurs) || 0,
          gram: Number(r.gram) || 0,
          cargoPerKg: Number(r.cargo_per_kg) || 0,
        }))
        if (landed !== Number(r.cost)) {
          broken++
          failed = true
          console.log(`  ❌ #${r.id} ${r.name.slice(0, 34)} stored cost ${rp(r.cost)} but its own valas/rate/freight give ${rp(landed)}`)
        }
      }
      const own = Number(r.cost) + Number(r.profit_fixed)
      if (own !== Number(r.price)) {
        broken++
        failed = true
        console.log(`  ❌ #${r.id} ${r.name.slice(0, 34)} stored ${rp(r.price)} but cost + fee = ${rp(own)}`)
      }
      // The fee a row SHOULD carry depends on its mode: the fixed amount, or the live
      // percentage of its own stored cost (migration 054). Comparing every row against the
      // fixed amount would report every percent-mode row as stale.
      const wantFee = flatFeeAmount(
        toFlatFeeMode(r.flat_fee_mode), Number(r.cost) || 0, liveFee, livePct, liveMin,
      )
      if (Number(r.profit_fixed) !== wantFee) staleFee.push(r)
    }
    if (broken === 0) {
      console.log(`  ✅ price: all ${flatRows.length} row(s) equal cost + their own stored fee`)
    }
    if (staleFee.length === 0) {
      console.log("  ✅ every row was priced with the current fee")
    } else {
      console.log(
        `  ⚠️  ${staleFee.length} of ${flatRows.length} row(s) were priced with a different fee` +
          " and will reprice on their next save:",
      )
      for (const r of staleFee.slice(0, 15)) {
        console.log(
          `    #${r.id} ${r.name.slice(0, 34).padEnd(34)} fee ${rp(r.profit_fixed)} → ${rp(liveFee)}` +
            `   price ${rp(r.price)} → ${rp(Number(r.cost) + liveFee)}`,
        )
      }
    }
  }

  // ── 7. Valas-mode Tier Fee, which IS authoritative ───────────────────────
  console.log("\n── 7. Valas-mode Tier Fee rows ──")
  const [defaults] = await sql`SELECT tier_kurs_round_to FROM product_defaults WHERE id = 1`
  const roundTo = Number(defaults?.tier_kurs_round_to) || 5000

  // One set for every country since migrations 056/057, and denominated in rupiah, so there
  // is nothing to group by any more.
  const valasRows_ = (await sql`
    SELECT min_base, fee_mode, fee_value FROM tier_fee_brackets
     WHERE scope = 'valas' ORDER BY min_base
  `) as unknown as { min_base: string; fee_mode: string; fee_value: string }[]
  const valasBrackets: TierFeeBracketInput[] = valasRows_.map((b) => ({
    minBase: b.min_base, feeMode: b.fee_mode, feeValue: b.fee_value,
  }))
  console.log(
    `  ${valasBrackets.length} shared rupiah bracket(s), rounding up to ${rp(roundTo)}`,
  )

  const valasRows = (await sql`
    SELECT p.id, p.name, p.price, p.valas, p.kurs, p.profit_fixed, p.country_id, c.currency,
           p.gram, p.cargo_per_kg
      FROM products p LEFT JOIN countries c ON c.id = p.country_id
     WHERE p.pricing_method = 'tier_fee' AND p.country_id IS NOT NULL AND p.name != ''
     ORDER BY p.id
  `) as unknown as {
    id: number; name: string; price: number; valas: string; kurs: string
    profit_fixed: number; country_id: number; currency: string | null
    gram: number; cargo_per_kg: string
  }[]

  if (valasRows.length === 0) {
    console.log("  ℹ️  no products use valas-mode Tier Fee yet")
  } else {
    let broken = 0
    const stale: string[] = []
    for (const r of valasRows) {
      const valas = Number(r.valas) || 0
      const kurs = Number(r.kurs) || 0
      // Freight moves cogs, not price, so these do not affect the assertions below — passed
      // from the row so the call states the whole input rather than implying zero weight.
      const gram = Number(r.gram) || 0
      const cargoPerKg = Number(r.cargo_per_kg) || 0
      // profit_fixed is where the resolved RUPIAH fee is snapshotted.
      const landed = Math.round(landedCost({ valas, kurs, gram, cargoPerKg }))
      const stored = Number(r.profit_fixed)
      // Run the real formula, not a closed form: it has to stay right when the
      // rounding step changes.
      const own = Math.round(
        calcTierFeeValasPrice({ valas, kurs, gram, cargoPerKg, fee: stored, roundTo }).price,
      )
      if (own !== Number(r.price)) {
        broken++
        failed = true
        console.log(
          `  ❌ #${r.id} ${r.name.slice(0, 34)} stored ${rp(r.price)} but its own inputs give ${rp(own)}`,
        )
      }
      const live = resolveRupiahTierFee(valasBrackets, landed)
      if (Math.abs(live - stored) > 1e-9) {
        const now = Math.round(
          calcTierFeeValasPrice({ valas, kurs, gram, cargoPerKg, fee: live, roundTo }).price,
        )
        stale.push(
          `    #${r.id} ${r.name.slice(0, 34).padEnd(34)} fee Rp ${rp(stored)} → Rp ${rp(live)}` +
            `   price ${rp(r.price)} → ${rp(now)}`,
        )
      }
    }
    if (broken === 0) {
      console.log(`  ✅ price: all ${valasRows.length} row(s) agree with their own snapshot`)
    }
    if (stale.length === 0) {
      console.log("  ✅ every stored fee still matches the live brackets")
    } else {
      console.log(
        `  ⚠️  ${stale.length} of ${valasRows.length} row(s) would reprice on next save` +
          " (brackets or the rounding step changed since they were last saved):",
      )
      for (const line of stale.slice(0, 15)) console.log(line)
    }
  }

  console.log(failed ? "\n❌ FAILED\n" : "\n✅ PASSED\n")
  await sql.end()
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error("❌ Dry run failed:", err)
  await sql.end()
  process.exit(1)
})
