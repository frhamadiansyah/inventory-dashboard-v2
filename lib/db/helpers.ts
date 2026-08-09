// Shared pure helpers used across the db/* modules.

/**
 * Canonical customer-handle form: trimmed, bare (no leading "@"), lowercase.
 * The single normalizer for both reads (matching) and writes (storage);
 * `normalizeCustomer` is an alias kept for write-side call sites.
 */
export function normalizeId(id: string | null | undefined): string {
  return String(id ?? "").trim().replace(/^@+/, "").toLowerCase()
}

function formatTimestamp(d: Date = new Date()): string {
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function tsToString(v: Date | null | undefined): string {
  if (!v) return ""
  return formatTimestamp(v)
}

/** Normalize customer handle to the canonical form: bare lowercase, no "@". */
export function normalizeCustomer(raw: string): string {
  return normalizeId(raw)
}
