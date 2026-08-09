/**
 * DRY-RUN for migration 021_normalize_customer_handles.sql.
 *
 * Runs the migration body inside a transaction, prints before/after checks,
 * then ROLLS BACK — nothing is persisted. Validates that the SQL executes,
 * hits no FK violations, and actually removes all duplicates.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/dryrun-normalize-handles.ts
 */

import postgres from "postgres"
import { readFileSync } from "fs"

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 2,
  ssl: "require",
  prepare: false,
  connection: { statement_timeout: 0 },
})

// Migration body minus its own BEGIN/COMMIT (we wrap it ourselves to force rollback).
const body = readFileSync("supabase/migrations/021_normalize_customer_handles.sql", "utf8")
  .replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, "")

class Rollback extends Error {}

async function main() {
  try {
    await sql.begin(async (tx) => {
      const dupGroups = async () =>
        (await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM (
            SELECT lower(replace(instagram_id,'@','')) k FROM customers
            WHERE instagram_id NOT LIKE '\_old%' AND instagram_id <> 'gantialamat'
            GROUP BY 1 HAVING count(*) > 1
          ) x`)[0].n
      const nonBare = async () =>
        (await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM customers
          WHERE instagram_id NOT LIKE '\_old%' AND instagram_id <> 'gantialamat'
            AND instagram_id <> lower(replace(instagram_id,'@',''))`)[0].n
      const totalCust = async () =>
        (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM customers`)[0].n

      const dupBefore = await dupGroups()
      const nonBareBefore = await nonBare()
      const totalBefore = await totalCust()
      console.log("BEFORE:  customers=%d  dupGroups=%d  nonBare=%d", totalBefore, dupBefore, nonBareBefore)

      console.log("Running migration body…")
      await tx.unsafe(body).simple()

      const dupAfter = await dupGroups()
      const nonBareAfter = await nonBare()
      const totalAfter = await totalCust()

      const [orph] = await tx<{
        orders: number; payments: number; shipments: number; adjustments: number; refunds: number
      }[]>`
        SELECT
          (SELECT count(*)::int FROM orders o      LEFT JOIN customers c ON c.instagram_id=o.customer WHERE c.id IS NULL) AS orders,
          (SELECT count(*)::int FROM payments p    LEFT JOIN customers c ON c.instagram_id=p.customer WHERE c.id IS NULL) AS payments,
          (SELECT count(*)::int FROM shipments s   LEFT JOIN customers c ON c.instagram_id=s.customer WHERE c.id IS NULL) AS shipments,
          (SELECT count(*)::int FROM adjustments a LEFT JOIN customers c ON c.instagram_id=a.customer WHERE c.id IS NULL) AS adjustments,
          (SELECT count(*)::int FROM refunds r     LEFT JOIN customers c ON c.instagram_id=r.customer WHERE c.id IS NULL) AS refunds`

      console.log("AFTER:   customers=%d  dupGroups=%d  nonBare=%d", totalAfter, dupAfter, nonBareAfter)
      console.log("Removed: %d customer rows", totalBefore - totalAfter)
      console.log("Orphan child rows (must all be 0):", orph)

      const ok = dupAfter === 0 && nonBareAfter === 0 &&
        orph.orders === 0 && orph.payments === 0 && orph.shipments === 0 &&
        orph.adjustments === 0 && orph.refunds === 0
      console.log(ok ? "\n✅ DRY-RUN PASSED — rolling back." : "\n❌ CHECKS FAILED — rolling back.")

      throw new Rollback() // force rollback no matter what
    })
  } catch (err) {
    if (!(err instanceof Rollback)) {
      console.error("\n❌ Migration body errored (rolled back):", err)
      await sql.end()
      process.exit(1)
    }
  }
  await sql.end()
}

main()
