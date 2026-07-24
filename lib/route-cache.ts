// Tiny in-memory TTL cache for reference-data GET routes.
//
// The app runs as a single long-lived process, so a module-level Map is shared
// across every request. Reference data — events, countries, warehouses, product
// defaults, message templates, business profile — barely changes, yet every
// dashboard page refetched it with `no-store`. That shipped the identical rows
// back over the Supabase pooler on each navigation: repeated, billed egress for
// near-static data.
//
// This collapses repeat loads to one query per TTL. Mutating routes call
// `invalidate(key)` after a successful write so edits appear immediately; the
// TTL is only a safety net for changes made through paths that don't invalidate
// (e.g. another admin's session, or an indirect mutation).
//
// Same pattern as the payment-status route cache, generalised.

type Entry<T> = { value: T; expires: number }

const store = new Map<string, Entry<unknown>>()

const DEFAULT_TTL_MS = 60_000

export async function cached<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && hit.expires > now) return hit.value

  const value = await load()
  store.set(key, { value, expires: now + ttlMs })
  return value
}

export function invalidate(key: string): void {
  store.delete(key)
}
