/**
 * READ-ONLY audit for the customer-handle cleanup.
 *
 * Goal: before we canonicalize `customers.instagram_id` to bare lowercase
 * (strip "@", lowercase) and merge duplicates, find out:
 *   1. How many handles are not already in canonical (bare lowercase) form.
 *   2. Which handles collide once normalized (e.g. "8_davinas" + "@8_davinas")
 *      — these rows must be MERGED because instagram_id is UNIQUE.
 *   3. For each collision group, the contact/bank fields + child-row references,
 *      and a ⚠ flag when two rows hold CONFLICTING non-empty values (the only
 *      cases that need a human decision before merging).
 *
 * This script only runs SELECTs. It writes nothing.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/audit-customer-handles.ts
 */

import postgres from "postgres"

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set (try: node --env-file=.env.local --import=tsx ...)")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, {
  max: 4,
  ssl: "require",
  prepare: false,
  connection: { statement_timeout: 30000 },
})

const norm = (s: string) => (s ?? "").trim().replace(/^@/, "").toLowerCase()

type CustomerRow = {
  id: number
  instagram_id: string
  whatsapp: string
  data_diri: string
  ekspedisi: string
  ongkos_kirim: number
  bank_name: string
  bank_account_number: string
  bank_account_holder: string
  created_at: Date | null
  updated_at: Date | null
}

const CHILD_TABLES = ["orders", "payments", "shipments", "adjustments", "refunds"] as const
type ChildTable = (typeof CHILD_TABLES)[number]

async function main() {
  // ── 1. Overall churn: rows whose stored handle isn't already bare-lowercase ──
  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM customers
    WHERE instagram_id NOT LIKE '\\_old%' AND instagram_id <> 'gantialamat'
  `
  const [{ not_canonical }] = await sql<{ not_canonical: number }[]>`
    SELECT count(*)::int AS not_canonical FROM customers
    WHERE instagram_id NOT LIKE '\\_old%' AND instagram_id <> 'gantialamat'
      AND instagram_id <> lower(replace(instagram_id, '@', ''))
  `

  // ── 2. Collision groups (>1 row sharing a normalized key) ──────────────────
  const collisionRows = await sql<CustomerRow[]>`
    WITH keys AS (
      SELECT lower(replace(instagram_id, '@', '')) AS k
      FROM customers
      WHERE instagram_id NOT LIKE '\\_old%' AND instagram_id <> 'gantialamat'
      GROUP BY 1
      HAVING count(*) > 1
    )
    SELECT c.id, c.instagram_id, c.whatsapp, c.data_diri, c.ekspedisi,
           c.ongkos_kirim, c.bank_name, c.bank_account_number,
           c.bank_account_holder, c.created_at, c.updated_at
    FROM customers c
    JOIN keys ON keys.k = lower(replace(c.instagram_id, '@', ''))
    ORDER BY lower(replace(c.instagram_id, '@', '')), c.id
  `

  // ── 3. Child-row reference counts for every handle in a collision group ─────
  const involvedIds = [...new Set(collisionRows.map((r) => r.instagram_id))]
  const refCounts = new Map<string, Record<ChildTable, number>>()
  for (const id of involvedIds) {
    refCounts.set(id, { orders: 0, payments: 0, shipments: 0, adjustments: 0, refunds: 0 })
  }
  if (involvedIds.length > 0) {
    for (const tbl of CHILD_TABLES) {
      const counts = await sql<{ customer: string; n: number }[]>`
        SELECT customer, count(*)::int AS n
        FROM ${sql(tbl)}
        WHERE customer = ANY(${involvedIds})
        GROUP BY customer
      `
      for (const c of counts) {
        const rec = refCounts.get(c.customer)
        if (rec) rec[tbl] = c.n
      }
    }
  }

  // ── 4. Group, detect field conflicts, suggest survivor ─────────────────────
  const groups = new Map<string, CustomerRow[]>()
  for (const r of collisionRows) {
    const k = norm(r.instagram_id)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }

  const STR_FIELDS: (keyof CustomerRow)[] = [
    "whatsapp", "data_diri", "ekspedisi",
    "bank_name", "bank_account_number", "bank_account_holder",
  ]

  const ts = (d: Date | null) => (d ? new Date(d).getTime() : 0)
  const survivorOf = (rows: CustomerRow[]) =>
    [...rows].sort((a, b) =>
      ts(b.updated_at) - ts(a.updated_at) ||
      ts(b.created_at) - ts(a.created_at) ||
      b.id - a.id,
    )[0]

  function conflicts(rows: CustomerRow[]): string[] {
    const out: string[] = []
    for (const f of STR_FIELDS) {
      const vals = new Set(rows.map((r) => String(r[f] ?? "").trim()).filter(Boolean))
      if (vals.size > 1) out.push(f)
    }
    const ongkir = new Set(rows.map((r) => r.ongkos_kirim).filter((n) => n > 0))
    if (ongkir.size > 1) out.push("ongkos_kirim")
    return out
  }

  // ── 5. Report ──────────────────────────────────────────────────────────────
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const conflictGroups = sortedGroups.filter(([, rows]) => conflicts(rows).length > 0)
  const rowsMergedAway = collisionRows.length - groups.size

  console.log("══════════════════════════════════════════════════════════════")
  console.log("  CUSTOMER HANDLE CLEANUP — READ-ONLY AUDIT")
  console.log("══════════════════════════════════════════════════════════════")
  console.log(`Customers (excl. sentinels):     ${total}`)
  console.log(`Not yet bare-lowercase:          ${not_canonical}  (would be rewritten)`)
  console.log(`Collision groups (need merge):   ${groups.size}`)
  console.log(`Rows merged away by dedup:       ${rowsMergedAway}`)
  console.log(`⚠ Groups w/ conflicting fields:  ${conflictGroups.length}  (need a human decision)`)
  console.log("")

  if (sortedGroups.length === 0) {
    console.log("No collisions — cleanup would be a pure rewrite, no merges needed.")
  }

  const fmtRefs = (id: string) => {
    const r = refCounts.get(id)!
    return CHILD_TABLES.map((t) => `${t.slice(0, 3)}=${r[t]}`).join(" ")
  }
  const short = (s: string, n = 14) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

  for (const [k, rows] of sortedGroups) {
    const conf = conflicts(rows)
    const survivor = survivorOf(rows)
    console.log(`── ${k}  (${rows.length} rows)${conf.length ? "  ⚠ CONFLICT: " + conf.join(", ") : ""}`)
    for (const r of rows) {
      const flag = r.id === survivor.id ? "★" : " "
      const bank = [r.bank_name, r.bank_account_number, r.bank_account_holder]
        .map((x) => (x ?? "").trim()).filter(Boolean).join("/")
      console.log(
        `  ${flag} id=${String(r.id).padStart(5)} "${r.instagram_id}"`.padEnd(34) +
        ` wa=${short(r.whatsapp || "-")}`.padEnd(20) +
        ` ongkir=${r.ongkos_kirim}`.padEnd(14) +
        ` bank=${short(bank || "-", 20)}`.padEnd(26) +
        ` [${fmtRefs(r.instagram_id)}]`,
      )
    }
    console.log("")
  }

  console.log("Legend: ★ = suggested survivor (most recently updated). refs: ord/pay/shi/adj/ref counts.")
  console.log("Only ⚠ CONFLICT groups need a manual call; the rest merge by 'fill empty fields from the survivor'.")

  await sql.end()
}

main().catch(async (err) => {
  console.error("Audit failed:", err)
  await sql.end()
  process.exit(1)
})
