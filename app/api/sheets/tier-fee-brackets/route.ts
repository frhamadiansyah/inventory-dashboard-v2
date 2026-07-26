import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getTierFeeBrackets, replaceTierFeeBrackets, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"
import { toTierFeeMode, type TierFeeMode } from "@/lib/tier-fee"

const CACHE_KEY = "tier-fee-brackets"

// min_base is INTEGER and fee_value NUMERIC(12,2) — reject here rather than let
// Postgres raise an overflow 500 from inside the write transaction.
const MAX_MIN_BASE = 2_000_000_000
const MAX_FIXED = 9_999_999_999.99
// A profit above 1000% of cost is a typo, not a margin. Nothing in the schema
// enforces it; this is purely a guard against a slipped decimal point.
const MAX_PERCENT = 1000
const MAX_TIERS = 20

type Bracket = { minBase: number; feeMode: TierFeeMode; feeValue: number }

/**
 * Written as one whole set, not row by row: the set has a cross-row invariant (no
 * two brackets may share a floor) that only an atomic whole-set write can validate,
 * and the editor is a free-form add/remove list rather than a table of persisted
 * rows. Same shape as /api/sheets/kurs-tiers.
 */
function readBody(
  body: Record<string, unknown>,
): { countryId: number | null; brackets: Bracket[] } | string {
  // null is the rupiah scope, a number is that country's valas scope. `undefined`
  // would be ambiguous between the two, so it is rejected rather than defaulted.
  let countryId: number | null
  if (body.countryId === null) {
    countryId = null
  } else if (typeof body.countryId === "number" || typeof body.countryId === "string") {
    countryId = Number(body.countryId)
    if (!Number.isInteger(countryId) || countryId < 1) return "Invalid countryId"
  } else {
    return "countryId is required (null for the Rupiah brackets)"
  }

  if (!Array.isArray(body.brackets)) return "brackets must be an array"
  if (body.brackets.length > MAX_TIERS) return `At most ${MAX_TIERS} brackets`

  const brackets: Bracket[] = []
  const seen = new Set<number>()

  for (const [i, raw] of body.brackets.entries()) {
    const where = `Bracket ${i + 1}`
    if (!raw || typeof raw !== "object") return `${where}: not an object`
    const t = raw as Record<string, unknown>

    // Fractional floors are allowed now: a valas floor legitimately can be, where a
    // rupiah one cannot. NUMERIC(14,2) is the column, so round to 2dp below.
    const minBase = Number(t.minBase)
    if (!Number.isFinite(minBase) || minBase < 0 || minBase > MAX_MIN_BASE) {
      return `${where}: "from" must be between 0 and ${MAX_MIN_BASE}`
    }
    // An unknown mode narrows to "fixed" rather than erroring — but only because
    // the two legal values are the only ones the editor can produce.
    const feeMode = toTierFeeMode(t.feeMode)
    const feeValue = Number(t.feeValue)
    const max = feeMode === "percent" ? MAX_PERCENT : MAX_FIXED
    if (!Number.isFinite(feeValue) || feeValue < 0 || feeValue > max) {
      return `${where}: profit must be between 0 and ${max}`
    }

    // Round to the column scale BEFORE the duplicate check, so the stored value
    // round-trips exactly and the client's next resolve can't disagree with the
    // server's over a rounding step Postgres applied silently.
    const value = Math.round(feeValue * 100) / 100
    const min = Math.round(minBase * 100) / 100
    if (seen.has(min)) return `${where}: another bracket already starts at ${min}`
    seen.add(min)
    brackets.push({ minBase: min, feeMode, feeValue: value })
  }

  // The resolver picks the highest matching minimum, so order is irrelevant to the
  // math — sort only so the stored rows read top-to-bottom like the editor does.
  brackets.sort((a, b) => a.minBase - b.minBase)
  return { countryId, brackets }
}

/**
 * Owner-only. A bracket row IS the Tier Fee margin structure, so it gets the same
 * gate as /api/sheets/kurs-tiers rather than the looser requireRole — and both
 * consumers (/dashboard/settings, /dashboard/products) are already owner-only, so
 * nothing is lost.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const brackets = await cached(CACHE_KEY, getTierFeeBrackets)
    return NextResponse.json({ brackets }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch Tier Fee brackets:", err)
    return NextResponse.json({ error: "Failed to fetch Tier Fee brackets" }, { status: 500 })
  }
}

/** Replace one scope's whole set. `brackets: []` clears that scope — a legitimate
 *  state ("suggest nothing" for rupiah, "price at cost" for a country) — so there is
 *  no separate DELETE. */
export async function PUT(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const parsed = readBody(await req.json())
    if (typeof parsed === "string") {
      return NextResponse.json({ error: parsed }, { status: 400 })
    }

    await withActor(session.user.email, (tx) =>
      replaceTierFeeBrackets(parsed.countryId, parsed.brackets, tx),
    )
    // Enough on its own. The rupiah scope only pre-fills a form field, and the valas
    // scope is re-read uncached inside the write transaction, so no stored price
    // depends on this cache being fresh.
    invalidate(CACHE_KEY)
    return NextResponse.json({ success: true, count: parsed.brackets.length })
  } catch (err) {
    console.error("Failed to save Tier Fee brackets:", err)
    return NextResponse.json({ error: "Failed to save Tier Fee brackets" }, { status: 500 })
  }
}
