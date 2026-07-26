// Read-only integrity check for the Tier Kurs pricing method. Changes nothing.
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
import { calcTierKursPrice } from "../lib/pricing"
import { resolveTieredKurs } from "../lib/kurs-tiers"

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
  // A country on a tier_fee row is NOT a fault — since migration 053 that is exactly
  // what selects its valas mode. flat_fee is the only method that must never carry
  // one: its fee is a single rupiah setting, so a country would be silently ignored.
  const flatFeeWithCountry = methods.find((m) => m.pricing_method === "flat_fee")?.with_country ?? 0
  const [{ n: overseasNoCountry }] = (await sql`
    SELECT COUNT(*)::int AS n FROM products
     WHERE pricing_method IN ('overseas', 'tier_kurs') AND country_id IS NULL
  `) as unknown as { n: number }[]
  let structural = 0
  if (flatFeeWithCountry > 0) {
    console.log(`  ❌ ${flatFeeWithCountry} Flat Fee row(s) have a country — the formula ignores it`)
    structural++
  }
  if (overseasNoCountry > 0) {
    console.log(`  ⚠️  ${overseasNoCountry} overseas/tier_kurs row(s) have NO country, so they price at 0 inputs`)
  }
  if (structural === 0) console.log("  ✅ no Flat Fee row carries a country")

  // ── Tier Kurs rows ───────────────────────────────────────────────────────
  const rows = (await sql`
    SELECT id, name, store, price, country_id, pricing_method, valas, kurs, tiered_kurs
      FROM products
     WHERE pricing_method = 'tier_kurs' AND name != ''
     ORDER BY id
  `) as unknown as Row[]

  console.log(`\n── 1. Tier Kurs snapshot integrity (${rows.length} row(s)) ──`)
  if (rows.length === 0) {
    console.log("  ℹ️  no products use Tier Kurs yet")
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

    if (storedRate == null) {
      noRate++
      continue
    }

    // Run the real formula, NOT a closed form: it has to stay right when the
    // rounding step changes.
    const own = Math.round(calcTierKursPrice({ valas, tieredKurs: storedRate, kurs, roundTo }).price)
    if (own !== (r.price ?? 0)) {
      priceMismatch++
      console.log(`  ❌ #${r.id} ${r.name.slice(0, 34)} stored ${rp(r.price)} but its own inputs give ${rp(own)}`)
    }

    const live = resolveTieredKurs(
      r.country_id != null ? (bandsBy.get(r.country_id) ?? []) : [],
      valas,
      kurs,
    )
    if (Math.abs(live - storedRate) > EPSILON) {
      const nowPrice = Math.round(calcTierKursPrice({ valas, tieredKurs: live, kurs, roundTo }).price)
      stale.push({ r, storedRate, liveRate: live, nowPrice })
    }
  }

  if (noRate > 0) {
    console.log(`  ❌ ${noRate} row(s) are Tier Kurs but have NULL tiered_kurs — they were never priced`)
  }
  if (priceMismatch === 0 && noRate === 0) {
    console.log(`  ✅ price: all ${rows.length} rows agree with their own snapshot`)
  }

  console.log("\n── 2. Snapshots vs the live brackets ──")
  if (stale.length === 0) {
    console.log("  ✅ every tiered rate still matches the live brackets")
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
