import { NextRequest, NextResponse } from "next/server"
import { getPublicInvoiceForCustomer } from "@/lib/db"
import type { PublicInvoiceResult } from "@/lib/db/types"
import { normalizeId } from "@/lib/db/helpers"
import publicSql from "@/lib/db-public"

// Public, no-login endpoint for the customer-facing recap site
// (yubisayu-invoice.netlify.app). Returns ONLY orders + payment status via the
// read-only `invoice_reader` connection — no name, WhatsApp, address, or bank
// data. Not matched by middleware (which only guards /dashboard), so it is
// intentionally reachable without a session.

const ALLOWED_ORIGIN = "https://yubisayu-invoice.netlify.app"

// Each recap fans out to 4 DB queries, and the public site triggers a refresh
// storm during an event (customers re-checking their orders). The payload is
// tiny per request but uncached it means 4 queries × every view = real egress
// + sequential scans. Cache by handle so repeat lookups (across ALL users on
// this long-lived Railway process) are served from memory.
//
// A 60s TTL keeps payment-status staleness imperceptible on a recap page.
// Empty results are cached too, so typos/bots scanning handles can't hammer
// the DB. Browsers also get `max-age=60` so a single user's refreshes never
// even reach Railway.
const CACHE_TTL_MS = 60_000
// Bound memory: an event can surface thousands of distinct handles. Past this
// we drop the whole map (cheap, self-heals within one TTL) rather than track
// per-entry LRU.
const CACHE_MAX_ENTRIES = 5000

type CacheEntry = { data: PublicInvoiceResult; expires: number }
const cache = new Map<string, CacheEntry>()

async function getCachedInvoice(handle: string): Promise<PublicInvoiceResult> {
  const key = normalizeId(handle)
  const now = Date.now()

  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.data

  const data = await getPublicInvoiceForCustomer(handle, publicSql)
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear()
  cache.set(key, { data, expires: now + CACHE_TTL_MS })
  return data
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = req.nextUrl.searchParams.get("customer")?.trim()
  if (!customer) {
    return NextResponse.json(
      { error: "customer is required" },
      { status: 400, headers: corsHeaders() },
    )
  }

  try {
    const data = await getCachedInvoice(customer)
    return NextResponse.json(data, {
      headers: {
        ...corsHeaders(),
        // Browser caches each handle's recap for 60s (matches the server TTL),
        // serving the user's own refreshes locally; stale-while-revalidate
        // smooths the boundary. Cross-user dedup happens in the in-memory cache.
        "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
      },
    })
  } catch (err) {
    console.error("Failed to load public invoice:", err)
    return NextResponse.json(
      { error: "Failed to load invoice" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
