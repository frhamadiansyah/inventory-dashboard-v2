// Read-only integrity check for BOTH Rate pricing methods — tier_kurs and flat_kurs.
// Changes nothing.
//
// The two ask the same two questions and share the same arithmetic; only where the charged
// rate came from differs, so only the expected-rate line below branches.
//
// Two things can go wrong that no other check would catch:
//
//   1. A stored price disagrees with the row's OWN inputs — valas, its snapshotted
//      tiered rate, and the configured rounding step.
//   2. The snapshot itself has gone stale, because the brackets (or the rounding
//      step) were edited after the product was last saved.
//
// (2) is the measurable form of "brackets are live config": editing a bracket
// reprices Tier Kurs products on their NEXT save, and this reports exactly which
// ones and by how much rather than leaving it as a warning in the UI.
//
// Also sanity-checks the pricing_method backfill from migration 050, since a row
// with the wrong method is priced by the wrong formula.
//
// Usage:
//   node --env-file=.env.development.local --import=tsx scripts/dryrun-tier-kurs.ts

import postgres from "postgres"
import { writeFileSync, mkdirSync } from "node:fs"
import { calcKursPrice } from "../lib/pricing"
import { resolveTieredKurs, resolveFlatKurs } from "../lib/kurs-tiers"

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}

// The local Supabase stack speaks plain TCP; the hosted pooler requires TLS.
const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL)
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  ssl: isLocal ? false : "require",
})

const EPSILON = 1e-9
const rp = (n: number) => Math.round(n).toLocaleString("id-ID")

interface Row {
  id: number
  name: string
  store: string
  price: number
  country_id: number | null
  pricing_method: string
  valas: string | number
  kurs: string | number
  tiered_kurs: string | number | null
  gram: number
  cargo_per_kg: string | number
  packing_fee: number
  /** The row's country's flat rate, joined in. Null when the row has no country; 0 when the
   *  country has no flat rate set. Only flat_kurs rows read it. */
  flat_kurs: string | number | null
}

