import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getKursTiers, replaceKursTiers, withActor } from "@/lib/db"
import { cached, invalidate } from "@/lib/route-cache"

const CACHE_KEY = "kurs-tiers"

// NUMERIC(12,2) and NUMERIC(12,4) ceilings — reject here rather than let Postgres
// raise a numeric-overflow 500 from inside the write transaction.
const MAX_MIN_VALAS = 9_999_999_999.99
const MAX_KURS = 99_999_999.9999
const MAX_BANDS = 20

type Band = { minValas: number; kurs: number }

/**
 * Brackets are written a whole country-set at a time, not row by row: the set has
 * a cross-row invariant (no two bands may share a floor) that only an atomic
 * whole-set write can validate, and the editor is a free-form add/remove list
 * rather than a table of persisted rows.
 */
function readBody(
  body: Record<string, unknown>,
): { countryId: number; bands: Band[]; flatKurs: number } | string {
  const countryId = Number(body.countryId)
  if (!Number.isInteger(countryId) || countryId < 1) return "Invalid countryId"
  if (!Array.isArray(body.bands)) return "bands must be an array"
  if (body.bands.length > MAX_BANDS) return `At most ${MAX_BANDS} brackets per country`

  // The one flat rate charged to Flat Rate products (migration 053). 0 is legal and means
  // "not configured", which is why this is not rejected for being zero the way a bracket's
  // rate is: a bracket that exists must charge something, but the absence of a flat rate is
  // exactly how a country opts out of the method.
  const flatKurs = Number(body.flatKurs ?? 0)
  if (!Number.isFinite(flatKurs) || flatKurs < 0 || flatKurs > MAX_KURS) {
    return `Flat rate must be between 0 and ${MAX_KURS}`
  }

  const bands: Band[] = []
  const seen = new Set<number>()

  for (const [i, raw] of body.bands.entries()) {
    const where = `Bracket ${i + 1}`
    if (!raw || typeof raw !== "object") return `${where}: not an object`
    const b = raw as Record<string, unknown>

    const minValas = Number(b.minValas)
    const kurs = Number(b.kurs)
    if (!Number.isFinite(minValas) || minValas < 0 || minValas > MAX_MIN_VALAS) {
      return `${where}: "from" must be between 0 and ${MAX_MIN_VALAS}`
    }
    if (!Number.isFinite(kurs) || kurs <= 0 || kurs > MAX_KURS) {
      return `${where}: rate must be above 0 and at most ${MAX_KURS}`
    }

    // Round to the column scale BEFORE the duplicate check, so the stored value
    // round-trips exactly and the client's next resolve can't disagree with the
    // server's over a rounding step Postgres applied silently.
    const min = Math.round(minValas * 100) / 100
    const rate = Math.round(kurs * 10_000) / 10_000
    if (seen.has(min)) return `${where}: another bracket already starts at ${min}`
    seen.add(min)
    bands.push({ minValas: min, kurs: rate })
  }

  // The resolver picks the highest matching minimum, so order is irrelevant to the
  // math — sort only so the stored rows read top-to-bottom like the editor does.
  bands.sort((a, b) => a.minValas - b.minValas)
  // Rounded to the column scale for the same reason each bracket's rate is: so the stored
  // value round-trips exactly and the client's next resolve cannot disagree with the
  // server's over a rounding step Postgres applied silently.
  return { countryId, bands, flatKurs: Math.round(flatKurs * 10_000) / 10_000 }
}

/**
 * Owner-only, not requireRole. A bracket row IS the margin structure:
 * chargedKurs / countries.kurs − 1 is the markup being charged. Both consumers of
 * this endpoint (/dashboard/settings and /dashboard/products) are already
 * owner-only — settings via its absence from ADMIN_ROUTES in lib/access.ts,
 * products via its own requireOwner — so nothing is lost by the tighter gate.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const tiers = await cached(CACHE_KEY, getKursTiers)
    return NextResponse.json({ tiers }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch kurs tiers:", err)
    return NextResponse.json({ error: "Failed to fetch kurs tiers" }, { status: 500 })
  }
}

/** Replace one country's whole bracket set. `bands: []` clears it, so there is no
 *  separate DELETE. */
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
      replaceKursTiers(parsed.countryId, parsed.bands, parsed.flatKurs, tx),
    )
    // Enough on its own: no product reprices until it is next saved, and the
    // server resolves brackets uncached inside the write transaction.
    invalidate(CACHE_KEY)
    return NextResponse.json({ success: true, count: parsed.bands.length })
  } catch (err) {
    if (err instanceof Error && /foreign key/i.test(err.message)) {
      return NextResponse.json({ error: "Unknown country" }, { status: 400 })
    }
    console.error("Failed to save kurs tiers:", err)
    return NextResponse.json({ error: "Failed to save kurs tiers" }, { status: 500 })
  }
}
