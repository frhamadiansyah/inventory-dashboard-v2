export function fmt(n: number): string {
  return n.toLocaleString("id-ID")
}

export function fmtNullable(n: number | null | undefined, fallback = "—"): string {
  return n == null ? fallback : fmt(n)
}

/**
 * Strips a leading "@" from an Instagram handle so it can be displayed
 * without the prefix. Storage and lookups keep the original value via
 * normalizeId() — this is display-only.
 */
export function displayIg(id: string | null | undefined): string {
  return (id ?? "").replace(/^@/, "")
}
