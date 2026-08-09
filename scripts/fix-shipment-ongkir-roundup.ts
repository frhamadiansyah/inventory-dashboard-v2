/**
 * One-off correction: round shipment weight UP to the next whole kg and
 * recompute ongkir accordingly, matching how invoices bill ongkir.
 *
 * sync-tracking-from-wa.ts (and the in-app Ship action) stored weight as the raw
 * fractional kg and ongkir_total = round(rate × fractional kg), which undercharged
 * sub-kg packages. This sets, for every affected shipment:
 *   weight_estimation = CEIL(weight_estimation)
 *   ongkir_total      = ongkir × CEIL(weight_estimation)
 * (Both RHS use the OLD row value, so they stay consistent.)
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/fix-shipment-ongkir-roundup.ts [--dry-run]
 */

import postgres from "postgres"

const dryRun = process.argv.includes("--dry-run")

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: "require", prepare: false })

async function main() {
  const [before] = await sql<{ n: number; cur_sum: string; ceil_sum: string }[]>`
    SELECT count(*)::int AS n,
           COALESCE(SUM(ongkir_total), 0)::bigint AS cur_sum,
           COALESCE(SUM((ongkir * CEIL(weight_estimation))::int), 0)::bigint AS ceil_sum
    FROM shipments
    WHERE weight_estimation <> CEIL(weight_estimation)
       OR ongkir_total <> ongkir * CEIL(weight_estimation)
  `
  const rp = (v: string | number) => "Rp " + Number(v).toLocaleString("id-ID")
  console.log(`Shipments to fix: ${before.n}`)
  console.log(`  ongkir_total sum: ${rp(before.cur_sum)} → ${rp(before.ceil_sum)}`)

  if (dryRun) {
    console.log("[DRY RUN] no changes written.")
    await sql.end()
    return
  }

  const result = await sql`
    UPDATE shipments
    SET weight_estimation = CEIL(weight_estimation),
        ongkir_total      = (ongkir * CEIL(weight_estimation))::int,
        updated_at        = NOW()
    WHERE weight_estimation <> CEIL(weight_estimation)
       OR ongkir_total <> ongkir * CEIL(weight_estimation)
  `
  console.log(`✓ Updated ${result.count} shipment rows (weight rounded up to next kg, ongkir recomputed).`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Fix failed:", err)
  await sql.end()
  process.exit(1)
})