async function main() {
  const [defaults] = await sql`SELECT tier_kurs_round_to FROM product_defaults WHERE id = 1`
  const roundTo = Number(defaults?.tier_kurs_round_to) || 5000
  console.log(`\nRounding step: ${rp(roundTo)} (product_defaults.tier_kurs_round_to)`)

  // ── Check 0: the migration-050 backfill still holds ──────────────────────
  const methods = (await sql`
    SELECT pricing_method, COUNT(*)::int AS n, COUNT(country_id)::int AS with_country
      FROM products GROUP BY 1 ORDER BY 1
  `) as unknown as { pricing_method: string; n: number; with_country: number }[]

  console.log("\n── 0. Method assignment ──")
  for (const m of methods) {
    console.log(`  ${m.pricing_method.padEnd(10)} ${String(m.n).padStart(5)} rows, ${m.with_country} with a country`)
  }
  // A country on a tier_fee OR flat_fee row is NOT a fault — it is exactly what selects
  // that method's valas mode (migration 053 for tier_fee; flat_fee gained the same split
  // when its cost became landed cost). So there is no longer a method that must never
  // carry one, and the old flat_fee assertion has been dropped rather than inverted:
  // both states are legal, so neither is evidence of anything.
  const [{ n: overseasNoCountry }] = (await sql`
    SELECT COUNT(*)::int AS n FROM products
     WHERE pricing_method IN ('overseas', 'tier_kurs', 'flat_kurs') AND country_id IS NULL
  `) as unknown as { n: number }[]
  const structural = 0
  if (overseasNoCountry > 0) {
    console.log(`  ⚠️  ${overseasNoCountry} overseas/Rate row(s) have NO country, so they price at 0 inputs`)
  }
  console.log("  ✅ method assignment is consistent (a country is legal on any method now)")

  // ── Tier Kurs rows ───────────────────────────────────────────────────────
  const rows = (await sql`
    SELECT p.id, p.name, p.store, p.price, p.country_id, p.pricing_method, p.valas, p.kurs,
           p.tiered_kurs, p.gram, p.cargo_per_kg, p.packing_fee, c.flat_kurs
      FROM products p
      LEFT JOIN countries c ON c.id = p.country_id
     WHERE p.pricing_method IN ('tier_kurs', 'flat_kurs') AND p.name != ''
     ORDER BY p.id
  `) as unknown as Row[]

  console.log(`\n── 1. Rate snapshot integrity (${rows.length} row(s)) ──`)
  if (rows.length === 0) {
    console.log("  ℹ️  no products use either Rate method yet")
    await sql.end()
    console.log(structural === 0 ? "\n✅ PASSED\n" : "\n❌ FAILED\n")
    process.exit(structural === 0 ? 0 : 1)
  }

  const bandRows = (await sql`
    SELECT country_id, min_valas, kurs FROM country_kurs_tiers
  `) as unknown as { country_id: number; min_valas: string; kurs: string }[]
  const bandsBy = new Map<number, { minValas: string; kurs: string }[]>()
  for (const b of bandRows) {
    const list = bandsBy.get(b.country_id) ?? []
    list.push({ minValas: b.min_valas, kurs: b.kurs })
    bandsBy.set(b.country_id, list)
  }

  const stale: { r: Row; storedRate: number; liveRate: number; nowPrice: number }[] = []
  let priceMismatch = 0
  let noRate = 0

  for (const r of rows) {
    // NUMERIC comes back as a string from postgres-js.
    const valas = Number(r.valas) || 0
    const kurs = Number(r.kurs) || 0
    const storedRate = r.tiered_kurs != null ? Number(r.tiered_kurs) : null
    const gram = Number(r.gram) || 0
    const cargoPerKg = Number(r.cargo_per_kg) || 0
    // Part of the price since the packing charge was folded in, so it has to come from the
    // row rather than from product_defaults, or a later change to the default would make
    // every existing row look corrupt.
    const packingFee = Number(r.packing_fee) || 0

    if (storedRate == null) {
      noRate++
      continue
    }

    // Run the real formula, NOT a closed form: it has to stay right when the
    // rounding step changes.
    // gram and cargo_per_kg do not move the price — it is valas × the charged rate —
    // but they are part of cogs since freight is booked into cost, so pass the row's
    // own values rather than zeros.
    const own = Math.round(calcKursPrice({ valas, chargedKurs: storedRate, kurs, roundTo, gram, cargoPerKg, packingFee }).price)
    if (own !== (r.price ?? 0)) {
      priceMismatch++
      console.log(`  ❌ #${r.id} ${r.name.slice(0, 34)} stored ${rp(r.price)} but its own inputs give ${rp(own)}`)
    }

    // What the row WOULD be charged today. Both methods fall back to `kurs`, the rate the
    // row books as cost, so an unconfigured country reads as a zero spread rather than as a
    // stale snapshot.
    const live = r.pricing_method === "flat_kurs"
      ? resolveFlatKurs(r.flat_kurs, kurs)
      : resolveTieredKurs(
          r.country_id != null ? (bandsBy.get(r.country_id) ?? []) : [],
          valas,
          kurs,
        )
    if (Math.abs(live - storedRate) > EPSILON) {
      const nowPrice = Math.round(calcKursPrice({ valas, chargedKurs: live, kurs, roundTo, gram, cargoPerKg, packingFee }).price)
      stale.push({ r, storedRate, liveRate: live, nowPrice })
    }
  }

  if (noRate > 0) {
    console.log(`  ❌ ${noRate} Rate row(s) have NULL tiered_kurs — they were never priced`)
  }
  if (priceMismatch === 0 && noRate === 0) {
    console.log(`  ✅ price: all ${rows.length} rows agree with their own snapshot`)
  }

  console.log("\n── 2. Snapshots vs the live rates ──")
  if (stale.length === 0) {
    console.log("  ✅ every charged rate still matches its live source")
  } else {
    console.log(
      `  ⚠️  ${stale.length} of ${rows.length} row(s) would reprice on next save` +
        " (brackets or the rounding step changed since they were last saved)",
    )
    for (const t of stale.slice(0, 15)) {
      console.log(
        `    #${t.r.id} ${t.r.name.slice(0, 34).padEnd(34)} rate ${rp(t.storedRate)} → ${rp(t.liveRate)}` +
          `   price ${rp(t.r.price ?? 0)} → ${rp(t.nowPrice)}`,
      )
    }
    mkdirSync("scripts/data", { recursive: true })
    // Proper CSV quoting: a literal " is doubled, not backslash-escaped.
    const q = (s: string) => `"${String(s ?? "").replace(/"/g, '""')}"`
    writeFileSync(
      "scripts/data/kurs-tier-drift.csv",
      [
        "id,name,store,stored_rate,live_rate,stored_price,price_on_next_save",
        ...stale.map((t) =>
          [t.r.id, q(t.r.name), q(t.r.store ?? ""), t.storedRate, t.liveRate, t.r.price ?? 0, t.nowPrice].join(","),
        ),
      ].join("\n"),
    )
    console.log("\n  📄 Full list: scripts/data/kurs-tier-drift.csv")
    console.log("  Nothing has been changed — each row reprices only when it is next saved.")
  }

  const failed = structural > 0 || priceMismatch > 0 || noRate > 0
  console.log(failed ? "\n❌ FAILED\n" : "\n✅ PASSED\n")
  await sql.end()
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error("❌ Dry run failed:", err)
  await sql.end()
  process.exit(1)
})
