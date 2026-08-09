import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getPaymentStatus, type PaymentStatusRow } from "@/lib/db"

// Payment status is global business data — the same for every admin — and it
// rarely changes second-to-second. But the invoice panel refetches the whole
// all-events matrix on every mount with `cache: no-store`, and during an event
// admins reopen/refresh the invoice page constantly. Each visit re-ran the full
// orders+payments+adjustments aggregation and shipped the identical result back
// over the Supabase pooler — repeated, billed egress for data that didn't move.
//
// A tiny in-memory TTL cache (this runs on one long-lived Railway process)
// collapses those repeat loads to one query per TTL, shared across all admins.
// Keyed by event so the all-events call and any per-event call cache
// independently. 15s keeps staleness imperceptible after recording a payment
// while still absorbing a refresh storm.
const CACHE_TTL_MS = 15_000

type CacheEntry = { rows: PaymentStatusRow[]; expires: number }
const cache = new Map<string, CacheEntry>()

async function getCachedStatus(event: string | undefined): Promise<PaymentStatusRow[]> {
  const key = event ?? "__all__"
  const now = Date.now()

  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.rows

  const rows = await getPaymentStatus(event)
  cache.set(key, { rows, expires: now + CACHE_TTL_MS })
  return rows
}

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  // No `event` param → payment status across all events.
  const event = req.nextUrl.searchParams.get("event")?.trim()

  try {
    const rows = await getCachedStatus(event || undefined)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load payment status:", err)
    return NextResponse.json({ error: "Failed to load payment status" }, { status: 500 })
  }
}
